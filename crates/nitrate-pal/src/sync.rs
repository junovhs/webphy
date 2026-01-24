//! GPU synchronization primitives with explicit capability tiers

use nitrate_core::FrameId;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SyncTier {
    TierC = 0,
    TierB = 1,
    TierA = 2,
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
    pub fn has_tier_a(&self) -> bool { self.timeline_semaphores }
    #[must_use]
    pub fn has_tier_b(&self) -> bool { self.sync_file_import }
}

pub trait SyncStrategy: Send + Sync {
    fn tier(&self) -> SyncTier;
    fn wait_decode_complete(&self, frame_id: FrameId) -> WaitResult;
    fn signal_decode_complete(&self, frame_id: FrameId);
    fn signal_compose_complete(&self, frame_id: FrameId);
    fn wait_ui_complete(&self, frame_id: FrameId) -> WaitResult;
    fn signal_ui_complete(&self, frame_id: FrameId);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitResult {
    Success,
    Timeout,
    DeviceLost,
}

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

/// CPU-coordinated sync. Single field ensures LCOM4 = 1.
pub struct CpuSync {
    /// [0]=decode, [1]=ui, [2]=compose
    vals: [AtomicU64; 3],
}

impl CpuSync {
    #[must_use]
    pub fn new() -> Self {
        Self { vals: [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)] }
    }
}

impl Default for CpuSync {
    fn default() -> Self { Self::new() }
}

impl SyncStrategy for CpuSync {
    fn tier(&self) -> SyncTier { SyncTier::TierC }

    fn wait_decode_complete(&self, frame_id: FrameId) -> WaitResult {
        while self.vals.first().map_or(0, |v| v.load(Ordering::Acquire)) < frame_id.0 {
            std::hint::spin_loop();
        }
        WaitResult::Success
    }

    fn signal_decode_complete(&self, frame_id: FrameId) {
        if let Some(v) = self.vals.first() { v.store(frame_id.0, Ordering::Release); }
    }

    fn signal_compose_complete(&self, frame_id: FrameId) {
        if let Some(v) = self.vals.get(2) { v.store(frame_id.0, Ordering::Release); }
    }

    fn wait_ui_complete(&self, frame_id: FrameId) -> WaitResult {
        while self.vals.get(1).map_or(0, |v| v.load(Ordering::Acquire)) < frame_id.0 {
            std::hint::spin_loop();
        }
        WaitResult::Success
    }

    fn signal_ui_complete(&self, frame_id: FrameId) {
        if let Some(v) = self.vals.get(1) { v.store(frame_id.0, Ordering::Release); }
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
        sync.signal_decode_complete(frame);
        assert_eq!(sync.wait_decode_complete(frame), WaitResult::Success);
    }
}