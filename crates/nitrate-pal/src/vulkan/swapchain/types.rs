//! Data types for the Swapchain subsystem.
//!
//! Separated to reduce coupling between logic and state.

use ash::{khr, vk};

/// Configuration required to create a Swapchain.
pub struct SwapchainConfig<'a> {
    pub instance: &'a ash::Instance,
    pub device: &'a ash::Device,
    pub physical: vk::PhysicalDevice,
    pub surface_loader: &'a khr::surface::Instance,
    pub surface: vk::SurfaceKHR,
    pub width: u32,
    pub height: u32,
}

/// A swapchain image that has been acquired for rendering.
pub struct AcquiredImage {
    /// The index of the image in the swapchain array.
    pub index: u32,
    /// The raw Vulkan image handle.
    pub image: vk::Image,
    /// Semaphore signaled when the image is available.
    pub image_available: vk::Semaphore,
    /// Semaphore to signal when rendering is finished.
    pub render_finished: vk::Semaphore,
    /// Fence to signal when the frame is fully submitted.
    pub submit_fence: vk::Fence,
}

/// Internal synchronization primitives for a single frame slot.
pub struct FrameSync {
    pub image_available: vk::Semaphore,
    pub render_finished: vk::Semaphore,
    pub in_flight: vk::Fence,
}