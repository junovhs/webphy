//! Pure helper functions for Swapchain creation.

use super::types::{FrameSync, SwapchainConfig, SwapchainSupport};
use crate::error::{PalError, PalResult, VulkanError};
use ash::vk;

pub fn query_support(config: &SwapchainConfig) -> PalResult<SwapchainSupport> {
    // SAFETY: Valid loader and handles.
    let caps = unsafe {
        config
            .surface_loader
            .get_physical_device_surface_capabilities(config.physical, config.surface)
    }
    .map_err(VulkanError::Api)?;

    // SAFETY: Valid loader and handles.
    let formats = unsafe {
        config
            .surface_loader
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

pub fn create_info<'a>(
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

pub fn create_views(
    device: &ash::Device,
    images: &[vk::Image],
    format: vk::Format,
) -> PalResult<Vec<vk::ImageView>> {
    images
        .iter()
        .map(|&image| {
            let create_info = vk::ImageViewCreateInfo::default()
                .image(image)
                .view_type(vk::ImageViewType::TYPE_2D)
                .format(format)
                .subresource_range(
                    vk::ImageSubresourceRange::default()
                        .aspect_mask(vk::ImageAspectFlags::COLOR)
                        .base_mip_level(0)
                        .level_count(1)
                        .base_array_layer(0)
                        .layer_count(1),
                );

            // SAFETY: device is valid.
            unsafe { device.create_image_view(&create_info, None) }
                .map_err(VulkanError::Api)
                .map_err(PalError::from)
        })
        .collect()
}

pub fn create_sync_objects(device: &ash::Device, count: usize) -> PalResult<Vec<FrameSync>> {
    (0..count)
        .map(|_| {
            let semaphore_info = vk::SemaphoreCreateInfo::default();
            let fence_info = vk::FenceCreateInfo::default().flags(vk::FenceCreateFlags::SIGNALED);

            // SAFETY: device is valid.
            unsafe {
                let image_available = device
                    .create_semaphore(&semaphore_info, None)
                    .map_err(VulkanError::Api)?;
                let render_finished = device
                    .create_semaphore(&semaphore_info, None)
                    .map_err(VulkanError::Api)?;
                let in_flight = device
                    .create_fence(&fence_info, None)
                    .map_err(VulkanError::Api)?;

                Ok(FrameSync {
                    image_available,
                    render_finished,
                    in_flight,
                })
            }
        })
        .collect()
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