//! Vulkan device creation and management

use super::helpers;
use crate::{Compositor, PlatformDevice, SyncCapabilities, UiRenderTarget};
use ash::vk;
use nitrate_core::{Error, Extent2D, Result};
use std::ffi::CStr;
use tracing::info;

/// Container for raw Vulkan handles and capabilities
pub struct VulkanContext {
    #[allow(dead_code)]
    pub entry: ash::Entry,
    #[allow(dead_code)]
    pub instance: ash::Instance,
    #[allow(dead_code)]
    pub physical_device: vk::PhysicalDevice,
    pub device: ash::Device,
    #[allow(dead_code)]
    pub queue_family: u32,
    #[allow(dead_code)]
    pub queue: vk::Queue,
    pub sync_caps: SyncCapabilities,
}

impl VulkanContext {
    fn is_valid(&self) -> bool {
        self.device.handle() != vk::Device::null()
    }
}

/// Vulkan-based platform device
pub struct VulkanDevice {
    ctx: VulkanContext,
}

impl VulkanDevice {
    pub fn new() -> Result<Self> {
        // SAFETY: Loading Vulkan library is safe if the library exists.
        let entry = unsafe { ash::Entry::load() }
            .map_err(|e| Error::DeviceCreation(format!("Failed to load Vulkan: {e}")))?;

        let instance = helpers::create_instance(&entry)?;
        let physical_device = helpers::pick_physical_device(&instance)?;
        
        // SAFETY: Valid instance and physical device from above.
        let props = unsafe { instance.get_physical_device_properties(physical_device) };
        // SAFETY: device_name is a null-terminated C string from Vulkan.
        let device_name = unsafe { CStr::from_ptr(props.device_name.as_ptr()) };
        info!("Selected GPU: {}", device_name.to_string_lossy());

        let queue_family = helpers::find_queue_family(&instance, physical_device)?;
        let sync_caps = helpers::detect_sync_capabilities(&instance, physical_device);
        info!("Sync tier: {:?} - {}", sync_caps.max_tier, sync_caps.max_tier.description());

        let (device, queue) = helpers::create_logical_device(
            &instance, physical_device, queue_family, sync_caps
        )?;

        info!("Vulkan device created successfully");

        let ctx = VulkanContext {
            entry, instance, physical_device, device, queue_family, queue, sync_caps,
        };

        Ok(Self { ctx })
    }

    pub fn context(&self) -> &VulkanContext { &self.ctx }
}

impl PlatformDevice for VulkanDevice {
    fn sync_capabilities(&self) -> SyncCapabilities { self.ctx.sync_caps }

    fn create_ui_render_target(&self, _extent: Extent2D) -> Result<Box<dyn UiRenderTarget>> {
        if !self.ctx.is_valid() {
            return Err(Error::DeviceCreation("Device state invalid".into()));
        }
        Err(Error::PlatformNotSupported("UI render target not yet implemented".into()))
    }

    fn create_compositor(&self) -> Result<Box<dyn Compositor>> {
        if !self.ctx.is_valid() {
            return Err(Error::DeviceCreation("Device state invalid".into()));
        }
        Err(Error::PlatformNotSupported("Compositor not yet implemented".into()))
    }
}

impl Drop for VulkanDevice {
    fn drop(&mut self) {
        // SAFETY: Destroying Vulkan objects we own. Called once on drop.
        unsafe {
            self.ctx.device.destroy_device(None);
            self.ctx.instance.destroy_instance(None);
        }
    }
}