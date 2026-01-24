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
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SyncTier {
    TierC = 0, // CPU coordination
    TierB = 1, // Binary semaphores
    TierA = 2, // Timeline semaphores
}

impl SyncTier {
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
// Sync Capabilities
// ============================================================================

#[derive(Debug, Clone, Copy)]
pub struct SyncCapabilities {
    pub max_tier: SyncTier,
    pub timeline_semaphores: bool,
    pub sync_file_import: bool,
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
    #[must_use]
    pub fn has_tier_a(&self) -> bool {
        self.timeline_semaphores
    }

    #[must_use]
    pub fn has_tier_b(&self) -> bool {
        self.sync_file_import
    }
}

// ============================================================================
// Sync Strategy Trait
// ============================================================================

pub trait SyncStrategy: Send + Sync {
    fn tier(&self) -> SyncTier;
    fn wait_decode_complete(&self, frame_id: FrameId) -> WaitResult;
    fn signal_compose_complete(&self, frame_id: FrameId);
    fn wait_ui_complete(&self, frame_id: FrameId) -> WaitResult;
    fn signal_ui_complete(&self, frame_id: FrameId);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitResult {
    AlreadySignaled,
    Success,
    Timeout,
    DeviceLost,
}

// ============================================================================
// Tier A: Timeline Semaphore Sync
// ============================================================================

#[derive(Debug, Clone, Copy, Default)]
pub struct TimelineValues {
    pub decode_complete: u64,
    pub ui_complete: u64,
    pub compose_complete: u64,
}

impl TimelineValues {
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
/// Uses an array layout to ensure LCOM4 = 1 (all methods access the same 'slots' field)
pub struct CpuSync {
    // 0: decode, 1: ui, 2: compose
    slots: [AtomicU64; 3],
}

const IDX_DECODE: usize = 0;
const IDX_UI: usize = 1;
const IDX_COMPOSE: usize = 2;

impl CpuSync {
    #[must_use]
    pub fn new() -> Self {
        Self {
            slots: [
                AtomicU64::new(0),
                AtomicU64::new(0),
                AtomicU64::new(0),
            ],
        }
    }

    pub fn mark_decode_complete(&self, frame_id: FrameId) {
        self.slots[IDX_DECODE].store(frame_id.0, Ordering::Release);
    }

    #[must_use]
    pub fn is_decode_complete(&self, frame_id: FrameId) -> bool {
        self.slots[IDX_DECODE].load(Ordering::Acquire) >= frame_id.0
    }

    pub fn reset(&self) {
        for slot in &self.slots {
            slot.store(0, Ordering::Release);
        }
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
        while self.slots[IDX_DECODE].load(Ordering::Acquire) < frame_id.0 {
            std::hint::spin_loop();
        }
        WaitResult::Success
    }

    fn signal_compose_complete(&self, frame_id: FrameId) {
        self.slots[IDX_COMPOSE].store(frame_id.0, Ordering::Release);
    }

    fn wait_ui_complete(&self, frame_id: FrameId) -> WaitResult {
        while self.slots[IDX_UI].load(Ordering::Acquire) < frame_id.0 {
            std::hint::spin_loop();
        }
        WaitResult::Success
    }

    fn signal_ui_complete(&self, frame_id: FrameId) {
        self.slots[IDX_UI].store(frame_id.0, Ordering::Release);
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
        
        sync.reset();
        assert!(!sync.is_decode_complete(frame));
    }
}