use anyhow::{Context, Result};
use std::sync::Arc;
use wgpu::{
    Adapter, Device, DeviceDescriptor, Instance, InstanceDescriptor, Queue,
    RequestAdapterOptions, Surface, SurfaceConfiguration, TextureFormat, TextureUsages,
};
use winit::window::Window;

pub struct GpuContext {
    pub surface: Surface<'static>,
    pub device: Device,
    pub queue: Queue,
    pub config: SurfaceConfiguration,
    pub format: TextureFormat,
    // Keep window alive for surface lifetime
    _window: Arc<Window>,
}

impl GpuContext {
    pub async fn new(window: &Window) -> Result<Self> {
        let window = Arc::new(window.clone());
        let size = window.inner_size();

        // Create instance
        let instance = Instance::new(&InstanceDescriptor::default());

        // Create surface
        let surface = instance
            .create_surface(window.clone())
            .context("Failed to create surface")?;

        // Request adapter
        let adapter = instance
            .request_adapter(&RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .context("No suitable GPU adapter found")?;

        log_adapter_info(&adapter);

        // Request device
        let (device, queue) = adapter
            .request_device(&DeviceDescriptor::default(), None)
            .await
            .context("Failed to create device")?;

        // Configure surface
        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .find(|f| f.is_srgb())
            .copied()
            .unwrap_or(caps.formats[0]);

        let config = SurfaceConfiguration {
            usage: TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::AutoVsync,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        Ok(Self {
            surface,
            device,
            queue,
            config,
            format,
            _window: window,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
    }
}

fn log_adapter_info(adapter: &Adapter) {
    let info = adapter.get_info();
    tracing::info!(
        "GPU: {} ({:?})",
        info.name,
        info.backend
    );
}
