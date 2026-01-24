//! Surface types for cross-process GPU resource sharing

use arrayvec::ArrayVec;
use nitrate_core::{Extent2D, PixelFormat, PlaneDesc, MAX_DMABUF_OBJECTS, MAX_PLANES};

#[cfg(target_os = "linux")]
use std::os::unix::io::OwnedFd;

// ============================================================================
// Surface Handle (platform-specific resource identifier)
// ============================================================================

/// Platform-specific handle to a GPU surface
#[derive(Debug)]
pub enum SurfaceHandle {
    /// Linux DMA-BUF with full descriptor
    #[cfg(target_os = "linux")]
    DmaBuf(DmaBufDescriptor),

    /// Windows shared handle (HANDLE from DXGI)
    #[cfg(target_os = "windows")]
    SharedHandle {
        handle: *mut std::ffi::c_void,
        size: u64,
    },

    /// macOS IOSurface
    #[cfg(target_os = "macos")]
    IoSurface {
        surface_id: u32,
    },

    /// Placeholder for unsupported platforms
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    Unsupported,
}

// ============================================================================
// DMA-BUF Descriptor (Linux)
// ============================================================================

/// Complete DMA-BUF surface descriptor
///
/// Matches kernel/libva PRIME2 semantics with support for:
/// - Multiple backing objects (file descriptors)
/// - Multiple layers (for array textures)
/// - Per-plane offset/stride within objects
#[cfg(target_os = "linux")]
#[derive(Debug)]
pub struct DmaBufDescriptor {
    /// Backing memory objects (file descriptors)
    pub objects: ArrayVec<DmaBufObject, MAX_DMABUF_OBJECTS>,
    /// Layers (typically 1)
    pub layers: ArrayVec<DmaBufLayer, 4>,
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
pub struct DmaBufObject {
    /// File descriptor (owned - closed on drop)
    pub fd: OwnedFd,
    /// Total size of this memory object
    pub size: u64,
    /// DRM format modifier
    pub modifier: u64,
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
pub struct DmaBufLayer {
    /// DRM fourcc format (e.g., `DRM_FORMAT_NV12`)
    pub drm_format: u32,
    /// Planes within this layer
    pub planes: ArrayVec<DmaBufPlane, MAX_PLANES>,
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy)]
pub struct DmaBufPlane {
    /// Index into objects array
    pub object_index: u32,
    /// Offset within the object (bytes)
    pub offset: u64,
    /// Row stride (bytes)
    pub stride: u32,
}

// ============================================================================
// Imported Surface (ready for GPU use)
// ============================================================================

/// A video/image surface imported into the compositor
///
/// This is the boundary object between decode and render pipelines.
#[derive(Debug)]
pub struct ImportedSurface {
    /// Platform-specific handle
    pub handle: SurfaceHandle,
    /// Dimensions
    pub extent: Extent2D,
    /// Pixel format
    pub format: PixelFormat,
    /// Plane descriptions
    pub planes: ArrayVec<PlaneDesc, MAX_PLANES>,
    /// Color metadata for correct conversion
    pub color: ColorMetadata,
}

// ============================================================================
// Color Metadata
// ============================================================================

/// Color space and transfer characteristics for correct YUV→RGB conversion
#[derive(Debug, Clone, Copy, Default)]
pub struct ColorMetadata {
    /// Color primaries (BT.709, BT.2020, etc.)
    pub primaries: ColorPrimaries,
    /// Transfer function (gamma, PQ, HLG)
    pub transfer: TransferFunction,
    /// Matrix coefficients for YUV→RGB
    pub matrix: MatrixCoefficients,
    /// Full or limited range
    pub range: ColorRange,
    /// Max luminance (nits) for HDR content
    pub max_luminance: f32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ColorPrimaries {
    #[default]
    Bt709,
    Bt2020,
    DciP3,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TransferFunction {
    #[default]
    Bt709,     // SDR gamma ~2.4
    Srgb,      // sRGB gamma ~2.2
    Pq,        // HDR10 Perceptual Quantizer
    Hlg,       // Hybrid Log-Gamma
    Linear,    // No transfer function
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MatrixCoefficients {
    #[default]
    Bt709,
    Bt2020Ncl,
    Bt2020Cl,
    Identity, // RGB, no matrix needed
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ColorRange {
    #[default]
    Limited, // 16-235 (8-bit) / 64-940 (10-bit)
    Full,    // 0-255 / 0-1023
}

impl ColorMetadata {
    /// SDR BT.709 (standard video)
    pub const BT709_LIMITED: Self = Self {
        primaries: ColorPrimaries::Bt709,
        transfer: TransferFunction::Bt709,
        matrix: MatrixCoefficients::Bt709,
        range: ColorRange::Limited,
        max_luminance: 100.0,
    };

    /// HDR10 BT.2020 PQ
    pub const BT2020_PQ: Self = Self {
        primaries: ColorPrimaries::Bt2020,
        transfer: TransferFunction::Pq,
        matrix: MatrixCoefficients::Bt2020Ncl,
        range: ColorRange::Limited,
        max_luminance: 1000.0,
    };
}