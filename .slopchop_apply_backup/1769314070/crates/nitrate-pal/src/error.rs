//! Error types for the Platform Abstraction Layer.

use thiserror::Error;

/// Errors from platform abstraction operations.
#[derive(Debug, Error)]
pub enum PalError {
    #[error("Vulkan error: {0}")]
    Vulkan(#[from] VulkanError),

    #[error("Surface creation failed: {0}")]
    Surface(String),

    #[error("No suitable GPU found")]
    NoSuitableDevice,

    #[error("Required extension not supported: {0}")]
    MissingExtension(String),

    #[error("Swapchain error: {0}")]
    Swapchain(String),

    #[error("HAL bridge error: {0}")]
    Bridge(String),
}

/// Vulkan-specific errors.
#[derive(Debug, Error)]
pub enum VulkanError {
    #[error("Instance creation failed: {0}")]
    InstanceCreation(String),

    #[error("Device creation failed: {0}")]
    DeviceCreation(String),

    #[error("Queue not found for family {0}")]
    QueueNotFound(u32),

    #[error("Validation layer not available")]
    ValidationUnavailable,

    #[error("Vulkan API error: {0}")]
    Api(#[from] ash::vk::Result),
}

/// Result alias for PAL operations.
pub type PalResult<T> = Result<T, PalError>;
