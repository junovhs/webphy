//! Device capability detection and suitability checking.
//!
//! Extracted from `device.rs` to enforce separation of concerns and reduce file size.

use super::extensions;
use crate::sync::SyncTier;
use ash::vk;
use std::ffi::CStr;

/// Runtime capability detection.
#[derive(Debug, Clone)]
pub struct DeviceCapabilities {
    pub sync_tier: SyncTier,
    pub has_timeline_semaphore: bool,
    pub has_external_memory: bool,
}

/// Pure logic check for device suitability.
pub fn check_device_suitability(
    has_queues: bool,
    available_extensions: &[vk::ExtensionProperties],
    required_extensions: &[&'static CStr],
) -> bool {
    if !has_queues {
        return false;
    }
    extensions::check_required(available_extensions, required_extensions).is_ok()
}

/// Detects optional capabilities and assigns a `SyncTier`.
pub fn detect_capabilities(extensions: &[&CStr]) -> DeviceCapabilities {
    let has_timeline = extensions
        .iter()
        .any(|e| e.to_string_lossy().contains("timeline_semaphore"));
    let has_external = extensions
        .iter()
        .any(|e| e.to_string_lossy().contains("external_memory"));

    let sync_tier = if has_timeline {
        SyncTier::TierA
    } else if has_external {
        SyncTier::TierB
    } else {
        SyncTier::TierC
    };

    DeviceCapabilities {
        sync_tier,
        has_timeline_semaphore: has_timeline,
        has_external_memory: has_external,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use std::ffi::CString;

    // Helper to create extension property
    fn make_ext(name: &str) -> vk::ExtensionProperties {
        let mut prop = vk::ExtensionProperties::default();
        let c_name = CString::new(name).unwrap();
        let bytes = c_name.as_bytes_with_nul();
        let len = bytes.len().min(prop.extension_name.len() - 1);
        // SAFETY: We are copying into a fixed-size C-style array and manually
        // ensuring null termination. The destination buffer is owned by the struct.
        unsafe {
            std::ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                prop.extension_name.as_mut_ptr().cast(),
                len,
            );
            prop.extension_name[len] = 0;
        }
        prop
    }

    #[test]
    fn test_device_suitability_ok() {
        let exts = vec![make_ext("VK_KHR_swapchain")];
        let req = CString::new("VK_KHR_swapchain").unwrap();
        // Leak to get 'static lifetime for tests
        let req_ref = Box::leak(req.into_boxed_c_str());

        assert!(check_device_suitability(true, &exts, &[req_ref]));
    }

    #[test]
    fn test_device_suitability_no_queues() {
        let exts = vec![make_ext("VK_KHR_swapchain")];
        let req = CString::new("VK_KHR_swapchain").unwrap();
        let req_ref = Box::leak(req.into_boxed_c_str());

        assert!(!check_device_suitability(false, &exts, &[req_ref]));
    }

    #[test]
    fn test_device_suitability_missing_ext() {
        let exts = vec![make_ext("VK_OTHER_EXTENSION")];
        let req = CString::new("VK_KHR_swapchain").unwrap();
        let req_ref = Box::leak(req.into_boxed_c_str());

        assert!(!check_device_suitability(true, &exts, &[req_ref]));
    }

    #[test]
    fn test_detect_capabilities() {
        let timeline = CString::new("VK_KHR_timeline_semaphore").unwrap();
        let external = CString::new("VK_KHR_external_memory_fd").unwrap();

        // Explicitly annotate as static reference to avoid move errors
        let timeline_ref: &'static CStr = Box::leak(timeline.into_boxed_c_str());
        let external_ref: &'static CStr = Box::leak(external.into_boxed_c_str());

        let cap_a = detect_capabilities(&[timeline_ref]);
        assert_eq!(cap_a.sync_tier, SyncTier::TierA);

        let cap_b = detect_capabilities(&[external_ref]);
        assert_eq!(cap_b.sync_tier, SyncTier::TierB);

        let cap_c = detect_capabilities(&[]);
        assert_eq!(cap_c.sync_tier, SyncTier::TierC);
    }
}