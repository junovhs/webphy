//! Imported surface types for video decoder interop.
//!
//! Defines the handoff structures between native video decoders
//! and the rendering pipeline.

use crate::sync::SyncHandle;
use arrayvec::ArrayVec;

/// Maximum number of planes in a video surface (Y, U, V or Y, UV).
pub const MAX_PLANES: usize = 3;

/// Descriptor for a single plane of a video surface.
#[derive(Debug, Clone, Copy, Default)]
pub struct PlaneDescriptor {
    /// Byte offset from start of buffer.
    pub offset: u64,
    /// Row stride in bytes.
    pub stride: u32,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
}

/// Color metadata parsed from video container.
#[derive(Debug, Clone, Copy)]
pub struct ColorMetadata {
    /// Color primaries (BT.709, BT.2020, etc).
    pub primaries: ColorPrimaries,
    /// Transfer function (SDR gamma, PQ, HLG).
    pub transfer: TransferFunction,
    /// YUV matrix coefficients.
    pub matrix: MatrixCoefficients,
    /// Full range vs limited range.
    pub full_range: bool,
    /// Mastering display max luminance (nits), for HDR.
    pub max_luminance: f32,
}

impl Default for ColorMetadata {
    fn default() -> Self {
        Self {
            primaries: ColorPrimaries::Bt709,
            transfer: TransferFunction::Srgb,
            matrix: MatrixCoefficients::Bt709,
            full_range: false,
            max_luminance: 100.0,
        }
    }
}

/// Color primaries (gamut).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ColorPrimaries {
    #[default]
    Bt709,
    Bt2020,
    DciP3,
}

/// Transfer function (EOTF).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TransferFunction {
    #[default]
    Srgb,
    Pq,
    Hlg,
}

/// YUV matrix coefficients.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MatrixCoefficients {
    #[default]
    Bt709,
    Bt2020Ncl,
    Bt2020Cl,
}

/// Platform-specific surface handle.
#[derive(Debug)]
pub enum SurfaceHandle {
    /// DMA-BUF file descriptor (Linux/VA-API).
    #[cfg(target_os = "linux")]
    DmaBuf {
        fd: std::os::unix::io::RawFd,
        modifier: u64,
        drm_format: u32,
    },
    /// Placeholder for platforms without DMA-BUF.
    #[cfg(not(target_os = "linux"))]
    Placeholder,
}

/// Imported surface from video decoder.
#[derive(Debug)]
pub struct ImportedSurface {
    /// Platform-specific handle.
    pub handle: SurfaceHandle,
    /// Plane layout descriptors.
    pub planes: ArrayVec<PlaneDescriptor, MAX_PLANES>,
    /// Color science metadata.
    pub color: ColorMetadata,
    /// Synchronization primitive.
    pub sync: SyncHandle,
}
