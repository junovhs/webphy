//! Synchronization primitives and tier selection.
//!
//! Defines the three-tier sync strategy:
//! - Tier A: Timeline semaphores (GPU-GPU, zero CPU blocking)
//! - Tier B: Resource-based (`sync_file`, keyed mutex)
//! - Tier C: CPU-coordinated fallback

/// Synchronization capability tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncTier {
    /// Timeline semaphores - best performance, zero CPU blocking.
    TierA,
    /// Resource-based sync (`sync_file` on Linux, keyed mutex on Windows).
    TierB,
    /// CPU-coordinated fallback - works everywhere but adds latency.
    TierC,
}

impl SyncTier {
    /// Returns human-readable description.
    #[must_use]
    pub const fn description(self) -> &'static str {
        match self {
            Self::TierA => "Timeline Semaphores (GPU-GPU sync)",
            Self::TierB => "Resource-based sync (sync_file/keyed mutex)",
            Self::TierC => "CPU-coordinated fallback",
        }
    }

    /// Returns whether this tier has CPU blocking in the hot path.
    #[must_use]
    pub const fn has_cpu_blocking(self) -> bool {
        matches!(self, Self::TierC)
    }
}

/// Platform-specific sync handle.
#[derive(Debug, Default)]
pub enum SyncHandle {
    /// No synchronization needed (already synchronized).
    #[default]
    None,
    /// Timeline semaphore value to wait on.
    Timeline { value: u64 },
    /// File descriptor for `sync_file` (Linux).
    #[cfg(target_os = "linux")]
    SyncFile { fd: std::os::unix::io::RawFd },
}
