pub mod error;
pub mod surface;
pub mod sync;

#[cfg(feature = "vulkan")]
pub mod vulkan;

pub use error::{PalError, PalResult};
pub use surface::{ColorMetadata, ImportedSurface, PlaneDescriptor};
pub use sync::{SyncHandle, SyncTier};

#[cfg(feature = "vulkan")]
pub use vulkan::{
    AcquiredFrame, PresentationConfig, PresentationEngine, VulkanDevice, VulkanInstance, WgpuBridge,
};
