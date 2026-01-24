//! Application logic and state management
//!
//! Decoupled from main entry point to reduce CBO/SFOUT.

use crate::gpu::GpuState;
use anyhow::Result;
use std::sync::Arc;
use tracing::{error, info};
use winit::{
    application::ApplicationHandler,
    event::WindowEvent,
    event_loop::ActiveEventLoop,
    window::{Window, WindowAttributes, WindowId},
};

/// Actions that the app session requests from the event loop
enum AppAction {
    Continue,
    Exit,
}

/// Encapsulates the active session state (Window + GPU)
struct AppSession {
    window: Arc<Window>,
    gpu: GpuState,
}

impl AppSession {
    fn new(event_loop: &ActiveEventLoop) -> Result<Self> {
        let attrs = WindowAttributes::default()
            .with_title("NITRATE — Volatile Memory")
            .with_inner_size(winit::dpi::LogicalSize::new(1280, 800))
            .with_min_inner_size(winit::dpi::LogicalSize::new(900, 600));

        let window = Arc::new(event_loop.create_window(attrs)?);
        info!("Window created");
        
        let gpu = pollster::block_on(GpuState::new(window.clone()))?;
        info!("GPU initialized");
        
        Ok(Self { window, gpu })
    }

    fn handle_event(&mut self, event: &WindowEvent) -> Result<AppAction> {
        match event {
            WindowEvent::CloseRequested => {
                info!("Close requested");
                return Ok(AppAction::Exit);
            }
            WindowEvent::Resized(size) => {
                self.gpu.resize(size.width, size.height);
            }
            WindowEvent::RedrawRequested => {
                self.gpu.render()?;
                self.window.request_redraw();
            }
            _ => {}
        }
        Ok(AppAction::Continue)
    }
}

#[derive(Default)]
pub struct NitrateApp {
    session: Option<AppSession>,
}

impl ApplicationHandler for NitrateApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.session.is_some() {
            return;
        }

        match AppSession::new(event_loop) {
            Ok(session) => self.session = Some(session),
            Err(e) => error!("Failed to initialize app session: {e}"),
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        if let Some(session) = &mut self.session {
            // Fix: Pass by reference to satisfy Clippy
            match session.handle_event(&event) {
                Ok(AppAction::Exit) => event_loop.exit(),
                Ok(AppAction::Continue) => {}
                Err(e) => error!("Window event error: {e}"),
            }
        }
    }
}