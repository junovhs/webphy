//! NITRATE Platform Abstraction Layer
//!
//! Provides the "Native Host" architecture where native APIs (Vulkan/D3D12/Metal)
//! own GPU resources, and wgpu is used as a "Guest" compute runner.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────┐
//! │            Native Layer (Host)              │
//! │  - Owns Device, Swapchain, Video Surfaces   │
//! │  - Owns Synchronization Primitives          │
//! │  - Performs Final Composition               │
//! └─────────────────────────────────────────────┘
//!                      │
//!              HAL Bridge (unsafe)
//!                      │
//! ┌─────────────────────────────────────────────┐
//! │            WGPU Layer (Guest)               │
//! │  - Borrows wrapped Device                   │
//! │  - Owns UI Render Target                    │
//! │  - Runs Vello compute shaders               │
//! └─────────────────────────────────────────────┘
//! ```

pub mod error;
pub mod surface;
pub mod sync;

#[cfg(feature = "vulkan")]
pub mod vulkan;

pub use error::{PalError, PalResult};
pub use surface::{ColorMetadata, ImportedSurface, PlaneDescriptor};
pub use sync::{SyncHandle, SyncTier};

#[cfg(feature = "vulkan")]
pub use vulkan::{AcquiredImage, Swapchain, VulkanDevice, VulkanInstance, WgpuBridge};
