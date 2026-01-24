//! Bridge between Native Vulkan and wgpu

use ash::vk;
use nitrate_core::{Error, Result};
use tracing::info;
use wgpu::hal::api::Vulkan;

/// Configuration for bridge creation
pub struct BridgeConfig {
    pub entry: ash::Entry,
    pub instance: ash::Instance,
    pub physical_device: vk::PhysicalDevice,
    pub device: ash::Device,
    pub queue_family_index: u32,
    pub queue_index: u32,
}

/// Bridge providing wgpu access to native Vulkan resources
pub struct WgpuBridge {
    device: wgpu::Device,
    queue: wgpu::Queue,
}

impl WgpuBridge {
    /// # Safety
    /// Caller must ensure Vulkan handles remain valid for bridge lifetime.
    pub unsafe fn new(config: &BridgeConfig) -> Result<Self> {
        let hal_instance = Self::wrap_instance(config)?;
        let wgpu_instance = wgpu::Instance::from_hal::<Vulkan>(hal_instance);
        
        let hal_exposed = Self::expose_adapter(&wgpu_instance, config)?;
        let wgpu_adapter = wgpu_instance.create_adapter_from_hal(hal_exposed);
        
        let (device, queue) = Self::wrap_device(&wgpu_adapter, config)?;

        info!("wgpu bridge created successfully");
        Ok(Self { device, queue })
    }

    unsafe fn wrap_instance(
        config: &BridgeConfig,
    ) -> Result<<Vulkan as wgpu::hal::Api>::Instance> {
        <Vulkan as wgpu::hal::Api>::Instance::from_raw(
            config.entry.clone(),
            config.instance.clone(),
            0,
            vk::API_VERSION_1_2,
            None,
            Vec::new(),
            wgpu::InstanceFlags::empty(),
            false,
            None,
        ).map_err(|e| Error::DeviceCreation(format!("HAL instance: {e}")))
    }

    unsafe fn expose_adapter(
        instance: &wgpu::Instance,
        config: &BridgeConfig,
    ) -> Result<wgpu::hal::ExposedAdapter<Vulkan>> {
        instance
            .as_hal::<Vulkan>()
            .ok_or_else(|| Error::DeviceCreation("Not Vulkan".into()))?
            .expose_adapter(config.physical_device)
            .ok_or_else(|| Error::DeviceCreation("Failed to expose adapter".into()))
    }

    unsafe fn wrap_device(
        adapter: &wgpu::Adapter,
        config: &BridgeConfig,
    ) -> Result<(wgpu::Device, wgpu::Queue)> {
        let hints = wgpu::MemoryHints::Performance;
        
        let open_device: Option<std::result::Result<_, _>> = adapter
            .as_hal::<Vulkan, _, _>(|hal_adapter| {
                hal_adapter.map(|a| {
                    a.device_from_raw(
                        config.device.clone(),
                        None,
                        &[],
                        wgpu::Features::empty(),
                        &hints,
                        config.queue_family_index,
                        config.queue_index,
                    )
                })
            });

        let hal_device = open_device
            .ok_or_else(|| Error::DeviceCreation("No HAL adapter".into()))?
            .map_err(|e| Error::DeviceCreation(format!("HAL device: {e}")))?;

        let desc = wgpu::DeviceDescriptor {
            label: Some("NITRATE Bridge"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
        };

        adapter
            .create_device_from_hal(hal_device, &desc, None)
            .map_err(|e| Error::DeviceCreation(format!("wgpu device: {e}")))
    }

    pub fn device(&self) -> &wgpu::Device { &self.device }
    pub fn queue(&self) -> &wgpu::Queue { &self.queue }
}