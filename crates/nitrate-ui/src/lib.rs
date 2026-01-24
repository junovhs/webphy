//! NITRATE UI - GPU-rendered user interface
//!
//! Uses Vello for 2D vector graphics rendering to wgpu.
//! The UI render target is native-owned and imported into wgpu.

use nitrate_core::{Extent2D, Result};
use tracing::info;

/// UI renderer using Vello
pub struct UiRenderer {
    // TODO: Vello renderer state
}

impl UiRenderer {
    /// Create a new UI renderer
    pub fn new(_device: &wgpu::Device, _queue: &wgpu::Queue) -> Result<Self> {
        info!("Creating Vello UI renderer");
        Ok(Self {})
    }

    /// Render UI to the given render target
    pub fn render(&mut self, _target: &wgpu::TextureView, _extent: Extent2D) -> Result<()> {
        // TODO: Vello scene building and rendering
        Ok(())
    }
}

/// UI scene definition
pub struct UiScene {
    // TODO: Scene graph or immediate-mode state
}

impl UiScene {
    #[must_use]
    pub fn new() -> Self {
        Self {}
    }
}

impl Default for UiScene {
    fn default() -> Self {
        Self::new()
    }
}
