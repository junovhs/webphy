//! Integration tests for Vulkan backend.
//!
//! These tests require a Vulkan-capable GPU.
//! Run with: cargo test --package nitrate-pal -- --ignored

use nitrate_pal::SyncTier;

/// Test sync tier detection logic.
#[test]
fn sync_tier_descriptions() {
    assert_eq!(SyncTier::TierA.description(), "Timeline Semaphores (GPU-GPU sync)");
    assert_eq!(SyncTier::TierB.description(), "Resource-based sync (sync_file/keyed mutex)");
    assert_eq!(SyncTier::TierC.description(), "CPU-coordinated fallback");
}

/// Test sync tier CPU blocking detection.
#[test]
fn sync_tier_cpu_blocking() {
    assert!(!SyncTier::TierA.has_cpu_blocking());
    assert!(!SyncTier::TierB.has_cpu_blocking());
    assert!(SyncTier::TierC.has_cpu_blocking());
}

/// Test color metadata defaults.
#[test]
fn color_metadata_defaults() {
    use nitrate_pal::surface::*;

    let meta = ColorMetadata::default();
    assert_eq!(meta.primaries, ColorPrimaries::Bt709);
    assert_eq!(meta.transfer, TransferFunction::Srgb);
    assert_eq!(meta.matrix, MatrixCoefficients::Bt709);
    assert!(!meta.full_range);
    assert!((meta.max_luminance - 100.0).abs() < f32::EPSILON);
}

/// Test plane descriptor defaults.
#[test]
fn plane_descriptor_defaults() {
    use nitrate_pal::PlaneDescriptor;

    let plane = PlaneDescriptor::default();
    assert_eq!(plane.offset, 0);
    assert_eq!(plane.stride, 0);
    assert_eq!(plane.width, 0);
    assert_eq!(plane.height, 0);
}
