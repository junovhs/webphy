//! Image and memory allocation for DMA-BUF export.

use crate::error::{PalResult, VulkanError};
use ash::vk;
use std::os::unix::io::{FromRawFd, OwnedFd};

/// Creates an image with exportable external memory.
pub fn create_exportable_image(
    instance: &ash::Instance,
    device: &ash::Device,
    physical: vk::PhysicalDevice,
    extent: vk::Extent2D,
    format: vk::Format,
) -> PalResult<(vk::Image, vk::DeviceMemory)> {
    let mut external_info = vk::ExternalMemoryImageCreateInfo::default()
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
        .push_next(&mut external_info);

    // SAFETY: All parameters are valid, pNext chain is properly formed.
    let image = unsafe { device.create_image(&image_info, None) }
        .map_err(VulkanError::Api)?;

    // SAFETY: Image handle is valid.
    let mem_reqs = unsafe { device.get_image_memory_requirements(image) };
    let mem_type = find_exportable_memory_type(instance, physical, &mem_reqs)?;

    let mut export_info = vk::ExportMemoryAllocateInfo::default()
        .handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);

    let alloc_info = vk::MemoryAllocateInfo::default()
        .allocation_size(mem_reqs.size)
        .memory_type_index(mem_type)
        .push_next(&mut export_info);

    // SAFETY: Allocation info is valid with proper pNext chain.
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

/// Exports device memory as a DMA-BUF file descriptor.
pub fn export_memory_fd(
    instance: &ash::Instance,
    device: &ash::Device,
    memory: vk::DeviceMemory,
) -> PalResult<OwnedFd> {
    let fd_info = vk::MemoryGetFdInfoKHR::default()
        .memory(memory)
        .handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);

    let loader = ash::khr::external_memory_fd::Device::new(instance, device);

    // SAFETY: Memory is valid, handle type matches allocation.
    let raw_fd = unsafe { loader.get_memory_fd(&fd_info) }
        .map_err(|e| VulkanError::ExternalMemory(format!("get_memory_fd: {e}")))?;

    // SAFETY: Vulkan just gave us ownership of this fd.
    Ok(unsafe { OwnedFd::from_raw_fd(raw_fd) })
}