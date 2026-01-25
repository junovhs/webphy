//! The internal implementation of the Swapchain.
//!
//! This module contains all the "heavy" logic: Vulkan object creation,
//! extension loading, and raw resource management.

use super::types::{AcquiredImage, FrameSync, SwapchainConfig};
use crate::error::{PalError, PalResult, VulkanError};
use ash::{khr, vk};
use tracing::debug;

/// The heavy-weight backend that owns Vulkan resources.
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
        let (caps, formats) = query_surface_details(config)?;
        let format = choose_format(&formats)?;
        let extent = clamp_extent(caps, config.width, config.height);
        let count = get_image_count(caps);

        let create_info = create_swapchain_info(config.surface, count, format, extent, caps);
        let loader = khr::swapchain::Device::new(config.instance, config.device);

        // SAFETY: device and surface are valid, info is correct.
        let handle = unsafe { loader.create_swapchain(&create_info, None) }
            .map_err(VulkanError::Api)?;

        // SAFETY: handle is valid.
        let images = unsafe { loader.get_swapchain_images(handle) }
            .map_err(VulkanError::Api)?;

        let views = create_views(config.device, &images, format.format)?;
        let frames = create_sync_objects(config.device, images.len())?;

        debug!("Swapchain created: {:?} {:?}", extent, format.format);

        Ok((
            Self {
                loader,
                handle,
                images,
                views,
                frames,
                current_frame: 0,
            },
            extent,
        ))
    }

    pub fn acquire_next_image(&mut self, device: &ash::Device) -> PalResult<AcquiredImage> {
        let frame = self.get_current_frame()?;

        // SAFETY: device and fence are valid.
        unsafe {
            device
                .wait_for_fences(&[frame.in_flight], true, u64::MAX)
                .map_err(VulkanError::Api)?;
            device
                .reset_fences(&[frame.in_flight])
                .map_err(VulkanError::Api)?;
        }

        // SAFETY: loader and handle are valid.
        let (index, _) = unsafe {
            self.loader.acquire_next_image(
                self.handle,
                u64::MAX,
                frame.image_available,
                vk::Fence::null(),
            )
        }
        .map_err(VulkanError::Api)?;

        let image = *self
            .images
            .get(index as usize)
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

        // SAFETY: loader and info are valid.
        unsafe { self.loader.queue_present(queue, &present_info) }.map_err(VulkanError::Api)?;

        self.advance_frame();
        Ok(())
    }

    pub fn destroy(&mut self, device: &ash::Device) {
        // SAFETY: device is valid, we own resources.
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

    fn get_current_frame(&self) -> PalResult<&FrameSync> {
        self.frames
            .get(self.current_frame)
            .ok_or_else(|| PalError::Swapchain("Frame index out of bounds".into()))
    }

    fn advance_frame(&mut self) {
        self.current_frame = (self.current_frame + 1) % self.frames.len();
    }
}

// --- Helpers ---

fn query_surface_details(
    config: &SwapchainConfig,
) -> PalResult<(vk::SurfaceCapabilitiesKHR, Vec<vk::SurfaceFormatKHR>)> {
    // SAFETY: loader and surface are valid.
    let caps = unsafe {
        config
            .surface_loader
            .get_physical_device_surface_capabilities(config.physical, config.surface)
    }
    .map_err(VulkanError::Api)?;

    // SAFETY: loader and surface are valid.
    let formats = unsafe {
        config
            .surface_loader
            .get_physical_device_surface_formats(config.physical, config.surface)
    }
    .map_err(VulkanError::Api)?;

    Ok((caps, formats))
}

fn create_swapchain_info(
    surface: vk::SurfaceKHR,
    count: u32,
    format: vk::SurfaceFormatKHR,
    extent: vk::Extent2D,
    caps: vk::SurfaceCapabilitiesKHR,
) -> vk::SwapchainCreateInfoKHR<'static> {
    vk::SwapchainCreateInfoKHR::default()
        .surface(surface)
        .min_image_count(count)
        .image_format(format.format)
        .image_color_space(format.color_space)
        .image_extent(extent)
        .image_array_layers(1)
        .image_usage(vk::ImageUsageFlags::COLOR_ATTACHMENT | vk::ImageUsageFlags::TRANSFER_DST)
        .image_sharing_mode(vk::SharingMode::EXCLUSIVE)
        .pre_transform(caps.current_transform)
        .composite_alpha(vk::CompositeAlphaFlagsKHR::OPAQUE)
        .present_mode(vk::PresentModeKHR::FIFO)
        .clipped(true)
}

fn choose_format(formats: &[vk::SurfaceFormatKHR]) -> PalResult<vk::SurfaceFormatKHR> {
    formats
        .iter()
        .find(|f| {
            f.format == vk::Format::B8G8R8A8_UNORM
                && f.color_space == vk::ColorSpaceKHR::SRGB_NONLINEAR
        })
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

fn create_views(
    device: &ash::Device,
    images: &[vk::Image],
    format: vk::Format,
) -> PalResult<Vec<vk::ImageView>> {
    images
        .iter()
        .map(|&image| {
            let info = vk::ImageViewCreateInfo::default()
                .image(image)
                .view_type(vk::ImageViewType::TYPE_2D)
                .format(format)
                .subresource_range(
                    vk::ImageSubresourceRange::default()
                        .aspect_mask(vk::ImageAspectFlags::COLOR)
                        .level_count(1)
                        .layer_count(1),
                );
            // SAFETY: device is valid.
            unsafe { device.create_image_view(&info, None) }
                .map_err(VulkanError::Api)
                .map_err(PalError::from)
        })
        .collect()
}

fn create_sync_objects(device: &ash::Device, count: usize) -> PalResult<Vec<FrameSync>> {
    (0..count)
        .map(|_| {
            let sem_info = vk::SemaphoreCreateInfo::default();
            let fence_info = vk::FenceCreateInfo::default().flags(vk::FenceCreateFlags::SIGNALED);
            // SAFETY: device is valid.
            unsafe {
                Ok(FrameSync {
                    image_available: device
                        .create_semaphore(&sem_info, None)
                        .map_err(VulkanError::Api)?,
                    render_finished: device
                        .create_semaphore(&sem_info, None)
                        .map_err(VulkanError::Api)?,
                    in_flight: device
                        .create_fence(&fence_info, None)
                        .map_err(VulkanError::Api)?,
                })
            }
        })
        .collect()
}