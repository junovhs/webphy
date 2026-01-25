//! The main entry point for presentation logic.

use super::handle::SwapchainHandle;
use super::images::ImageChain;
use super::sync::FramePacer;
use super::types::{AcquiredFrame, PresentationConfig};
use crate::error::{PalResult, VulkanError};
use ash::vk;

/// Orchestrates the swapchain, images, and synchronization.
pub struct PresentationEngine {
    handle: SwapchainHandle,
    images: ImageChain,
    pacer: FramePacer,
    pub extent: vk::Extent2D,
}

impl PresentationEngine {
    /// Initialize a new presentation engine.
    pub fn init(config: &PresentationConfig) -> PalResult<Self> {
        let (handle, raw_images, extent, format) = SwapchainHandle::new(config)?;
        let images = ImageChain::init(config.device, &raw_images, format)?;
        let pacer = FramePacer::init(config.device, raw_images.len())?;

        Ok(Self {
            handle,
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

        let index = self.handle.acquire(sync.ready)?;
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
        self.handle.present(queue, frame.index, frame.done)?;
        self.pacer.advance();
        Ok(())
    }

    /// Teardown all resources.
    pub fn teardown(&mut self, device: &ash::Device) {
        self.pacer.teardown(device);
        self.images.teardown(device);
        self.handle.destroy();
    }
}