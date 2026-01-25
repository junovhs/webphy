//! WGPU HAL Bridge - Wraps native Vulkan handles for wgpu use.
//!
//! This is the core of the "Native Owns, wgpu Borrows" architecture.
//! We create ash handles first, then wrap them for wgpu's use.

use super::{VulkanDevice, VulkanInstance};
use crate::error::{PalError, PalResult};
use ash::vk;
use std::ffi::CStr;
use tracing::{debug, info};

/// Bridge that exposes wgpu Device/Queue from native Vulkan handles.
pub struct WgpuBridge {
    device: wgpu::Device,
    queue: wgpu::Queue,
}

impl WgpuBridge {
    /// Creates wgpu device by wrapping existing Vulkan handles.
    ///
    /// # Safety
    /// The `VulkanInstance` and `VulkanDevice` must outlive this bridge.
    /// The caller is responsible for ensuring proper synchronization.
    pub unsafe fn new(instance: &VulkanInstance, device: &VulkanDevice) -> PalResult<Self> {
        let (wgpu_device, wgpu_queue) = create_wgpu_device(instance, device)?;
        info!("wgpu bridge created from native Vulkan handles");
        Ok(Self {
            device: wgpu_device,
            queue: wgpu_queue,
        })
    }

    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }
    pub fn queue(&self) -> &wgpu::Queue {
        &self.queue
    }
}

/// Creates wgpu device/queue by wrapping native Vulkan handles via HAL.
fn create_wgpu_device(
    instance: &VulkanInstance,
    device: &VulkanDevice,
) -> PalResult<(wgpu::Device, wgpu::Queue)> {
    use wgpu::hal::api::Vulkan;

    let families = &device.families;

    debug!(
        "Creating HAL bridge: physical={:?}, queue_family={}",
        device.physical,
        families.graphics
    );

    // SAFETY: We're wrapping valid ash handles that we own.
    // We clone the handles because wgpu expects to own them, but since we are keeping
    // the native objects alive externally, this shared ownership is managed by the architecture.
    let hal_instance = unsafe {
        <Vulkan as wgpu::hal::Api>::Instance::from_raw(
            instance.entry.clone(),
            instance.instance.clone(),
            vk::API_VERSION_1_2,
            0,
            None,
            vec![ash::khr::surface::NAME],
            wgpu::InstanceFlags::empty(),
            false,
            None, // drop_guard - we manage lifetime externally
        )
    }
    .map_err(|e| PalError::Bridge(format!("HAL instance: {e:?}")))?;

    // expose_adapter is no longer unsafe in current wgpu
    let hal_exposed = hal_instance
        .expose_adapter(device.physical)
        .ok_or_else(|| PalError::Bridge("Failed to expose HAL adapter".into()))?;

    // SAFETY: instance and physical device are valid
    let available = unsafe {
        instance
            .instance
            .enumerate_device_extension_properties(device.physical)
    }
    .map_err(|e| PalError::Bridge(e.to_string()))?;

    let extension_names: Vec<&CStr> = available
        .iter()
        .map(|ext| {
            // SAFETY: Vulkan guarantees null-terminated extension names
            unsafe { CStr::from_ptr(ext.extension_name.as_ptr()) }
        })
        .collect();

    let memory_hints = wgpu::MemoryHints::Performance;

    // SAFETY: device handle is valid, extensions match what device was created with
    let hal_open_device = unsafe {
        hal_exposed.adapter.device_from_raw(
            device.device.clone(),
            None, // drop_guard - we manage device lifetime
            &extension_names,
            wgpu::Features::empty(),
            &memory_hints,
            families.graphics,
            0,
        )
    }
    .map_err(|e| PalError::Bridge(format!("HAL device: {e:?}")))?;

    // SAFETY: hal_instance is valid
    let wgpu_instance = unsafe { wgpu::Instance::from_hal::<Vulkan>(hal_instance) };

    // SAFETY: hal_exposed is valid and from our instance
    let wgpu_adapter = unsafe { wgpu_instance.create_adapter_from_hal(hal_exposed) };

    // SAFETY: hal_open_device matches the adapter
    let (wgpu_device, wgpu_queue) = unsafe {
        wgpu_adapter.create_device_from_hal(
            hal_open_device,
            &wgpu::DeviceDescriptor {
                label: Some("nitrate-bridge"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        )
    }
    .map_err(|e| PalError::Bridge(e.to_string()))?;

    Ok((wgpu_device, wgpu_queue))
}