//! Data types for the Presentation subsystem.

use ash::{khr, vk};

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