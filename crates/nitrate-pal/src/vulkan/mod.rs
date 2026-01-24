//! Vulkan backend implementation.
//!
//! Provides native Vulkan device management with wgpu HAL bridging.
//! This is the "Native Host" that owns all GPU resources.

mod bridge;
mod device;
mod extensions;
mod instance;
mod queues;
mod swapchain;

pub use bridge::WgpuBridge;
pub use device::VulkanDevice;
pub use instance::VulkanInstance;
pub use swapchain::{AcquiredImage, Swapchain};

/// Required device extensions for full functionality.
pub const REQUIRED_DEVICE_EXTENSIONS: &[&std::ffi::CStr] = &[
    ash::khr::swapchain::NAME,
];

/// Optional extensions that enable better sync tiers.
pub const OPTIONAL_DEVICE_EXTENSIONS: &[&std::ffi::CStr] = &[
    ash::khr::timeline_semaphore::NAME,
    ash::khr::external_memory_fd::NAME,
    ash::khr::external_semaphore_fd::NAME,
];
