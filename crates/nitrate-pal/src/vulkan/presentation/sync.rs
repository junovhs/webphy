//! Manages per-frame synchronization primitives.

use crate::error::{PalError, PalResult, VulkanError};
use ash::vk;

pub struct SyncFrame {
    pub ready: vk::Semaphore,
    pub done: vk::Semaphore,
    pub fence: vk::Fence,
}

pub struct FramePacer {
    frames: Vec<SyncFrame>,
    current: usize,
}

impl FramePacer {
    pub fn init(device: &ash::Device, count: usize) -> PalResult<Self> {
        let mut frames = Vec::with_capacity(count);
        let sem_info = vk::SemaphoreCreateInfo::default();
        let fence_info = vk::FenceCreateInfo::default().flags(vk::FenceCreateFlags::SIGNALED);

        for _ in 0..count {
            // SAFETY: Valid device.
            unsafe {
                let ready = device
                    .create_semaphore(&sem_info, None)
                    .map_err(VulkanError::Api)?;
                let done = device
                    .create_semaphore(&sem_info, None)
                    .map_err(VulkanError::Api)?;
                let fence = device
                    .create_fence(&fence_info, None)
                    .map_err(VulkanError::Api)?;
                frames.push(SyncFrame { ready, done, fence });
            }
        }

        Ok(Self { frames, current: 0 })
    }

    pub fn next_frame(&self) -> PalResult<&SyncFrame> {
        self.frames
            .get(self.current)
            .ok_or_else(|| PalError::Swapchain("Frame index invalid".into()))
    }

    pub fn advance(&mut self) {
        self.current = (self.current + 1) % self.frames.len();
    }

    pub fn teardown(&mut self, device: &ash::Device) {
        for f in &self.frames {
            // SAFETY: Valid device and handles.
            unsafe {
                device.destroy_semaphore(f.ready, None);
                device.destroy_semaphore(f.done, None);
                device.destroy_fence(f.fence, None);
            }
        }
    }
}