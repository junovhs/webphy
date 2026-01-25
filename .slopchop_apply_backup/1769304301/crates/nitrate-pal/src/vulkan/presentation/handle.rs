//! Low-level Swapchain handle management.
//!
//! Wraps the raw Vulkan SwapchainKHR and its creation logic.

use super::types::PresentationConfig;
use crate::error::{PalError, PalResult, VulkanError};
use ash::{khr, vk};
use tracing::debug;

/// Wraps the Vulkan Swapchain object and its loader.
pub struct SwapchainHandle {
    loader: khr::swapchain::Device,
    handle: vk::SwapchainKHR,
}

impl SwapchainHandle {
    /// Creates a new swapchain handle and returns it along with image handles and format info.
    pub fn new(
        config: &PresentationConfig,
    ) -> PalResult<(Self, Vec<vk::Image>, vk::Extent2D, vk::Format)> {
        let (caps, formats) = query_surface(config)?;
        let format = select_format(&formats)?;
        let extent = resolve_extent(caps, config.width, config.height);
        let count = resolve_image_count(caps);

        let create_info = create_info(config.surface, count, format, extent, caps);
        let loader = khr::swapchain::Device::new(config.instance, config.device);

        // SAFETY: Valid device, valid info.
        let handle = unsafe { loader.create_swapchain(&create_info, None) }
            .map_err(VulkanError::Api)?;

        // SAFETY: Valid swapchain handle.
        let images = unsafe { loader.get_swapchain_images(handle) }
            .map_err(VulkanError::Api)?;

        debug!(
            "Swapchain created: {}x{} ({:?})",
            extent.width, extent.height, format.format
        );

        Ok((
            Self { loader, handle },
            images,
            extent,
            format.format,
        ))
    }

    /// Acquires the next image index.
    pub fn acquire(&self, semaphore: vk::Semaphore) -> PalResult<u32> {
        // SAFETY: Valid swapchain and semaphore.
        let (index, _) = unsafe {
            self.loader
                .acquire_next_image(self.handle, u64::MAX, semaphore, vk::Fence::null())
        }
        .map_err(VulkanError::Api)?;
        Ok(index)
    }

    /// Presents an image.
    pub fn present(&self, queue: vk::Queue, index: u32, wait: vk::Semaphore) -> PalResult<()> {
        let indices = [index];
        let wait_semaphores = [wait];
        let swapchains = [self.handle];

        let info = vk::PresentInfoKHR::default()
            .wait_semaphores(&wait_semaphores)
            .swapchains(&swapchains)
            .image_indices(&indices);

        // SAFETY: Valid queue and info.
        unsafe { self.loader.queue_present(queue, &info) }.map_err(VulkanError::Api)?;
        Ok(())
    }

    /// Destroys the swapchain.
    pub fn destroy(&mut self) {
        // SAFETY: Valid loader and swapchain.
        unsafe { self.loader.destroy_swapchain(self.handle, None) };
    }
}

// --- Helpers ---

fn query_surface(
    config: &PresentationConfig,
) -> PalResult<(vk::SurfaceCapabilitiesKHR, Vec<vk::SurfaceFormatKHR>)> {
    // SAFETY: Valid loader/surface.
    let caps = unsafe {
        config
            .surface_loader
            .get_physical_device_surface_capabilities(config.physical, config.surface)
    }
    .map_err(VulkanError::Api)?;

    // SAFETY: Valid loader/surface.
    let formats = unsafe {
        config
            .surface_loader
            .get_physical_device_surface_formats(config.physical, config.surface)
    }
    .map_err(VulkanError::Api)?;

    Ok((caps, formats))
}

fn select_format(formats: &[vk::SurfaceFormatKHR]) -> PalResult<vk::SurfaceFormatKHR> {
    formats
        .iter()
        .find(|f| {
            f.format == vk::Format::B8G8R8A8_UNORM
                && f.color_space == vk::ColorSpaceKHR::SRGB_NONLINEAR
        })
        .or_else(|| formats.first())
        .copied()
        .ok_or_else(|| PalError::Swapchain("No valid format".into()))
}

fn resolve_extent(caps: vk::SurfaceCapabilitiesKHR, w: u32, h: u32) -> vk::Extent2D {
    if caps.current_extent.width != u32::MAX {
        return caps.current_extent;
    }
    vk::Extent2D {
        width: w.clamp(caps.min_image_extent.width, caps.max_image_extent.width),
        height: h.clamp(caps.min_image_extent.height, caps.max_image_extent.height),
    }
}

fn resolve_image_count(caps: vk::SurfaceCapabilitiesKHR) -> u32 {
    let count = caps.min_image_count + 1;
    if caps.max_image_count > 0 {
        count.min(caps.max_image_count)
    } else {
        count
    }
}

fn create_info(
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