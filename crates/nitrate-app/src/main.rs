//! NITRATE — Volatile Memory
//!
//! Physics-based film simulation engine.
//!
//! This is the main application entry point.
//! For architecture validation, run `spike1` binary.

use tracing::info;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("nitrate=debug,wgpu=warn")
        .init();

    info!("NITRATE — Volatile Memory");
    info!("Main application not yet implemented.");
    info!("Run 'cargo run --bin spike1' to test the native host architecture.");
}