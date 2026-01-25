//! The Presentation subsystem (formerly Swapchain).
//!
//! Handles the display of rendered images to the screen.

mod engine;
mod images;
mod sync;

pub use engine::{AcquiredFrame, PresentationConfig, PresentationEngine};