//! NITRATE Compositor - Video + UI composition
//!
//! Composites video frames with UI overlay in linear space,
//! applies color transforms, and presents to swapchain.

use nitrate_color::ColorUniforms;
use nitrate_core::Result;
use tracing::info;

/// Composition pipeline
pub struct ComposePipeline {
    // TODO: wgpu pipeline state
}

impl ComposePipeline {
    /// Create the composition pipeline
    pub fn new(_device: &wgpu::Device) -> Result<Self> {
        info!("Creating composition pipeline");
        // TODO: Load compose.wgsl shader and create pipeline
        Ok(Self {})
    }

    /// Compose a frame
    pub fn compose(
        &self,
        _encoder: &mut wgpu::CommandEncoder,
        _video_texture: &wgpu::TextureView,
        _ui_texture: &wgpu::TextureView,
        _output: &wgpu::TextureView,
        _color: &ColorUniforms,
    ) {
        // TODO: Bind textures and dispatch
    }
}

/// Frame pacing for smooth playback
pub struct FramePacer {
    target_frame_time: std::time::Duration,
    last_present: std::time::Instant,
}

impl FramePacer {
    #[must_use]
    pub fn new(fps: f64) -> Self {
        Self {
            target_frame_time: std::time::Duration::from_secs_f64(1.0 / fps),
            last_present: std::time::Instant::now(),
        }
    }

    /// Wait until it's time for the next frame
    pub fn wait_for_frame(&mut self) {
        let elapsed = self.last_present.elapsed();
        if elapsed < self.target_frame_time {
            std::thread::sleep(self.target_frame_time - elapsed);
        }
        self.last_present = std::time::Instant::now();
    }
}