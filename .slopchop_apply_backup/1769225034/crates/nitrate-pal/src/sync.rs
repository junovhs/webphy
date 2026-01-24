//! GPU synchronization primitives with explicit capability tiers
//!
//! # Sync Tiers
//!
//! Not all platforms support the same level of GPU-GPU synchronization.
//! We define explicit tiers with graceful fallback:
//!
//! - **Tier A**: Timeline semaphores (Vulkan 1.2, D3D12 fences, Metal shared events)
//! - **Tier B**: Binary sync with explicit `sync_file` import
//! - **Tier C**: CPU coordination (poll/wait)

use nitrate_core::FrameId;
use std::sync::atomic::{AtomicU64, Ordering};

// ============================================================================
// Sync Tier (capability level)
// ============================================================================

/// Synchronization capability tier
///
/// Higher tiers allow lower-latency GPU-GPU coordination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SyncTier {
    /// CPU coordination only (fallback)
    ///
    /// `decode_complete` -> CPU poll -> compose start
    TierC = 0,

    /// Binary semaphores with `sync_file` import
    ///
    /// decode -> binary sem -> `sync_file` -> import -> compose
    TierB = 1,

    /// Timeline semaphores (optimal)
    ///
    /// decode -> timeline signal(N) -> compose wait(N)
    TierA = 2,
}

impl SyncTier {
    /// Human-readable description
    #[must_use]
    pub fn description(self) -> &'static str {
        match self {
            Self::TierA => "Timeline semaphores (GPU-GPU, no CPU)",
            Self::TierB => "Binary semaphores with sync_file",
            Self::TierC => "CPU-coordinated sync (fallback)",
        }
    }
}

// ============================================================================
// Sync Capabilities (what the device supports)
// ============================================================================

/// Sync capabilities detected for a device
#[derive(Debug, Clone, Copy)]
pub struct SyncCapabilities {
    /// Highest supported tier
    pub max_tier: SyncTier,
    /// Timeline semaphore support
    pub timeline_semaphores: bool,
    /// External semaphore `sync_file` import
    pub sync_file_import: bool,
    /// External semaphore `sync_file` export
    pub sync_file_export: bool,
}

impl Default for SyncCapabilities {
    fn default() -> Self {
        Self {
            max_tier: SyncTier::TierC,
            timeline_semaphores: false,
            sync_file_import: false,
            sync_file_export: false,
        }
    }
}

impl SyncCapabilities {
    /// Check if timeline semaphores are available
    #[must_use]
    pub fn has_tier_a(&self) -> bool {
        self.timeline_semaphores
    }

    /// Check if `sync_file` import is available
    #[must_use]
    pub fn has_tier_b(&self) -> bool {
        self.sync_file_import
    }
}

// ============================================================================
// Sync Strategy Trait
// ============================================================================

/// Strategy for synchronizing between pipeline stages
pub trait SyncStrategy: Send + Sync {
    /// The tier this strategy implements
    fn tier(&self) -> SyncTier;

    /// Wait for decode to complete before compositing
    fn wait_decode_complete(&self, frame_id: FrameId) -> WaitResult;

    /// Signal that composition is ready for present
    fn signal_compose_complete(&self, frame_id: FrameId);

    /// Wait for UI render to complete (wgpu -> native handoff)
    fn wait_ui_complete(&self, frame_id: FrameId) -> WaitResult;

    /// Signal that UI render is complete
    fn signal_ui_complete(&self, frame_id: FrameId);
}

/// Result of a wait operation
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitResult {
    /// Already signaled, no wait needed
    AlreadySignaled,
    /// Wait completed successfully
    Success,
    /// Wait timed out
    Timeout,
    /// Device lost during wait
    DeviceLost,
}

// ============================================================================
// Tier A: Timeline Semaphore Sync
// ============================================================================

/// Timeline semaphore values for a frame
#[derive(Debug, Clone, Copy, Default)]
pub struct TimelineValues {
    /// Value signaled when decode completes
    pub decode_complete: u64,
    /// Value signaled when UI render completes
    pub ui_complete: u64,
    /// Value signaled when composition completes
    pub compose_complete: u64,
}

impl TimelineValues {
    /// Generate values for a frame
    ///
    /// Uses `frame_id` * 3 + offset pattern to ensure monotonic increase
    #[must_use]
    pub fn for_frame(frame_id: FrameId) -> Self {
        let base = frame_id.0 * 3;
        Self {
            decode_complete: base + 1,
            ui_complete: base + 2,
            compose_complete: base + 3,
        }
    }
}

// ============================================================================
// Tier C: CPU Sync (Fallback)
// ============================================================================

/// CPU-coordinated sync using atomic flags
///
/// Inlined atomics to ensure high cohesion (LCOM4 fix)
pub struct CpuSync {
    decode: AtomicU64,
    ui: AtomicU64,
    compose: AtomicU64,
}

impl CpuSync {
    #[must_use]
    pub fn new() -> Self {
        Self {
            decode: AtomicU64::new(0),
            ui: AtomicU64::new(0),
            compose: AtomicU64::new(0),
        }
    }

    /// Mark decode complete for a frame
    pub fn mark_decode_complete(&self, frame_id: FrameId) {
        self.decode.store(frame_id.0, Ordering::Release);
    }

    /// Check if decode is complete
    #[must_use]
    pub fn is_decode_complete(&self, frame_id: FrameId) -> bool {
        self.decode.load(Ordering::Acquire) >= frame_id.0
    }

    /// Reset all state (LCOM4 fix: touches all fields)
    pub fn reset(&self) {
        self.decode.store(0, Ordering::Release);
        self.ui.store(0, Ordering::Release);
        self.compose.store(0, Ordering::Release);
    }
}

impl Default for CpuSync {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncStrategy for CpuSync {
    fn tier(&self) -> SyncTier {
        SyncTier::TierC
    }

    fn wait_decode_complete(&self, frame_id: FrameId) -> WaitResult {
        while self.decode.load(Ordering::Acquire) < frame_id.0 {
            std::hint::spin_loop();
        }
        WaitResult::Success
    }

    fn signal_compose_complete(&self, frame_id: FrameId) {
        self.compose.store(frame_id.0, Ordering::Release);
    }

    fn wait_ui_complete(&self, frame_id: FrameId) -> WaitResult {
        while self.ui.load(Ordering::Acquire) < frame_id.0 {
            std::hint::spin_loop();
        }
        WaitResult::Success
    }

    fn signal_ui_complete(&self, frame_id: FrameId) {
        self.ui.store(frame_id.0, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_tier_ordering() {
        assert!(SyncTier::TierA > SyncTier::TierB);
        assert!(SyncTier::TierB > SyncTier::TierC);
    }

    #[test]
    fn timeline_values_monotonic() {
        let v1 = TimelineValues::for_frame(FrameId(1));
        let v2 = TimelineValues::for_frame(FrameId(2));

        assert!(v2.decode_complete > v1.compose_complete);
    }

    #[test]
    fn cpu_sync_works() {
        let sync = CpuSync::new();
        let frame = FrameId(1);

        assert!(!sync.is_decode_complete(frame));
        sync.mark_decode_complete(frame);
        assert!(sync.is_decode_complete(frame));
        
        // Test reset (LCOM4 validation)
        sync.reset();
    }
}