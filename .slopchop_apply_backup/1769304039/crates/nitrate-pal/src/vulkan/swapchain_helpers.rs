//! Internal backend logic for Swapchain.
//!
//! This module owns the heavy lifting (creation, state management, synchronization)
//! so the public `Swapchain` struct remains a thin, cohesive facade.

use crate::error::{PalError, PalResult, VulkanError};
use ash::{khr, vk};

/// Configuration bundle to keep function arguments low.
pub struct SwapchainConfig<'a> {
    pub instance: &'a ash::Instance,
    pub device: &'a ash::Device,
    pub physical: vk::PhysicalDevice,
    pub surface_loader: &'a khr::surface::Instance,
    pub surface: vk::SurfaceKHR,
    pub width: u32,
    pub height: u32,
}

pub struct SwapchainSupport {
    pub format: vk::SurfaceFormatKHR,
    pub extent: vk::Extent2D,
    pub image_count: u32,
    pub pre_transform: vk::SurfaceTransformFlagsKHR,
}

/// Synchronization primitives for a single frame.
pub struct FrameSync {
    pub image_available: vk::Semaphore,
    pub render_finished: vk::Semaphore,
    pub in_flight: vk::Fence,
}

/// Result of an acquire operation.
pub struct AcquiredImage {
    pub index: u32,
    pub image: vk::Image,
    pub image_available: vk::Semaphore,
    pub render_finished: vk::Semaphore,
    pub submit_fence: vk::Fence,
}

/// The actual heavy object that manages Vulkan resources.
pub struct SwapchainBackend {
    loader: khr::swapchain::Device,
    handle: vk::SwapchainKHR,
    images: Vec<vk::Image>,
    views: Vec<vk::ImageView>,
    frames: Vec<FrameSync>,
    current_frame: usize,
}

impl SwapchainBackend {
    pub fn new(config: &SwapchainConfig) -> PalResult<(Self, vk::Extent2D)> {
        let support = query_support(config)?;
        let create_info = create_info(config, &support);

        let loader = khr::swapchain::Device::new(config.instance, config.device);

        // SAFETY: device and surface are valid, create_info is configured correctly.
        let handle = unsafe { loader.create_swapchain(&create_info, None) }
            .map_err(VulkanError::Api)?;

        // SAFETY: handle is valid.
        let images = unsafe { loader.get_swapchain_images(handle) }
            .map_err(VulkanError::Api)?;

        let views = create_views(config.device, &images, support.format.format)?;
        let frames = create_sync_objects(config.device, images.len())?;

        let backend = Self {
            loader,
            handle,
            images,
            views,
            frames,
            current_frame: 0,
        };

        Ok((backend, support.extent))
    }

    pub fn acquire_next_image(&mut self, device: &ash::Device) -> PalResult<AcquiredImage> {
        let frame = self.frames.get(self.current_frame)
            .ok_or_else(|| PalError::Swapchain("Frame index out of bounds".into()))?;

        // SAFETY: device and fence are valid.
        unsafe {
            device.wait_for_fences(&[frame.in_flight], true, u64::MAX)
                .map_err(VulkanError::Api)?;
            device.reset_fences(&[frame.in_flight])
                .map_err(VulkanError::Api)?;
        }

        // SAFETY: loader and swapchain handle are valid.
        let (index, _) = unsafe {
            self.loader.acquire_next_image(
                self.handle,
                u64::MAX,
                frame.image_available,
                vk::Fence::null(),
            )
        }
        .map_err(VulkanError::Api)?;

        let image = *self.images.get(index as usize)
            .ok_or_else(|| PalError::Swapchain("Image index out of bounds".into()))?;

        Ok(AcquiredImage {
            index,
            image,
            image_available: frame.image_available,
            render_finished: frame.render_finished,
            submit_fence: frame.in_flight,
        })
    }

    pub fn present(&mut self, queue: vk::Queue, image: &AcquiredImage) -> PalResult<()> {
        let indices = [image.index];
        let wait_semaphores = [image.render_finished];
        let swapchains = [self.handle];

        let present_info = vk::PresentInfoKHR::default()
            .wait_semaphores(&wait_semaphores)
            .swapchains(&swapchains)
            .image_indices(&indices);

        // SAFETY: loader and present_info are valid.
        unsafe {
            self.loader.queue_present(queue, &present_info)
        }
        .map_err(VulkanError::Api)?;

        self.current_frame = (self.current_frame + 1) % self.frames.len();
        Ok(())
    }

    pub fn destroy(&mut self, device: &ash::Device) {
        // SAFETY: device is valid, we own the resources.
        unsafe {
            for view in &self.views {
                device.destroy_image_view(*view, None);
            }
            for frame in &self.frames {
                device.destroy_semaphore(frame.image_available, None);
                device.destroy_semaphore(frame.render_finished, None);
                device.destroy_fence(frame.in_flight, None);
            }
            self.loader.destroy_swapchain(self.handle, None);
        }
    }
}

// --- Helpers ---

fn create_info<'a>(
    config: &'a SwapchainConfig,
    support: &'a SwapchainSupport,
) -> vk::SwapchainCreateInfoKHR<'a> {
    vk::SwapchainCreateInfoKHR::default()
        .surface(config.surface)
        .min_image_count(support.image_count)
        .image_format(support.format.format)
        .image_color_space(support.format.color_space)
        .image_extent(support.extent)
        .image_array_layers(1)
        .image_usage(vk::ImageUsageFlags::COLOR_ATTACHMENT | vk::ImageUsageFlags::TRANSFER_DST)
        .image_sharing_mode(vk::SharingMode::EXCLUSIVE)
        .pre_transform(support.pre_transform)
        .composite_alpha(vk::CompositeAlphaFlagsKHR::OPAQUE)
        .present_mode(vk::PresentModeKHR::FIFO)
        .clipped(true)
}

fn query_support(config: &SwapchainConfig) -> PalResult<SwapchainSupport> {
    // SAFETY: Valid loader and handles.
    let caps = unsafe {
        config.surface_loader
            .get_physical_device_surface_capabilities(config.physical, config.surface)
    }
    .map_err(VulkanError::Api)?;

    // SAFETY: Valid loader and handles.
    let formats = unsafe {
        config.surface_loader
            .get_physical_device_surface_formats(config.physical, config.surface)
    }
    .map_err(VulkanError::Api)?;

    let format = choose_format(&formats)?;
    let extent = clamp_extent(caps, config.width, config.height);
    let image_count = get_image_count(caps);

    Ok(SwapchainSupport {
        format,
        extent,
        image_count,
        pre_transform: caps.current_transform,
    })
}

fn choose_format(formats: &[vk::SurfaceFormatKHR]) -> PalResult<vk::SurfaceFormatKHR> {
    formats.iter()
        .find(|f| f.format == vk::Format::B8G8R8A8_UNORM && f.color_space == vk::ColorSpaceKHR::SRGB_NONLINEAR)
        .or_else(|| formats.first())
        .copied()
        .ok_or_else(|| PalError::Swapchain("No valid surface format".into()))
}

fn clamp_extent(caps: vk::SurfaceCapabilitiesKHR, width: u32, height: u32) -> vk::Extent2D {
    if caps.current_extent.width != u32::MAX {
        return caps.current_extent;
    }
    vk::Extent2D {
        width: width.clamp(caps.min_image_extent.width, caps.max_image_extent.width),
        height: height.clamp(caps.min_image_extent.height, caps.max_image_extent.height),
    }
}

fn get_image_count(caps: vk::SurfaceCapabilitiesKHR) -> u32 {
    let count = caps.min_image_count + 1;
    if caps.max_image_count > 0 {
        count.min(caps.max_image_count)
    } else {
        count
    }
}

fn create_views(device: &ash::Device, images: &[vk::Image], format: vk::Format) -> PalResult<Vec<vk::ImageView>> {
    images.iter().map(|&image| {
        let create_info = vk::ImageViewCreateInfo::default()
            .image(image)
            .view_type(vk::ImageViewType::TYPE_2D)
            .format(format)
            .subresource_range(vk::ImageSubresourceRange::default()
                .aspect_mask(vk::ImageAspectFlags::COLOR)
                .base_mip_level(0)
                .level_count(1)
                .base_array_layer(0)
                .layer_count(1));
        
        // SAFETY: device is valid.
        unsafe { device.create_image_view(&create_info, None) }
            .map_err(VulkanError::Api)
            .map_err(PalError::from)
    }).collect()
}

fn create_sync_objects(device: &ash::Device, count: usize) -> PalResult<Vec<FrameSync>> {
    (0..count).map(|_| {
        let semaphore_info = vk::SemaphoreCreateInfo::default();
        let fence_info = vk::FenceCreateInfo::default().flags(vk::FenceCreateFlags::SIGNALED);

        // SAFETY: device is valid.
        unsafe {
            let image_available = device.create_semaphore(&semaphore_info, None).map_err(VulkanError::Api)?;
            let render_finished = device.create_semaphore(&semaphore_info, None).map_err(VulkanError::Api)?;
            let in_flight = device.create_fence(&fence_info, None).map_err(VulkanError::Api)?;
            Ok(FrameSync { image_available, render_finished, in_flight })
        }
    }).collect()
}