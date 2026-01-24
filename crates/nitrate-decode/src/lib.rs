//! NITRATE Decode - Hardware video decoding
//!
//! Platform-specific hardware decode:
//! - Linux: VA-API
//! - Windows: Media Foundation
//! - macOS: `VideoToolbox`

use nitrate_core::{Extent2D, FrameId, PixelFormat, Result};
use nitrate_pal::ImportedSurface;

/// Video decoder trait
pub trait Decoder: Send {
    /// Decode a single frame
    fn decode_frame(&mut self, data: &[u8]) -> Result<DecodedFrame>;

    /// Get the current video dimensions
    fn dimensions(&self) -> Extent2D;

    /// Get the output pixel format
    fn pixel_format(&self) -> PixelFormat;

    /// Flush decoder (for seeking)
    fn flush(&mut self);
}

/// A decoded video frame ready for GPU import
pub struct DecodedFrame {
    /// Frame identifier
    pub frame_id: FrameId,
    /// Importable surface
    pub surface: ImportedSurface,
    /// Presentation timestamp (microseconds)
    pub pts: i64,
    /// Duration (microseconds)
    pub duration: i64,
}

/// Frame pool for decoded surfaces
pub struct FramePool {
    capacity: usize,
    // TODO: Actual pool implementation
}

impl FramePool {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self { capacity }
    }

    #[must_use]
    pub fn capacity(&self) -> usize {
        self.capacity
    }
}

#[cfg(target_os = "linux")]
pub mod vaapi {
    //! VA-API decoder implementation
    //! TODO: Implement using libva-rs or raw bindings
}

#[cfg(target_os = "windows")]
pub mod media_foundation {
    //! Media Foundation decoder implementation
    //! TODO: Implement using windows-rs
}

#[cfg(target_os = "macos")]
pub mod videotoolbox {
    //! VideoToolbox decoder implementation
    //! TODO: Implement using objc bindings
}