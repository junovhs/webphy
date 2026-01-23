#![allow(non_snake_case)]

mod engine;

use anyhow::Result;
use engine::Engine;
use tracing::info;

fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter("nitrate=debug,wgpu=warn")
        .init();

    info!("NITRATE — Volatile Memory");
    info!("Initializing engine...");

    // Run the engine (blocks until window closes)
    pollster::block_on(run())
}

async fn run() -> Result<()> {
    let engine = Engine::new().await?;
    engine.run()
}
