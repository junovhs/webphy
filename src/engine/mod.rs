mod context;
mod render;

use anyhow::Result;
use context::GpuContext;
use tracing::{debug, info};
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowId};

const WINDOW_TITLE: &str = "NITRATE — Volatile Memory";
const WINDOW_WIDTH: u32 = 1280;
const WINDOW_HEIGHT: u32 = 800;

pub struct Engine {
    event_loop: EventLoop<()>,
}

struct App {
    window: Option<Window>,
    gpu: Option<GpuContext>,
}

impl Engine {
    pub async fn new() -> Result<Self> {
        let event_loop = EventLoop::new()?;
        event_loop.set_control_flow(ControlFlow::Wait);
        Ok(Self { event_loop })
    }

    pub fn run(self) -> Result<()> {
        let mut app = App {
            window: None,
            gpu: None,
        };
        self.event_loop.run_app(&mut app)?;
        Ok(())
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }

        let size = LogicalSize::new(WINDOW_WIDTH, WINDOW_HEIGHT);
        let attrs = Window::default_attributes()
            .with_title(WINDOW_TITLE)
            .with_inner_size(size);

        match event_loop.create_window(attrs) {
            Ok(window) => {
                info!("Window created");
                match pollster::block_on(GpuContext::new(&window)) {
                    Ok(gpu) => {
                        info!("GPU context initialized");
                        self.gpu = Some(gpu);
                    }
                    Err(e) => tracing::error!("GPU init failed: {e}"),
                }
                self.window = Some(window);
            }
            Err(e) => tracing::error!("Window creation failed: {e}"),
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                debug!("Close requested");
                event_loop.exit();
            }
            WindowEvent::Resized(new_size) => {
                if let Some(gpu) = &mut self.gpu {
                    gpu.resize(new_size.width, new_size.height);
                }
            }
            WindowEvent::RedrawRequested => {
                if let Some(gpu) = &self.gpu {
                    if let Err(e) = render::draw_frame(gpu) {
                        tracing::error!("Render error: {e}");
                    }
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(window) = &self.window {
            window.request_redraw();
        }
    }
}
