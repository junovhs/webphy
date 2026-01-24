//! Vulkan backend for nitrate-pal
//!
//! Uses ash for low-level Vulkan access.

mod bridge;
mod device;
mod helpers;

pub use bridge::{BridgeConfig, WgpuBridge};
pub use device::VulkanDevice;