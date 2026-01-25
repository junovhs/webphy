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

        let (device, enabled_exts) = create_logical_device(&instance.instance, physical, &families)?;
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

fn is_device_suitable(
    instance: &VulkanInstance,
    physical: vk::PhysicalDevice,
    surface: vk::SurfaceKHR,
) -> bool {
    let has_queues =
        find_queue_families(&instance.instance, physical, &instance.surface_loader, surface).is_some();

    // SAFETY: instance and physical device are valid.
    let extensions = unsafe {
        instance.instance.enumerate_device_extension_properties(physical)
    }
    .unwrap_or_default();
    let has_extensions =
        extensions::check_required(&extensions, REQUIRED_DEVICE_EXTENSIONS).is_ok();

    has_queues && has_extensions
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