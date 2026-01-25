//! Vulkan backend implementation.
//!
//! Provides native Vulkan device management with wgpu HAL bridging.
//! This is the "Native Host" that owns all GPU resources.

mod bridge;
pub mod capabilities;
mod device;
mod extensions;
pub mod export;
pub mod import;
mod instance;
pub mod presentation;
mod queues;

pub use bridge::WgpuBridge;
pub use capabilities::DeviceCapabilities;
pub use device::VulkanDevice;
pub use export::ExportedImage;
pub use import::ImportedTexture;
pub use instance::VulkanInstance;
pub use presentation::{AcquiredFrame, PresentationConfig, PresentationEngine};

/// Required device extensions for full functionality.
pub const REQUIRED_DEVICE_EXTENSIONS: &[&std::ffi::CStr] = &[
    ash::khr::swapchain::NAME,
];

/// Optional extensions that enable better sync tiers and DMA-BUF export.
pub const OPTIONAL_DEVICE_EXTENSIONS: &[&std::ffi::CStr] = &[
    ash::khr::timeline_semaphore::NAME,
    ash::khr::external_memory_fd::NAME,
    ash::khr::external_semaphore_fd::NAME,
    ash::ext::external_memory_dma_buf::NAME,
];