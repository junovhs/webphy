//! DMA-BUF export functionality.
//!
//! Allocates VkImage with exportable memory and exports as DMA-BUF fd.

#![cfg(target_os = "linux")]

mod alloc;
mod fill;

use crate::error::{PalError, PalResult, VulkanError};
use ash::vk;
use std::os::unix::io::{AsRawFd, OwnedFd, RawFd};
use tracing::debug;

/// An image with exportable memory that can be shared via DMA-BUF.
pub struct ExportedImage {
    image: vk::Image,
    memory: vk::DeviceMemory,
    fd: OwnedFd,
    pub extent: vk::Extent2D,
    pub format: vk::Format,
    device: ash::Device,
}

impl ExportedImage {
    /// Creates an exportable image and fills it with a test pattern.
    pub fn new_checkerboard(
        instance: &ash::Instance,
        device: &ash::Device,
        physical: vk::PhysicalDevice,
        queue: vk::Queue,
        family_index: u32,
        width: u32,
        height: u32,
    ) -> PalResult<Self> {
        let extent = vk::Extent2D { width, height };
        let format = vk::Format::R8G8B8A8_UNORM;

        let (image, memory) = alloc::create_exportable_image(
            instance, device, physical, extent, format,
        )?;

        fill::fill_checkerboard(device, queue, family_index, image)?;

        let fd = alloc::export_memory_fd(instance, device, memory)?;

        debug!("Exported image {}x{} as fd {}", width, height, fd.as_raw_fd());

        Ok(Self {
            image,
            memory,
            fd,
            extent,
            format,
            device: device.clone(),
        })
    }

    /// Returns the raw fd for import. Does not transfer ownership.
    pub fn raw_fd(&self) -> RawFd {
        self.fd.as_raw_fd()
    }

    /// Duplicates the fd for import (transfers ownership of the dup).
    pub fn dup_fd(&self) -> PalResult<OwnedFd> {
        self.fd
            .try_clone()
            .map_err(|e| PalError::Export(format!("fd dup failed: {e}")))
    }
}

impl Drop for ExportedImage {
    fn drop(&mut self) {
        // SAFETY: We own these resources and destroy in correct order.
        unsafe {
            self.device.destroy_image(self.image, None);
            self.device.free_memory(self.memory, None);
        }
        debug!("ExportedImage destroyed");
    }
}