//! NITRATE Platform Abstraction Layer
//!
//! Provides cross-platform GPU resource management with explicit sync tiers.
//!
//! # Architecture
//!
//! Native owns all resources. wgpu is a command generator only.
//!
//! The native layer owns video decoder surfaces, UI render targets, and sync primitives.
//! wgpu borrows these resources to render UI content.

pub mod surface;
pub mod sync;

#[cfg(feature = "vulkan")]
pub mod vulkan;

use nitrate_core::{Extent2D, FrameId, Result};
use std::sync::Arc;

pub use surface::{ImportedSurface, SurfaceHandle};
pub use sync::{SyncCapabilities, SyncStrategy, SyncTier};

// ============================================================================
// Platform Device Trait
// ============================================================================

/// Platform-specific GPU device abstraction
pub trait PlatformDevice: Send + Sync {
    /// Query sync capabilities of this device
    fn sync_capabilities(&self) -> SyncCapabilities;

    /// Create an importable UI render target
    fn create_ui_render_target(&self, extent: Extent2D) -> Result<Box<dyn UiRenderTarget>>;

    /// Create a compositor for final output
    fn create_compositor(&self) -> Result<Box<dyn Compositor>>;
}

// ============================================================================
// UI Render Target Trait
// ============================================================================

/// Native-owned render target that wgpu can render into
pub trait UiRenderTarget: Send + Sync {
    /// Get the surface handle for import into wgpu
    fn handle(&self) -> &SurfaceHandle;

    /// Dimensions
    fn extent(&self) -> Extent2D;

    /// Signal value to wait on before reading (set after wgpu renders)
    fn render_complete_value(&self) -> u64;

    /// Increment and return the next signal value
    fn next_signal_value(&self) -> u64;
}

// ============================================================================
// Compositor Trait
// ============================================================================

/// Composes video + UI to swapchain
pub trait Compositor: Send + Sync {
    /// Begin a new frame
    fn begin_frame(&mut self, frame_id: FrameId) -> Result<()>;

    /// Set the video surface to composite
    fn set_video_surface(&mut self, surface: &ImportedSurface) -> Result<()>;

    /// Set the UI render target to composite
    fn set_ui_surface(&mut self, handle: &SurfaceHandle) -> Result<()>;

    /// Execute composition and present
    fn compose_and_present(&mut self, sync: &dyn SyncStrategy) -> Result<()>;
}

// ============================================================================
// Device Creation
// ============================================================================

/// Create platform device for the current platform
pub fn create_platform_device() -> Result<Arc<dyn PlatformDevice>> {
    #[cfg(all(target_os = "linux", feature = "vulkan"))]
    {
        vulkan::VulkanDevice::new().map(|d| Arc::new(d) as Arc<dyn PlatformDevice>)
    }

    #[cfg(not(all(target_os = "linux", feature = "vulkan")))]
    {
        use nitrate_core::Error;
        Err(Error::PlatformNotSupported(
            "No supported platform backend".into(),
        ))
    }
}