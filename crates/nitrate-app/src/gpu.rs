//! GPU initialization and management

use anyhow::{Context, Result};
use std::sync::Arc;
use tracing::info;
use winit::window::Window;

/// Wrapped GPU resources to reduce direct type coupling
pub struct GpuResources {
    pub surface: wgpu::Surface<'static>,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
}

/// Surface configuration (separated to reduce SFOUT)
pub struct SurfaceConfig {
    pub width: u32,
    pub height: u32,
    pub format: wgpu::TextureFormat,
    pub alpha_mode: wgpu::CompositeAlphaMode,
}

impl SurfaceConfig {
    fn to_wgpu(&self) -> wgpu::SurfaceConfiguration {
        wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: self.format,
            width: self.width,
            height: self.height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: self.alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        }
    }
}

pub struct GpuState {
    res: GpuResources,
    config: SurfaceConfig,
}

impl GpuState {
    pub async fn new(window: Arc<Window>) -> Result<Self> {
        let (res, config) = init_gpu(window).await?;
        res.surface.configure(&res.device, &config.to_wgpu());
        Ok(Self { res, config })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.config.width = width;
            self.config.height = height;
            self.res.surface.configure(&self.res.device, &self.config.to_wgpu());
            info!("Resized to {}x{}", width, height);
        }
    }

    pub fn render(&self) -> Result<()> {
        render_frame(&self.res)
    }
}

async fn init_gpu(window: Arc<Window>) -> Result<(GpuResources, SurfaceConfig)> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..Default::default()
    });

    let surface = instance.create_surface(window.clone())?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        })
        .await
        .context("No adapter found")?;

    info!("Adapter: {}", adapter.get_info().name);

    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default(), None)
        .await?;

    let size = window.inner_size();
    let caps = surface.get_capabilities(&adapter);

    let format = caps.formats.iter()
        .find(|f| f.is_srgb())
        .copied()
        .or_else(|| caps.formats.first().copied())
        .context("No formats")?;

    let alpha_mode = caps.alpha_modes.first().copied().context("No alpha modes")?;

    let config = SurfaceConfig { width: size.width, height: size.height, format, alpha_mode };
    let res = GpuResources { surface, device, queue };

    Ok((res, config))
}

fn render_frame(res: &GpuResources) -> Result<()> {
    let output = res.surface.get_current_texture()?;
    let view = output.texture.create_view(&wgpu::TextureViewDescriptor::default());

    let mut encoder = res.device.create_command_encoder(
        &wgpu::CommandEncoderDescriptor { label: Some("Render") }
    );

    {
        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Clear"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.039, g: 0.039, b: 0.039, a: 1.0 }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
    }

    res.queue.submit(std::iter::once(encoder.finish()));
    output.present();
    Ok(())
}