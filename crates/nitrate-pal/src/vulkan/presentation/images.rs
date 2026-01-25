//! Manages the chain of images and views.

use crate::error::{PalError, PalResult, VulkanError};
use ash::vk;

pub struct ImageChain {
    pub handles: Vec<vk::Image>,
    pub views: Vec<vk::ImageView>,
}

impl ImageChain {
    pub fn init(
        device: &ash::Device,
        images: &[vk::Image],
        format: vk::Format,
    ) -> PalResult<Self> {
        let handles = images.to_vec();
        let mut views = Vec::with_capacity(images.len());

        for &img in images {
            let info = vk::ImageViewCreateInfo::default()
                .image(img)
                .view_type(vk::ImageViewType::TYPE_2D)
                .format(format)
                .subresource_range(
                    vk::ImageSubresourceRange::default()
                        .aspect_mask(vk::ImageAspectFlags::COLOR)
                        .level_count(1)
                        .layer_count(1),
                );

            // SAFETY: Valid device and image handle.
            let view = unsafe { device.create_image_view(&info, None) }
                .map_err(VulkanError::Api)?;
            views.push(view);
        }

        Ok(Self { handles, views })
    }

    pub fn get(&self, index: u32) -> PalResult<vk::Image> {
        self.handles
            .get(index as usize)
            .copied()
            .ok_or_else(|| PalError::Swapchain("Image index invalid".into()))
    }

    pub fn teardown(&mut self, device: &ash::Device) {
        for &view in &self.views {
            // SAFETY: Valid device and view.
            unsafe { device.destroy_image_view(view, None) };
        }
    }
}