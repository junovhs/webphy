//! Native Vulkan swapchain management.
//!
//! The swapchain is owned by the native layer, not wgpu.

use super::VulkanDevice;
use crate::error::{PalError, PalResult};
use ash::{khr, vk};
use tracing::{debug, info};

/// Native swapchain with synchronization primitives.
pub struct Swapchain {
    handle: vk::SwapchainKHR,
    images: Vec<vk::Image>,
    views: Vec<vk::ImageView>,
    format: vk::Format,
    extent: vk::Extent2D,
    sync: FrameSync,
}

struct FrameSync {
    image_available: Vec<vk::Semaphore>,
    render_finished: Vec<vk::Semaphore>,
    in_flight: Vec<vk::Fence>,
    current_frame: usize,
}

const MAX_FRAMES_IN_FLIGHT: usize = 2;

impl Swapchain {
    /// Creates swapchain for the given surface.
    pub fn new(
        instance: &super::VulkanInstance,
        device: &VulkanDevice,
        surface: vk::SurfaceKHR,
        width: u32,
        height: u32,
    ) -> PalResult<Self> {
        let loader = instance.surface_loader();
        let physical = device.physical();

        let caps = query_caps(loader, physical, surface)?;
        let surface_format = select_format(loader, physical, surface)?;
        let present_mode = select_present_mode(loader, physical, surface);
        let extent = select_extent(&caps, width, height);

        let handle = create_swapchain_handle(device, surface, &caps, surface_format, present_mode, extent)?;
        let images = get_images(device, handle)?;
        let views = create_views(device.raw(), &images, surface_format.format)?;
        let sync = FrameSync::new(device.raw())?;

        info!("Swapchain: {:?} {}x{}", surface_format.format, extent.width, extent.height);

        Ok(Self { handle, images, views, format: surface_format.format, extent, sync })
    }

    /// Acquires next image, returns index and sync primitives.
    pub fn acquire_next_image(&mut self, device: &VulkanDevice) -> PalResult<AcquiredImage> {
        let frame = self.sync.current_frame;
        let fence = self.sync.in_flight[frame];
        let semaphore = self.sync.image_available[frame];

        // SAFETY: fence is valid and we own it
        unsafe {
            device.raw().wait_for_fences(&[fence], true, u64::MAX)
                .map_err(|e| PalError::Swapchain(e.to_string()))?;
            device.raw().reset_fences(&[fence])
                .map_err(|e| PalError::Swapchain(e.to_string()))?;
        }

        // SAFETY: swapchain and semaphore are valid
        let (index, _) = unsafe {
            device.swapchain_loader().acquire_next_image(self.handle, u64::MAX, semaphore, vk::Fence::null())
        }
        .map_err(|e| PalError::Swapchain(format!("Acquire: {:?}", e)))?;

        Ok(AcquiredImage {
            index,
            image_available: semaphore,
            render_finished: self.sync.render_finished[frame],
            submit_fence: fence,
        })
    }

    /// Presents the image after rendering is complete.
    pub fn present(&mut self, device: &VulkanDevice, image: &AcquiredImage) -> PalResult<()> {
        let wait = [image.render_finished];
        let swapchains = [self.handle];
        let indices = [image.index];

        let info = vk::PresentInfoKHR::default()
            .wait_semaphores(&wait)
            .swapchains(&swapchains)
            .image_indices(&indices);

        // SAFETY: all handles are valid
        unsafe { device.swapchain_loader().queue_present(device.queues().present, &info) }
            .map_err(|e| PalError::Swapchain(format!("Present: {:?}", e)))?;

        self.sync.current_frame = (self.sync.current_frame + 1) % MAX_FRAMES_IN_FLIGHT;
        Ok(())
    }

    pub fn format(&self) -> vk::Format { self.format }
    pub fn extent(&self) -> vk::Extent2D { self.extent }
    pub fn image(&self, index: u32) -> vk::Image { self.images[index as usize] }

    /// Cleans up swapchain resources.
    pub fn destroy(&mut self, device: &VulkanDevice) {
        // SAFETY: We own all these resources
        unsafe {
            device.raw().device_wait_idle().ok();
            self.sync.destroy(device.raw());
            for view in &self.views { device.raw().destroy_image_view(*view, None); }
            device.swapchain_loader().destroy_swapchain(self.handle, None);
        }
        debug!("Swapchain destroyed");
    }
}

/// Acquired swapchain image with sync primitives.
pub struct AcquiredImage {
    pub index: u32,
    pub image_available: vk::Semaphore,
    pub render_finished: vk::Semaphore,
    pub submit_fence: vk::Fence,
}

impl FrameSync {
    fn new(device: &ash::Device) -> PalResult<Self> {
        let sem_info = vk::SemaphoreCreateInfo::default();
        let fence_info = vk::FenceCreateInfo::default().flags(vk::FenceCreateFlags::SIGNALED);

        let mut image_available = Vec::with_capacity(MAX_FRAMES_IN_FLIGHT);
        let mut render_finished = Vec::with_capacity(MAX_FRAMES_IN_FLIGHT);
        let mut in_flight = Vec::with_capacity(MAX_FRAMES_IN_FLIGHT);

        for _ in 0..MAX_FRAMES_IN_FLIGHT {
            // SAFETY: device is valid, create_info is valid
            image_available.push(unsafe { device.create_semaphore(&sem_info, None) }
                .map_err(|e| PalError::Swapchain(e.to_string()))?);
            render_finished.push(unsafe { device.create_semaphore(&sem_info, None) }
                .map_err(|e| PalError::Swapchain(e.to_string()))?);
            in_flight.push(unsafe { device.create_fence(&fence_info, None) }
                .map_err(|e| PalError::Swapchain(e.to_string()))?);
        }

        Ok(Self { image_available, render_finished, in_flight, current_frame: 0 })
    }

    fn destroy(&self, device: &ash::Device) {
        for sem in &self.image_available { unsafe { device.destroy_semaphore(*sem, None); } }
        for sem in &self.render_finished { unsafe { device.destroy_semaphore(*sem, None); } }
        for fence in &self.in_flight { unsafe { device.destroy_fence(*fence, None); } }
    }
}

fn query_caps(l: &khr::surface::Instance, p: vk::PhysicalDevice, s: vk::SurfaceKHR) -> PalResult<vk::SurfaceCapabilitiesKHR> {
    // SAFETY: all handles valid
    unsafe { l.get_physical_device_surface_capabilities(p, s) }.map_err(|e| PalError::Surface(e.to_string()))
}

fn select_format(l: &khr::surface::Instance, p: vk::PhysicalDevice, s: vk::SurfaceKHR) -> PalResult<vk::SurfaceFormatKHR> {
    // SAFETY: all handles valid
    let formats = unsafe { l.get_physical_device_surface_formats(p, s) }.map_err(|e| PalError::Surface(e.to_string()))?;
    formats.iter().find(|f| f.format == vk::Format::B8G8R8A8_SRGB).or(formats.first()).copied()
        .ok_or_else(|| PalError::Surface("No formats".into()))
}

fn select_present_mode(l: &khr::surface::Instance, p: vk::PhysicalDevice, s: vk::SurfaceKHR) -> vk::PresentModeKHR {
    // SAFETY: all handles valid
    unsafe { l.get_physical_device_surface_present_modes(p, s) }.unwrap_or_default()
        .into_iter().find(|&m| m == vk::PresentModeKHR::FIFO).unwrap_or(vk::PresentModeKHR::FIFO)
}

fn select_extent(caps: &vk::SurfaceCapabilitiesKHR, w: u32, h: u32) -> vk::Extent2D {
    if caps.current_extent.width != u32::MAX { caps.current_extent }
    else { vk::Extent2D { width: w.clamp(caps.min_image_extent.width, caps.max_image_extent.width),
                          height: h.clamp(caps.min_image_extent.height, caps.max_image_extent.height) } }
}

fn create_swapchain_handle(
    device: &VulkanDevice, surface: vk::SurfaceKHR, caps: &vk::SurfaceCapabilitiesKHR,
    fmt: vk::SurfaceFormatKHR, mode: vk::PresentModeKHR, extent: vk::Extent2D,
) -> PalResult<vk::SwapchainKHR> {
    let count = (caps.min_image_count + 1).min(caps.max_image_count.max(caps.min_image_count + 1));
    let fam = device.families();
    let (sharing, indices) = if fam.is_unified() { (vk::SharingMode::EXCLUSIVE, vec![]) }
                              else { (vk::SharingMode::CONCURRENT, fam.unique_indices()) };

    let mut info = vk::SwapchainCreateInfoKHR::default()
        .surface(surface).min_image_count(count).image_format(fmt.format).image_color_space(fmt.color_space)
        .image_extent(extent).image_array_layers(1).image_usage(vk::ImageUsageFlags::COLOR_ATTACHMENT)
        .image_sharing_mode(sharing).pre_transform(caps.current_transform)
        .composite_alpha(vk::CompositeAlphaFlagsKHR::OPAQUE).present_mode(mode).clipped(true);
    if !indices.is_empty() { info = info.queue_family_indices(&indices); }

    // SAFETY: all parameters valid
    unsafe { device.swapchain_loader().create_swapchain(&info, None) }.map_err(|e| PalError::Swapchain(e.to_string()))
}

fn get_images(device: &VulkanDevice, sc: vk::SwapchainKHR) -> PalResult<Vec<vk::Image>> {
    // SAFETY: swapchain valid
    unsafe { device.swapchain_loader().get_swapchain_images(sc) }.map_err(|e| PalError::Swapchain(e.to_string()))
}

fn create_views(device: &ash::Device, images: &[vk::Image], format: vk::Format) -> PalResult<Vec<vk::ImageView>> {
    images.iter().map(|&img| {
        let info = vk::ImageViewCreateInfo::default().image(img).view_type(vk::ImageViewType::TYPE_2D).format(format)
            .subresource_range(vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR,
                base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 });
        // SAFETY: image and device valid
        unsafe { device.create_image_view(&info, None) }.map_err(|e| PalError::Swapchain(e.to_string()))
    }).collect()
}
