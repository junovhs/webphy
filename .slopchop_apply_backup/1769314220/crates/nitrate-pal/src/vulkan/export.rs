//! DMA-BUF export functionality.
//!
//! Allocates VkImage with exportable memory and exports as DMA-BUF fd.
//! This simulates what a video decoder would produce.

#![cfg(target_os = "linux")]

use crate::error::{PalError, PalResult, VulkanError};
use ash::vk;
use std::os::unix::io::{OwnedFd, RawFd};
use tracing::debug;

/// An image with exportable memory that can be shared via DMA-BUF.
pub struct ExportedImage {
    image: vk::Image,
    memory: vk::DeviceMemory,
    fd: OwnedFd,
    pub extent: vk::Extent2D,
    pub format: vk::Format,
    device: ash::Device,
}

impl ExportedImage {
    /// Creates an exportable image and fills it with a test pattern.
    pub fn new_checkerboard(
        instance: &ash::Instance,
        device: &ash::Device,
        physical: vk::PhysicalDevice,
        queue: vk::Queue,
        family_index: u32,
        width: u32,
        height: u32,
    ) -> PalResult<Self> {
        let extent = vk::Extent2D { width, height };
        let format = vk::Format::R8G8B8A8_UNORM;

        let (image, memory) = create_exportable_image(
            instance, device, physical, extent, format,
        )?;

        fill_checkerboard(device, queue, family_index, image, extent)?;

        let fd = export_memory_fd(device, memory)?;

        debug!(
            "Exported image {}x{} as fd {}",
            width, height, fd.as_raw_fd()
        );

        Ok(Self {
            image,
            memory,
            fd,
            extent,
            format,
            device: device.clone(),
        })
    }

    /// Returns the raw fd for import. Does not transfer ownership.
    pub fn raw_fd(&self) -> RawFd {
        use std::os::unix::io::AsRawFd;
        self.fd.as_raw_fd()
    }

    /// Duplicates the fd for import (transfers ownership of the dup).
    pub fn dup_fd(&self) -> PalResult<OwnedFd> {
        use std::os::unix::io::AsFd;
        self.fd
            .try_clone()
            .map_err(|e| PalError::Export(format!("fd dup failed: {e}")))
    }
}

impl Drop for ExportedImage {
    fn drop(&mut self) {
        // SAFETY: We own these resources and destroy in correct order.
        unsafe {
            self.device.destroy_image(self.image, None);
            self.device.free_memory(self.memory, None);
        }
        debug!("ExportedImage destroyed");
    }
}

fn create_exportable_image(
    instance: &ash::Instance,
    device: &ash::Device,
    physical: vk::PhysicalDevice,
    extent: vk::Extent2D,
    format: vk::Format,
) -> PalResult<(vk::Image, vk::DeviceMemory)> {
    let external_info = vk::ExternalMemoryImageCreateInfo::default()
        .handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);

    let image_info = vk::ImageCreateInfo::default()
        .image_type(vk::ImageType::TYPE_2D)
        .format(format)
        .extent(vk::Extent3D {
            width: extent.width,
            height: extent.height,
            depth: 1,
        })
        .mip_levels(1)
        .array_layers(1)
        .samples(vk::SampleCountFlags::TYPE_1)
        .tiling(vk::ImageTiling::LINEAR)
        .usage(vk::ImageUsageFlags::TRANSFER_DST | vk::ImageUsageFlags::SAMPLED)
        .sharing_mode(vk::SharingMode::EXCLUSIVE)
        .push_next(&mut external_info.clone());

    // SAFETY: All parameters are valid.
    let image = unsafe { device.create_image(&image_info, None) }
        .map_err(VulkanError::Api)?;

    let mem_reqs = unsafe { device.get_image_memory_requirements(image) };
    let mem_type = find_exportable_memory_type(instance, physical, &mem_reqs)?;

    let export_info = vk::ExportMemoryAllocateInfo::default()
        .handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);

    let alloc_info = vk::MemoryAllocateInfo::default()
        .allocation_size(mem_reqs.size)
        .memory_type_index(mem_type)
        .push_next(&mut export_info.clone());

    // SAFETY: Allocation info is valid.
    let memory = unsafe { device.allocate_memory(&alloc_info, None) }
        .map_err(VulkanError::Api)?;

    // SAFETY: Image and memory are valid, offset 0 is correct for dedicated alloc.
    unsafe { device.bind_image_memory(image, memory, 0) }
        .map_err(VulkanError::Api)?;

    Ok((image, memory))
}

fn find_exportable_memory_type(
    instance: &ash::Instance,
    physical: vk::PhysicalDevice,
    reqs: &vk::MemoryRequirements,
) -> PalResult<u32> {
    // SAFETY: Physical device is valid.
    let props = unsafe { instance.get_physical_device_memory_properties(physical) };

    let required = vk::MemoryPropertyFlags::HOST_VISIBLE
        | vk::MemoryPropertyFlags::HOST_COHERENT;

    for i in 0..props.memory_type_count {
        let type_bit = 1 << i;
        if (reqs.memory_type_bits & type_bit) == 0 {
            continue;
        }

        let mem_type = props.memory_types[i as usize];
        if mem_type.property_flags.contains(required) {
            return Ok(i);
        }
    }

    Err(VulkanError::MemoryAllocation("No exportable memory type".into()).into())
}

fn export_memory_fd(device: &ash::Device, memory: vk::DeviceMemory) -> PalResult<OwnedFd> {
    let fd_info = vk::MemoryGetFdInfoKHR::default()
        .memory(memory)
        .handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);

    let loader = ash::khr::external_memory_fd::Device::new_from_handle(device.handle());

    // SAFETY: Memory is valid, handle type matches allocation.
    let raw_fd = unsafe { loader.get_memory_fd(&fd_info) }
        .map_err(|e| VulkanError::ExternalMemory(format!("get_memory_fd: {e}")))?;

    // SAFETY: Vulkan just gave us ownership of this fd.
    Ok(unsafe { OwnedFd::from_raw_fd(raw_fd) })
}

fn fill_checkerboard(
    device: &ash::Device,
    queue: vk::Queue,
    family_index: u32,
    image: vk::Image,
    extent: vk::Extent2D,
) -> PalResult<()> {
    let pool_info = vk::CommandPoolCreateInfo::default()
        .queue_family_index(family_index)
        .flags(vk::CommandPoolCreateFlags::TRANSIENT);

    // SAFETY: Device is valid.
    let pool = unsafe { device.create_command_pool(&pool_info, None) }
        .map_err(VulkanError::Api)?;

    let result = fill_checkerboard_inner(device, queue, pool, image, extent);

    // SAFETY: Pool is valid.
    unsafe { device.destroy_command_pool(pool, None) };

    result
}

fn fill_checkerboard_inner(
    device: &ash::Device,
    queue: vk::Queue,
    pool: vk::CommandPool,
    image: vk::Image,
    extent: vk::Extent2D,
) -> PalResult<()> {
    let alloc = vk::CommandBufferAllocateInfo::default()
        .command_pool(pool)
        .level(vk::CommandBufferLevel::PRIMARY)
        .command_buffer_count(1);

    // SAFETY: Pool is valid.
    let cmds = unsafe { device.allocate_command_buffers(&alloc) }
        .map_err(VulkanError::Api)?;

    let cmd = cmds.first().copied()
        .ok_or_else(|| PalError::Export("No command buffer".into()))?;

    let subresource = vk::ImageSubresourceRange::default()
        .aspect_mask(vk::ImageAspectFlags::COLOR)
        .level_count(1)
        .layer_count(1);

    // SAFETY: Command buffer is valid.
    unsafe {
        device.begin_command_buffer(
            cmd,
            &vk::CommandBufferBeginInfo::default()
                .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT),
        ).map_err(VulkanError::Api)?;

        // Transition to TRANSFER_DST
        let barrier = vk::ImageMemoryBarrier::default()
            .image(image)
            .old_layout(vk::ImageLayout::UNDEFINED)
            .new_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
            .src_access_mask(vk::AccessFlags::empty())
            .dst_access_mask(vk::AccessFlags::TRANSFER_WRITE)
            .subresource_range(subresource);

        device.cmd_pipeline_barrier(
            cmd,
            vk::PipelineStageFlags::TOP_OF_PIPE,
            vk::PipelineStageFlags::TRANSFER,
            vk::DependencyFlags::empty(),
            &[], &[], &[barrier],
        );

        // Clear to checkerboard pattern via alternating clears
        // (Simplified: just fill with orange for now, real checkerboard needs staging)
        let clear = vk::ClearColorValue {
            float32: [0.878, 0.439, 0.188, 1.0], // #e07030
        };
        device.cmd_clear_color_image(
            cmd,
            image,
            vk::ImageLayout::TRANSFER_DST_OPTIMAL,
            &clear,
            &[subresource],
        );

        // Transition to SHADER_READ_OPTIMAL
        let barrier = vk::ImageMemoryBarrier::default()
            .image(image)
            .old_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
            .new_layout(vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL)
            .src_access_mask(vk::AccessFlags::TRANSFER_WRITE)
            .dst_access_mask(vk::AccessFlags::SHADER_READ)
            .subresource_range(subresource);

        device.cmd_pipeline_barrier(
            cmd,
            vk::PipelineStageFlags::TRANSFER,
            vk::PipelineStageFlags::FRAGMENT_SHADER,
            vk::DependencyFlags::empty(),
            &[], &[], &[barrier],
        );

        device.end_command_buffer(cmd).map_err(VulkanError::Api)?;
    }

    let submit = vk::SubmitInfo::default().command_buffers(&cmds);
    let fence_info = vk::FenceCreateInfo::default();

    // SAFETY: Device and queue are valid.
    unsafe {
        let fence = device.create_fence(&fence_info, None)
            .map_err(VulkanError::Api)?;
        device.queue_submit(queue, &[submit], fence)
            .map_err(VulkanError::Api)?;
        device.wait_for_fences(&[fence], true, u64::MAX)
            .map_err(VulkanError::Api)?;
        device.destroy_fence(fence, None);
    }

    Ok(())
}

use std::os::unix::io::FromRawFd;