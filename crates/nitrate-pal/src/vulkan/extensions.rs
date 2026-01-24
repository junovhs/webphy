//! Vulkan extension enumeration and filtering.

use ash::vk;
use std::collections::HashSet;
use std::ffi::CStr;

/// Extracts CStr from extension properties.
fn ext_name(ext: &vk::ExtensionProperties) -> &CStr {
    // SAFETY: Vulkan spec guarantees null-terminated extension_name
    unsafe { CStr::from_ptr(ext.extension_name.as_ptr()) }
}

/// Filters requested extensions to only those available.
pub fn filter_supported(
    available: &[vk::ExtensionProperties],
    requested: &[&CStr],
) -> Vec<*const i8> {
    let available_set: HashSet<&CStr> = available.iter().map(ext_name).collect();

    requested
        .iter()
        .filter(|name| available_set.contains(*name))
        .map(|name| name.as_ptr())
        .collect()
}

/// Checks if all required extensions are present.
pub fn check_required(
    available: &[vk::ExtensionProperties],
    required: &[&'static CStr],
) -> Result<(), &'static CStr> {
    let available_set: HashSet<&CStr> = available.iter().map(ext_name).collect();

    for &name in required {
        if !available_set.contains(name) {
            return Err(name);
        }
    }
    Ok(())
}

/// Returns which of the check list extensions are available.
pub fn find_enabled(
    available: &[vk::ExtensionProperties],
    check: &[&'static CStr],
) -> Vec<&'static CStr> {
    let available_set: HashSet<&CStr> = available.iter().map(ext_name).collect();

    check
        .iter()
        .filter(|name| available_set.contains(*name))
        .copied()
        .collect()
}
