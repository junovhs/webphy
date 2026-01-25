//! Spike 2: The DMA-BUF Roundtrip
//!
//! Goal: Allocate native `VkImage`, export as DMA-BUF, import to wgpu, sample in shader.
//! Pass Criteria: Checkerboard pattern renders correctly, 0 validation errors.

mod render;

use anyhow::Result;
use ash::vk;
use nitrate_pal::vulkan::{ExportedImage, ImportedTexture};
use nitrate_pal::{
    PresentationConfig, PresentationEngine, VulkanDevice, VulkanInstance, WgpuBridge,
};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use render::{render_frame, BlitPipeline};
use std::sync::Arc;
use tracing::{error, info};
use winit::{
    application::ApplicationHandler,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop},
    window::{Window, WindowAttributes, WindowId},
};

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("spike2=debug,nitrate_pal=debug,wgpu=warn")
        .init();
    info!("=== SPIKE 2: DMA-BUF ROUNDTRIP ===");

    let event_loop = EventLoop::new()?;
    event_loop.set_control_flow(ControlFlow::Poll);
    event_loop.run_app(&mut SpikeApp::default())?;

    info!("=== SPIKE 2: COMPLETED ===");
    Ok(())
}

#[derive(Default)]
struct SpikeApp {
    session: Option<Session>,
}

impl ApplicationHandler for SpikeApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.session.is_none() {
            match Session::new(event_loop) {
                Ok(s) => self.session = Some(s),
                Err(e) => {
                    error!("Failed to create session: {e}");
                    event_loop.exit();
                }
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                if let Some(s) = self.session.as_mut() {
                    s.destroy();
                }
                event_loop.exit();
            }
            WindowEvent::RedrawRequested => {
                if let Some(s) = self.session.as_mut() {
                    if let Err(e) = s.render() {
                        error!("Render failed: {e}");
                        event_loop.exit();
                    }
                    s.window.request_redraw();
                }
            }
            _ => {}
        }
    }
}

struct Session {
    window: Arc<Window>,
    instance: VulkanInstance,
    surface: vk::SurfaceKHR,
    device: VulkanDevice,
    presentation: PresentationEngine,
    #[allow(dead_code)]
    bridge: WgpuBridge,
    #[allow(dead_code)]
    blit: BlitPipeline,
    #[allow(dead_code)]
    imported: ImportedTexture,
    #[allow(dead_code)]
    exported: ExportedImage,
    frame_count: u64,
}

impl Session {
    fn new(event_loop: &ActiveEventLoop) -> Result<Self> {
        let window = create_window(event_loop)?;
        let instance = VulkanInstance::new(&*window, true)?;
        let surface = create_surface(&instance, &window)?;
        let device = VulkanDevice::new(&instance, surface)?;

        info!("Device capabilities: {:?}", device.capabilities);

        let presentation = create_presentation(&instance, &device, &window, surface)?;
        // SAFETY: instance and device will outlive bridge.
        let bridge = unsafe { WgpuBridge::new(&instance, &device)? };
        info!("wgpu bridge established");

        let exported = create_exported_image(&instance, &device)?;
        let imported = import_texture(&bridge, &exported)?;
        let blit = BlitPipeline::new(bridge.device(), &imported);

        Ok(Self {
            window, instance, surface, device, presentation, bridge,
            blit, imported, exported, frame_count: 0,
        })
    }

    fn render(&mut self) -> Result<()> {
        let frame = self.presentation.acquire(&self.device.device)?;
        render_frame(&self.device, &frame)?;
        self.presentation.present(self.device.queues.present, &frame)?;

        self.frame_count += 1;
        if self.frame_count.is_multiple_of(300) {
            info!("Frame {}", self.frame_count);
        }
        Ok(())
    }

    fn destroy(&mut self) {
        // SAFETY: We own these resources.
        unsafe { self.device.device.device_wait_idle().ok(); }
        self.presentation.teardown(&self.device.device);
        // SAFETY: Surface created from instance.
        unsafe { self.instance.surface_loader.destroy_surface(self.surface, None); }
    }
}

fn create_window(event_loop: &ActiveEventLoop) -> Result<Arc<Window>> {
    let attrs = WindowAttributes::default()
        .with_title("SPIKE 2: DMA-BUF Roundtrip")
        .with_inner_size(winit::dpi::LogicalSize::new(1280, 720));
    Ok(Arc::new(event_loop.create_window(attrs)?))
}

fn create_surface(instance: &VulkanInstance, window: &Window) -> Result<vk::SurfaceKHR> {
    // SAFETY: Instance and window handles are valid.
    Ok(unsafe {
        ash_window::create_surface(
            &instance.entry, &instance.instance,
            window.display_handle()?.as_raw(),
            window.window_handle()?.as_raw(), None,
        )?
    })
}

fn create_presentation(
    instance: &VulkanInstance, device: &VulkanDevice,
    window: &Window, surface: vk::SurfaceKHR,
) -> Result<PresentationEngine> {
    let size = window.inner_size();
    let config = PresentationConfig {
        instance: &instance.instance, device: &device.device,
        physical: device.physical, surface_loader: &instance.surface_loader,
        surface, width: size.width, height: size.height,
    };
    Ok(PresentationEngine::init(&config)?)
}

fn create_exported_image(instance: &VulkanInstance, device: &VulkanDevice) -> Result<ExportedImage> {
    let exported = ExportedImage::new_checkerboard(
        &instance.instance, &device.device, device.physical,
        device.queues.graphics, device.families.graphics, 256, 256,
    )?;
    info!("Exported image created, fd={}", exported.raw_fd());
    Ok(exported)
}

fn import_texture(bridge: &WgpuBridge, exported: &ExportedImage) -> Result<ImportedTexture> {
    let imported = ImportedTexture::from_dmabuf(
        bridge.device(), bridge.queue(), exported.raw_fd(),
        exported.extent.width, exported.extent.height, exported.format,
    )?;
    info!("Imported texture created");
    Ok(imported)
}