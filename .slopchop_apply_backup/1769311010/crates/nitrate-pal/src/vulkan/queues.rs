//! Queue family discovery and selection.

use ash::vk;
use tracing::debug;

/// Selected queue family indices.
#[derive(Debug, Clone, Copy)]
pub struct QueueFamilies {
    /// Graphics + compute capable queue.
    pub graphics: u32,
    /// Presentation capable queue (may equal graphics).
    pub present: u32,
}

impl QueueFamilies {
    /// Returns true if graphics and present are the same family.
    pub const fn is_unified(self) -> bool {
        self.graphics == self.present
    }

    /// Returns unique family indices.
    pub fn unique_indices(self) -> Vec<u32> {
        if self.is_unified() {
            vec![self.graphics]
        } else {
            vec![self.graphics, self.present]
        }
    }
}

/// Finds suitable queue families for graphics and presentation.
pub fn find_queue_families(
    instance: &ash::Instance,
    physical_device: vk::PhysicalDevice,
    surface_loader: &ash::khr::surface::Instance,
    surface: vk::SurfaceKHR,
) -> Option<QueueFamilies> {
    // SAFETY: instance and physical_device are valid
    let props = unsafe { instance.get_physical_device_queue_family_properties(physical_device) };

    let mut graphics = None;
    let mut present = None;

    for (idx, family) in props.iter().enumerate() {
        // Queue family indices are always small (< 32 typically), safe to truncate
        #[allow(clippy::cast_possible_truncation)]
        let idx = idx as u32;

        if family.queue_flags.contains(vk::QueueFlags::GRAPHICS) && graphics.is_none() {
            graphics = Some(idx);
        }

        // SAFETY: surface_loader, physical_device, and surface are valid
        let supports_present = unsafe {
            surface_loader
                .get_physical_device_surface_support(physical_device, idx, surface)
                .unwrap_or(false)
        };

        if supports_present && present.is_none() {
            present = Some(idx);
        }

        if graphics == present && graphics.is_some() {
            break;
        }
    }

    match (graphics, present) {
        (Some(g), Some(p)) => {
            debug!("Queue families: graphics={}, present={}", g, p);
            Some(QueueFamilies {
                graphics: g,
                present: p,
            })
        }
        _ => None,
    }
}
