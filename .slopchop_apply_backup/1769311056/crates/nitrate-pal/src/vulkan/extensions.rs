//! Vulkan extension enumeration and filtering.

use ash::vk;
use std::collections::HashSet;
use std::ffi::CStr;

/// Extracts `CStr` from extension properties.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    // Helper to create dummy properties
    fn make_prop(name: &str) -> vk::ExtensionProperties {
        let mut prop = vk::ExtensionProperties::default();
        let c_name = CString::new(name).unwrap();
        let bytes = c_name.as_bytes_with_nul();
        // Copy bytes into the fixed-size array
        let len = bytes.len().min(prop.extension_name.len() - 1);
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
    fn test_filter_supported() {
        let available = vec![make_prop("VK_EXT_one"), make_prop("VK_EXT_two")];
        let ext_one = CString::new("VK_EXT_one").unwrap();
        let ext_three = CString::new("VK_EXT_three").unwrap();

        let requested = vec![ext_one.as_c_str(), ext_three.as_c_str()];
        let filtered = filter_supported(&available, &requested);

        assert_eq!(filtered.len(), 1);
    }

    #[test]
    fn test_check_required_success() {
        let available = vec![make_prop("VK_EXT_one"), make_prop("VK_EXT_two")];
        let ext_one = CString::new("VK_EXT_one").unwrap();
        // Leak to get 'static lifetime for test convenience (safe in tests)
        let ext_one_static: &'static CStr = Box::leak(ext_one.into_boxed_c_str());

        assert!(check_required(&available, &[ext_one_static]).is_ok());
    }

    #[test]
    fn test_check_required_missing() {
        let available = vec![make_prop("VK_EXT_one")];
        let ext_two = CString::new("VK_EXT_two").unwrap();
        let ext_two_static: &'static CStr = Box::leak(ext_two.into_boxed_c_str());

        assert!(check_required(&available, &[ext_two_static]).is_err());
    }

    #[test]
    fn test_find_enabled() {
        let available = vec![make_prop("VK_EXT_A"), make_prop("VK_EXT_B")];
        let ext_a = CString::new("VK_EXT_A").unwrap();
        let ext_c = CString::new("VK_EXT_C").unwrap();
        let ext_a_static = Box::leak(ext_a.into_boxed_c_str());
        let ext_c_static = Box::leak(ext_c.into_boxed_c_str());

        let enabled = find_enabled(&available, &[ext_a_static, ext_c_static]);
        assert_eq!(enabled, vec![ext_a_static]);
    }
}