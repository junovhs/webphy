//! NITRATE Core - Shared types and error handling
//!
//! This crate provides the foundational types used across all nitrate crates.

use arrayvec::ArrayVec;
use thiserror::Error;

/// Maximum number of frames in flight (triple buffering)
pub const MAX_FRAMES_IN_FLIGHT: usize = 3;

/// Maximum planes per video surface (NV12 = 2, I420 = 3)
pub const MAX_PLANES: usize = 4;

/// Maximum DMA-BUF objects per surface
pub const MAX_DMABUF_OBJECTS: usize = 4;

// ============================================================================
// Error Types
// ============================================================================

#[derive(Debug, Error)]
pub enum Error {
    #[error("Platform not supported: {0}")]
    PlatformNotSupported(String),

    #[error("Device creation failed: {0}")]
    DeviceCreation(String),

    #[error("Surface import failed: {0}")]
    SurfaceImport(String),

    #[error("Sync operation failed: {0}")]
    SyncFailed(String),

    #[error("Decode error: {0}")]
    Decode(String),

    #[error("Resource exhausted: {0}")]
    ResourceExhausted(String),
}

pub type Result<T> = std::result::Result<T, Error>;

// ============================================================================
// Frame Identification
// ============================================================================

/// Monotonically increasing frame identifier
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FrameId(pub u64);

impl FrameId {
    pub const INVALID: Self = Self(0);

    #[must_use]
    pub fn next(self) -> Self {
        Self(self.0.saturating_add(1))
    }

    #[must_use]
    pub fn is_valid(self) -> bool {
        self.0 > 0
    }
}

impl Default for FrameId {
    fn default() -> Self {
        Self::INVALID
    }
}

// ============================================================================
// Geometry
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Extent2D {
    pub width: u32,
    pub height: u32,
}

impl Extent2D {
    #[must_use]
    pub const fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    #[must_use]
    pub fn pixel_count(self) -> u64 {
        u64::from(self.width) * u64::from(self.height)
    }
}

// ============================================================================
// Pixel Formats
// ============================================================================

/// Video pixel formats we support
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    /// 8-bit 4:2:0, Y plane + interleaved UV plane
    Nv12,
    /// 10-bit 4:2:0, Y plane + interleaved UV plane (P010)
    P010,
    /// 8-bit 4:2:0, three separate planes (legacy)
    I420,
    /// 8-bit RGBA (UI, thumbnails)
    Rgba8,
    /// 16-bit float RGBA (HDR, compositing)
    Rgba16F,
}

impl PixelFormat {
    #[must_use]
    pub fn plane_count(self) -> usize {
        match self {
            Self::Nv12 | Self::P010 => 2,
            Self::I420 => 3,
            Self::Rgba8 | Self::Rgba16F => 1,
        }
    }

    #[must_use]
    pub fn is_yuv(self) -> bool {
        matches!(self, Self::Nv12 | Self::P010 | Self::I420)
    }

    #[must_use]
    pub fn bits_per_component(self) -> u8 {
        match self {
            Self::Nv12 | Self::I420 | Self::Rgba8 => 8,
            Self::P010 => 10,
            Self::Rgba16F => 16,
        }
    }
}

// ============================================================================
// Plane Description
// ============================================================================

/// Description of a single plane within a surface
#[derive(Debug, Clone, Copy)]
pub struct PlaneDesc {
    /// Index into the backing memory objects (for DMA-BUF)
    pub object_index: u32,
    /// Byte offset within the memory object
    pub offset: u64,
    /// Row stride in bytes
    pub stride: u32,
    /// Plane dimensions (may differ from surface for chroma planes)
    pub extent: Extent2D,
}

/// Collection of planes describing a complete surface
pub type PlaneArray = ArrayVec<PlaneDesc, MAX_PLANES>;

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_id_increment() {
        let f = FrameId(1);
        assert_eq!(f.next(), FrameId(2));
    }

    #[test]
    fn frame_id_validity() {
        assert!(!FrameId::INVALID.is_valid());
        assert!(FrameId(1).is_valid());
    }

    #[test]
    fn pixel_format_plane_counts() {
        assert_eq!(PixelFormat::Nv12.plane_count(), 2);
        assert_eq!(PixelFormat::I420.plane_count(), 3);
        assert_eq!(PixelFormat::Rgba8.plane_count(), 1);
    }

    #[test]
    fn extent_pixel_count() {
        let e = Extent2D::new(1920, 1080);
        assert_eq!(e.pixel_count(), 2_073_600);
    }
}
