//! Internal helpers for Vulkan initialization
//!
//! Extracted to reduce complexity and file size.

use crate::{SyncCapabilities, SyncTier};
use ash::vk;
use nitrate_core::{Error, Result};
use std::ffi::CString;

pub fn create_instance(entry: &ash::Entry) -> Result<ash::Instance> {
    let app_name = CString::new("NITRATE").map_err(|_| Error::DeviceCreation("Invalid name".into()))?;
    let eng_name = CString::new("nitrate-pal").map_err(|_| Error::DeviceCreation("Invalid name".into()))?;

    let app_info = vk::ApplicationInfo::default()
        .application_name(&app_name)
        .application_version(vk::make_api_version(0, 0, 1, 0))
        .engine_name(&eng_name)
        .engine_version(vk::make_api_version(0, 0, 1, 0))
        .api_version(vk::API_VERSION_1_2);

    let instance_extensions = get_required_instance_extensions();

    let instance_info = vk::InstanceCreateInfo::default()
        .application_info(&app_info)
        .enabled_extension_names(&instance_extensions);

    // SAFETY: Creating instance with valid create info.
    unsafe { entry.create_instance(&instance_info, None) }
        .map_err(|e| Error::DeviceCreation(format!("Failed to create instance: {e}")))
}

pub fn pick_physical_device(instance: &ash::Instance) -> Result<vk::PhysicalDevice> {
    // SAFETY: Valid instance.
    let devices = unsafe { instance.enumerate_physical_devices() }
        .map_err(|e| Error::DeviceCreation(format!("Failed to enumerate devices: {e}")))?;

    let mut discrete = None;
    let mut integrated = None;

    for &device in &devices {
        // SAFETY: Valid instance and device handle.
        let props = unsafe { instance.get_physical_device_properties(device) };
        match props.device_type {
            vk::PhysicalDeviceType::DISCRETE_GPU => discrete = Some(device),
            vk::PhysicalDeviceType::INTEGRATED_GPU => integrated = Some(device),
            _ => {}
        }
    }

    discrete
        .or(integrated)
        .or(devices.first().copied())
        .ok_or_else(|| Error::DeviceCreation("No Vulkan device found".into()))
}

pub fn create_logical_device(
    instance: &ash::Instance,
    physical_device: vk::PhysicalDevice,
    queue_family: u32,
    sync_caps: SyncCapabilities,
) -> Result<(ash::Device, vk::Queue)> {
    let device_extensions = get_required_device_extensions(sync_caps);
    let queue_priorities = [1.0f32];
    
    let queue_info = vk::DeviceQueueCreateInfo::default()
        .queue_family_index(queue_family)
        .queue_priorities(&queue_priorities);
    let queue_infos = [queue_info];

    let mut timeline_features = vk::PhysicalDeviceTimelineSemaphoreFeatures::default()
        .timeline_semaphore(sync_caps.timeline_semaphores);

    let device_info = vk::DeviceCreateInfo::default()
        .queue_create_infos(&queue_infos)
        .enabled_extension_names(&device_extensions)
        .push_next(&mut timeline_features);

    // SAFETY: Creating logical device with valid info.
    let device = unsafe { instance.create_device(physical_device, &device_info, None) }
        .map_err(|e| Error::DeviceCreation(format!("Failed to create device: {e}")))?;

    // SAFETY: Getting device queue at known index 0.
    let queue = unsafe { device.get_device_queue(queue_family, 0) };

    Ok((device, queue))
}

pub fn find_queue_family(
    instance: &ash::Instance,
    physical_device: vk::PhysicalDevice,
) -> Result<u32> {
    // SAFETY: Valid instance and device.
    let queue_families = unsafe { instance.get_physical_device_queue_family_properties(physical_device) };

    for (i, props) in queue_families.iter().enumerate() {
        if props.queue_flags.contains(vk::QueueFlags::GRAPHICS | vk::QueueFlags::COMPUTE) {
            return Ok(u32::try_from(i).unwrap_or(0));
        }
    }

    Err(Error::DeviceCreation("No suitable queue family found".into()))
}

pub fn detect_sync_capabilities(
    instance: &ash::Instance,
    physical_device: vk::PhysicalDevice,
) -> SyncCapabilities {
    let mut timeline_features = vk::PhysicalDeviceTimelineSemaphoreFeatures::default();
    let mut features2 = vk::PhysicalDeviceFeatures2::default().push_next(&mut timeline_features);

    // SAFETY: Valid instance and device features query.
    unsafe { instance.get_physical_device_features2(physical_device, &mut features2) };

    let timeline_semaphores = timeline_features.timeline_semaphore == vk::TRUE;
    
    // Simplified detection
    let sync_file_import = false; 
    let sync_file_export = false;

    let max_tier = if timeline_semaphores {
        SyncTier::TierA
    } else if sync_file_import {
        SyncTier::TierB
    } else {
        SyncTier::TierC
    };

    SyncCapabilities {
        max_tier,
        timeline_semaphores,
        sync_file_import,
        sync_file_export,
    }
}

fn get_required_instance_extensions() -> Vec<*const i8> {
    vec![
        ash::khr::surface::NAME.as_ptr(),
        #[cfg(target_os = "linux")]
        ash::khr::wayland_surface::NAME.as_ptr(),
        #[cfg(target_os = "linux")]
        ash::khr::xlib_surface::NAME.as_ptr(),
    ]
}

fn get_required_device_extensions(sync_caps: SyncCapabilities) -> Vec<*const i8> {
    let mut exts = vec![
        ash::khr::swapchain::NAME.as_ptr(),
        ash::khr::external_memory::NAME.as_ptr(),
        ash::khr::external_memory_fd::NAME.as_ptr(),
        ash::ext::external_memory_dma_buf::NAME.as_ptr(),
    ];

    if sync_caps.timeline_semaphores {
        exts.push(ash::khr::timeline_semaphore::NAME.as_ptr());
    }

    if sync_caps.sync_file_import || sync_caps.sync_file_export {
        exts.push(ash::khr::external_semaphore::NAME.as_ptr());
        exts.push(ash::khr::external_semaphore_fd::NAME.as_ptr());
    }

    exts
}