//! GPU initialization and management
//!
//! Separated from main.rs to reduce coupling and file size.

use anyhow::{Context, Result};
use std::sync::Arc;
use tracing::info;
use winit::window::Window;

/// GPU state container
pub struct GpuState {
    pub surface: wgpu::Surface<'static>,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub config: wgpu::SurfaceConfiguration,
}

impl GpuState {
    /// Initialize GPU state using builder pattern
    pub async fn new(window: Arc<Window>) -> Result<Self> {
        let builder = GpuBuilder::new(window);
        builder.build().await
    }

    /// Resize the surface
    pub fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.device, &self.config);
            info!("Resized to {}x{}", width, height);
        }
    }

    /// Delegate render logic to free function to reduce SFOUT
    pub fn render(&self) -> Result<()> {
        render_frame(self)
    }
}

/// Standalone render function to decouple from `GpuState` methods
fn render_frame(gpu: &GpuState) -> Result<()> {
    let output = gpu.surface.get_current_texture()?;
    let view = output.texture.create_view(&wgpu::TextureViewDescriptor::default());

    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Render Encoder"),
    });

    record_render_pass(&mut encoder, &view);

    gpu.queue.submit(std::iter::once(encoder.finish()));
    output.present();

    Ok(())
}

// Builder to encapsulate complex initialization logic
struct GpuBuilder {
    window: Arc<Window>,
}

impl GpuBuilder {
    fn new(window: Arc<Window>) -> Self {
        Self { window }
    }

    async fn build(self) -> Result<GpuState> {
        let instance = Self::create_instance();
        let surface = instance.create_surface(self.window.clone())?;
        
        let adapter = self.request_adapter(&instance, &surface).await?;
        info!("Adapter: {}", adapter.get_info().name);

        let (device, queue) = self.request_device(&adapter).await?;
        let config = self.create_surface_config(&surface, &adapter)?;

        surface.configure(&device, &config);

        Ok(GpuState {
            surface,
            device,
            queue,
            config,
        })
    }

    fn create_instance() -> wgpu::Instance {
        wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN,
            ..Default::default()
        })
    }

    async fn request_adapter(
        &self,
        instance: &wgpu::Instance,
        surface: &wgpu::Surface<'static>
    ) -> Result<wgpu::Adapter> {
        instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(surface),
            force_fallback_adapter: false,
        })
        .await
        .ok_or_else(|| anyhow::anyhow!("No adapter found"))
    }

    async fn request_device(&self, adapter: &wgpu::Adapter) -> Result<(wgpu::Device, wgpu::Queue)> {
        adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("NITRATE Device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        ).await.map_err(Into::into)
    }

    fn create_surface_config(
        &self,
        surface: &wgpu::Surface,
        adapter: &wgpu::Adapter
    ) -> Result<wgpu::SurfaceConfiguration> {
        let size = self.window.inner_size();
        let caps = surface.get_capabilities(adapter);
        
        let format = caps.formats.iter()
            .find(|f| f.is_srgb())
            .copied()
            .or_else(|| caps.formats.first().copied())
            .context("No supported surface formats")?;

        let alpha_mode = caps.alpha_modes.first()
            .copied()
            .context("No supported alpha modes")?;

        Ok(wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width,
            height: size.height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        })
    }
}

fn record_render_pass(encoder: &mut wgpu::CommandEncoder, view: &wgpu::TextureView) {
    let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Clear Pass"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color {
                    r: 0.039, // #0a0a0a
                    g: 0.039,
                    b: 0.039,
                    a: 1.0,
                }),
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
    });
}