//! NITRATE — Volatile Memory
//!
//! Physics-based film simulation engine.

mod app;
mod gpu;

use anyhow::Result;
use app::NitrateApp;
use tracing::info;
use winit::event_loop::{ControlFlow, EventLoop};

fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter("nitrate=debug,wgpu=warn")
        .init();

    info!("NITRATE — Volatile Memory");

    // Create event loop
    let event_loop = EventLoop::new()?;
    event_loop.set_control_flow(ControlFlow::Poll);

    // Run application
    let mut app = NitrateApp::default();
    event_loop.run_app(&mut app)?;

    Ok(())
}