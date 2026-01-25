//! Native Vulkan swapchain facade.
//!
//! This acts as a high-level wrapper around the implementation logic
//! located in `backend.rs`.

mod backend;
mod types;

pub use backend::SwapchainBackend;
pub use types::{AcquiredImage, SwapchainConfig};

use crate::error::PalResult;
use ash::vk;

/// Manages the presentation layer.
///
/// This struct uses the Facade pattern to hide complexity.
/// All heavy lifting is done by `SwapchainBackend`.
pub struct Swapchain {
    backend: SwapchainBackend,
    pub extent: vk::Extent2D,
}

impl Swapchain {
    /// Creates a new swapchain with the specified configuration.
    pub fn new(config: &SwapchainConfig) -> PalResult<Self> {
        let (backend, extent) = SwapchainBackend::new(config)?;
        Ok(Self { backend, extent })
    }

    /// Acquires the next image index from the swapchain.
    pub fn acquire_next_image(&mut self, device: &ash::Device) -> PalResult<AcquiredImage> {
        self.backend.acquire_next_image(device)
    }

    /// Presents the image to the screen.
    pub fn present(&mut self, queue: vk::Queue, image: &AcquiredImage) -> PalResult<()> {
        self.backend.present(queue, image)
    }

    /// Destroys the swapchain resources.
    pub fn destroy(&mut self, device: &ash::Device) {
        self.backend.destroy(device);
    }
}