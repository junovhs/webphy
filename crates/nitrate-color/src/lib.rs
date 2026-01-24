//! NITRATE Color - Color space transforms and tone mapping
//!
//! Provides:
//! - YUV→RGB matrices (BT.709, BT.2020)
//! - Transfer functions (EOTF/OETF for gamma, PQ, HLG)
//! - HDR→SDR tone mapping
//! - Gamut mapping (BT.2020→BT.709)

use bytemuck::{Pod, Zeroable};

/// YUV→RGB conversion matrix (column-major for GLSL/WGSL)
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct YuvMatrix {
    pub col0: [f32; 4],
    pub col1: [f32; 4],
    pub col2: [f32; 4],
}

impl YuvMatrix {
    /// BT.709 limited range
    pub const BT709_LIMITED: Self = Self {
        col0: [1.164, 1.164, 1.164, 0.0],
        col1: [0.0, -0.213, 2.112, 0.0],
        col2: [1.793, -0.533, 0.0, 0.0],
    };

    /// BT.709 full range
    pub const BT709_FULL: Self = Self {
        col0: [1.0, 1.0, 1.0, 0.0],
        col1: [0.0, -0.187, 1.856, 0.0],
        col2: [1.575, -0.468, 0.0, 0.0],
    };

    /// BT.2020 limited range (for HDR content)
    pub const BT2020_LIMITED: Self = Self {
        col0: [1.164, 1.164, 1.164, 0.0],
        col1: [0.0, -0.187, 2.142, 0.0],
        col2: [1.679, -0.650, 0.0, 0.0],
    };
}

/// YUV offset for limited/full range
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct YuvOffset {
    pub y: f32,
    pub u: f32,
    pub v: f32,
    _pad: f32,
}

impl YuvOffset {
    /// 8-bit limited range: Y in [16, 235], UV in [16, 240]
    pub const LIMITED_8BIT: Self = Self {
        y: 16.0 / 255.0,
        u: 128.0 / 255.0,
        v: 128.0 / 255.0,
        _pad: 0.0,
    };

    /// 8-bit full range
    pub const FULL_8BIT: Self = Self {
        y: 0.0,
        u: 128.0 / 255.0,
        v: 128.0 / 255.0,
        _pad: 0.0,
    };

    /// 10-bit limited range
    pub const LIMITED_10BIT: Self = Self {
        y: 64.0 / 1023.0,
        u: 512.0 / 1023.0,
        v: 512.0 / 1023.0,
        _pad: 0.0,
    };
}

/// Transfer function type for shader selection
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum TransferFunctionId {
    /// Standard BT.709 gamma (~2.4)
    Bt709 = 0,
    /// sRGB gamma (~2.2 with linear toe)
    Srgb = 1,
    /// PQ (SMPTE ST 2084) for HDR10
    Pq = 2,
    /// HLG (ARIB STD-B67)
    Hlg = 3,
    /// Linear (no transfer)
    Linear = 4,
}

/// Tone mapping mode
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum TonemapMode {
    /// No tone mapping (passthrough)
    None = 0,
    /// Simple Reinhard
    Reinhard = 1,
    /// ACES filmic
    Aces = 2,
    /// BT.2390 EETF (broadcast standard)
    Bt2390 = 3,
}

/// Color parameters for GPU uniform buffer
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct ColorUniforms {
    pub yuv_matrix: YuvMatrix,
    pub yuv_offset: YuvOffset,
    pub transfer_in: u32,
    pub transfer_out: u32,
    pub tonemap_mode: u32,
    pub src_max_lum: f32,
    pub dst_max_lum: f32,
    _pad: [f32; 3],
}

impl Default for ColorUniforms {
    fn default() -> Self {
        Self {
            yuv_matrix: YuvMatrix::BT709_LIMITED,
            yuv_offset: YuvOffset::LIMITED_8BIT,
            transfer_in: TransferFunctionId::Bt709 as u32,
            transfer_out: TransferFunctionId::Srgb as u32,
            tonemap_mode: TonemapMode::None as u32,
            src_max_lum: 100.0,
            dst_max_lum: 100.0,
            _pad: [0.0; 3],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_uniforms_size() {
        // Must be 16-byte aligned for GPU
        assert_eq!(std::mem::size_of::<ColorUniforms>() % 16, 0);
    }

    #[test]
    fn yuv_matrix_size() {
        assert_eq!(std::mem::size_of::<YuvMatrix>(), 48);
    }
}