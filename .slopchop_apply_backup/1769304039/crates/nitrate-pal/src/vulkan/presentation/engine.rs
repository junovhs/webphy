//! The main entry point for presentation logic.

use super::images::ImageChain;
use super::sync::FramePacer;
use crate::error::{PalError, PalResult, VulkanError};
use ash::{khr, vk};
use tracing::debug;

/// Configuration for the presentation engine.
pub struct PresentationConfig<'a> {
    pub instance: &'a ash::Instance,
    pub device: &'a ash::Device,
    pub physical: vk::PhysicalDevice,
    pub surface_loader: &'a khr::surface::Instance,
    pub surface: vk::SurfaceKHR,
    pub width: u32,
    pub height: u32,
}

/// A frame acquired from the presentation engine, ready for rendering.
pub struct AcquiredFrame {
    pub index: u32,
    pub image: vk::Image,
    pub ready: vk::Semaphore,
    pub done: vk::Semaphore,
    pub fence: vk::Fence,
}

/// Orchestrates the swapchain, images, and synchronization.
pub struct PresentationEngine {
    loader: khr::swapchain::Device,
    swapchain: vk::SwapchainKHR,
    images: ImageChain,
    pacer: FramePacer,
    pub extent: vk::Extent2D,
}

impl PresentationEngine {
    /// Initialize a new presentation engine.
    pub fn init(config: &PresentationConfig) -> PalResult<Self> {
        let (caps, formats) = query_surface(config)?;
        let format = select_format(&formats)?;
        let extent = resolve_extent(caps, config.width, config.height);
        let count = resolve_image_count(caps);

        let create_info =
            vk::SwapchainCreateInfoKHR::default()
                .surface(config.surface)
                .min_image_count(count)
                .image_format(format.format)
                .image_color_space(format.color_space)
                .image_extent(extent)
                .image_array_layers(1)
                .image_usage(
                    vk::ImageUsageFlags::COLOR_ATTACHMENT | vk::ImageUsageFlags::TRANSFER_DST,
                )
                .image_sharing_mode(vk::SharingMode::EXCLUSIVE)
                .pre_transform(caps.current_transform)
                .composite_alpha(vk::CompositeAlphaFlagsKHR::OPAQUE)
                .present_mode(vk::PresentModeKHR::FIFO)
                .clipped(true);

        let loader = khr::swapchain::Device::new(config.instance, config.device);

        // SAFETY: Valid device, valid info.
        let swapchain = unsafe { loader.create_swapchain(&create_info, None) }
            .map_err(VulkanError::Api)?;

        // SAFETY: Valid swapchain handle.
        let raw_images = unsafe { loader.get_swapchain_images(swapchain) }
            .map_err(VulkanError::Api)?;

        let images = ImageChain::init(config.device, &raw_images, format.format)?;
        let pacer = FramePacer::init(config.device, raw_images.len())?;

        debug!("Presentation initialized: {}x{}", extent.width, extent.height);

        Ok(Self {
            loader,
            swapchain,
            images,
            pacer,
            extent,
        })
    }

    /// Acquire the next image for rendering.
    pub fn acquire(&mut self, device: &ash::Device) -> PalResult<AcquiredFrame> {
        let sync = self.pacer.next_frame()?;

        // SAFETY: Valid fence.
        unsafe {
            device
                .wait_for_fences(&[sync.fence], true, u64::MAX)
                .map_err(VulkanError::Api)?;
            device
                .reset_fences(&[sync.fence])
                .map_err(VulkanError::Api)?;
        }

        // SAFETY: Valid swapchain and semaphore.
        let (index, _) = unsafe {
            self.loader.acquire_next_image(
                self.swapchain,
                u64::MAX,
                sync.ready,
                vk::Fence::null(),
            )
        }
        .map_err(VulkanError::Api)?;

        let image = self.images.get(index)?;

        Ok(AcquiredFrame {
            index,
            image,
            ready: sync.ready,
            done: sync.done,
            fence: sync.fence,
        })
    }

    /// Present the rendered image.
    pub fn present(&mut self, queue: vk::Queue, frame: &AcquiredFrame) -> PalResult<()> {
        let indices = [frame.index];
        let wait = [frame.done];
        let chains = [self.swapchain];

        let info = vk::PresentInfoKHR::default()
            .wait_semaphores(&wait)
            .swapchains(&chains)
            .image_indices(&indices);

        // SAFETY: Valid queue and info.
        unsafe { self.loader.queue_present(queue, &info) }.map_err(VulkanError::Api)?;

        self.pacer.advance();
        Ok(())
    }

    /// Teardown all resources.
    pub fn teardown(&mut self, device: &ash::Device) {
        self.pacer.teardown(device);
        self.images.teardown(device);
        // SAFETY: Valid loader and swapchain.
        unsafe { self.loader.destroy_swapchain(self.swapchain, None) };
    }
}

// --- Internal Helpers (Free Functions) ---

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