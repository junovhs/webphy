//! Vulkan logical device creation and management.

use super::extensions;
use super::queues::{find_queue_families, QueueFamilies};
use super::{OPTIONAL_DEVICE_EXTENSIONS, REQUIRED_DEVICE_EXTENSIONS};
use crate::error::{PalResult, VulkanError};
use crate::sync::SyncTier;
use crate::vulkan::VulkanInstance;
use ash::{khr, vk};
use std::ffi::CStr;
use tracing::{debug, info};

/// Vulkan device with associated queues and capabilities.
pub struct VulkanDevice {
    pub physical: vk::PhysicalDevice,
    pub device: ash::Device,
    pub queues: DeviceQueues,
    pub families: QueueFamilies,
    pub capabilities: DeviceCapabilities,
    pub swapchain_loader: khr::swapchain::Device,
}

/// Device queues extracted after creation.
pub struct DeviceQueues {
    pub graphics: vk::Queue,
    pub present: vk::Queue,
}

/// Runtime capability detection.
#[derive(Debug, Clone)]
pub struct DeviceCapabilities {
    pub sync_tier: SyncTier,
    pub has_timeline_semaphore: bool,
    pub has_external_memory: bool,
}

impl VulkanDevice {
    /// Creates device on best available physical device.
    pub fn new(instance: &VulkanInstance, surface: vk::SurfaceKHR) -> PalResult<Self> {
        let physical = select_physical_device(instance, surface)?;
        let families =
            find_queue_families(&instance.instance, physical, &instance.surface_loader, surface)
                .ok_or(VulkanError::DeviceCreation("No suitable queues".into()))?;

        let (device, enabled_exts) =
            create_logical_device(&instance.instance, physical, &families)?;
        let capabilities = detect_capabilities(&enabled_exts);

        info!("Sync tier: {:?}", capabilities.sync_tier);

        let queues = extract_queues(&device, families);
        let swapchain_loader = khr::swapchain::Device::new(&instance.instance, &device);

        Ok(Self {
            physical,
            device,
            queues,
            families,
            capabilities,
            swapchain_loader,
        })
    }

    pub fn raw(&self) -> &ash::Device {
        &self.device
    }
}

impl Drop for VulkanDevice {
    fn drop(&mut self) {
        // SAFETY: We own the device and are shutting down.
        // Waiting for idle ensures no operations are pending during destruction.
        unsafe {
            self.device.device_wait_idle().ok();
            self.device.destroy_device(None);
        }
        debug!("Vulkan device destroyed");
    }
}

fn select_physical_device(
    instance: &VulkanInstance,
    surface: vk::SurfaceKHR,
) -> PalResult<vk::PhysicalDevice> {
    // SAFETY: instance is valid, enumerate_physical_devices is safe.
    let devices = unsafe { instance.instance.enumerate_physical_devices() }
        .map_err(VulkanError::Api)?;

    devices
        .into_iter()
        .find(|&pd| is_device_suitable(instance, pd, surface))
        .ok_or_else(|| VulkanError::DeviceCreation("No suitable GPU".into()).into())
}

/// Pure logic check for device suitability.
/// Extracted to allow unit testing without a real GPU.
fn check_device_suitability(
    has_queues: bool,
    available_extensions: &[vk::ExtensionProperties],
    required_extensions: &[&'static CStr],
) -> bool {
    if !has_queues {
        return false;
    }
    extensions::check_required(available_extensions, required_extensions).is_ok()
}

fn is_device_suitable(
    instance: &VulkanInstance,
    physical: vk::PhysicalDevice,
    surface: vk::SurfaceKHR,
) -> bool {
    let has_queues = find_queue_families(
        &instance.instance,
        physical,
        &instance.surface_loader,
        surface,
    )
    .is_some();

    // SAFETY: instance and physical device are valid.
    let extensions = unsafe {
        instance
            .instance
            .enumerate_device_extension_properties(physical)
    }
    .unwrap_or_default();

    check_device_suitability(has_queues, &extensions, REQUIRED_DEVICE_EXTENSIONS)
}

fn create_logical_device(
    instance: &ash::Instance,
    physical: vk::PhysicalDevice,
    families: &QueueFamilies,
) -> PalResult<(ash::Device, Vec<&'static CStr>)> {
    // SAFETY: instance and physical are valid.
    let available = unsafe { instance.enumerate_device_extension_properties(physical) }
        .map_err(VulkanError::Api)?;

    let mut ext_ptrs: Vec<_> = REQUIRED_DEVICE_EXTENSIONS
        .iter()
        .map(|e| e.as_ptr())
        .collect();
    let optional_available = extensions::filter_supported(&available, OPTIONAL_DEVICE_EXTENSIONS);
    ext_ptrs.extend(&optional_available);

    let all_requested: Vec<&'static CStr> = REQUIRED_DEVICE_EXTENSIONS
        .iter()
        .chain(OPTIONAL_DEVICE_EXTENSIONS.iter())
        .copied()
        .collect();
    let enabled_names = extensions::find_enabled(&available, &all_requested);

    for name in &enabled_names {
        debug!("Device extension: {:?}", name);
    }

    let queue_priorities = [1.0f32];
    let queue_infos: Vec<_> = families
        .unique_indices()
        .iter()
        .map(|&idx| {
            vk::DeviceQueueCreateInfo::default()
                .queue_family_index(idx)
                .queue_priorities(&queue_priorities)
        })
        .collect();

    let mut timeline =
        vk::PhysicalDeviceTimelineSemaphoreFeatures::default().timeline_semaphore(true);
    let mut features2 = vk::PhysicalDeviceFeatures2::default().push_next(&mut timeline);

    let create_info = vk::DeviceCreateInfo::default()
        .queue_create_infos(&queue_infos)
        .enabled_extension_names(&ext_ptrs)
        .push_next(&mut features2);

    // SAFETY: all parameters are valid, pNext chain is properly constructed.
    let device = unsafe { instance.create_device(physical, &create_info, None) }
        .map_err(VulkanError::Api)?;

    Ok((device, enabled_names))
}

fn detect_capabilities(extensions: &[&CStr]) -> DeviceCapabilities {
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

fn extract_queues(device: &ash::Device, families: QueueFamilies) -> DeviceQueues {
    // SAFETY: device is valid, queue indices are valid from creation.
    let graphics = unsafe { device.get_device_queue(families.graphics, 0) };
    // SAFETY: device is valid, queue indices are valid from creation.
    let present = unsafe { device.get_device_queue(families.present, 0) };
    DeviceQueues { graphics, present }
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