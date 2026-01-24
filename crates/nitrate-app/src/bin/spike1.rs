//! Spike 1: The Native Host
//!
//! Goal: Create ash::Device, wrap in wgpu via HAL, clear screen to accent color.
//! Pass Criteria: Orange screen (#e07030), 0 validation errors.

use anyhow::Result;
use ash::vk;
use nitrate_pal::{AcquiredImage, Swapchain, VulkanDevice, VulkanInstance, WgpuBridge};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use std::sync::Arc;
use tracing::{error, info};
use winit::{application::ApplicationHandler, event::WindowEvent, event_loop::{ActiveEventLoop, ControlFlow, EventLoop},
    window::{Window, WindowAttributes, WindowId}};

fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter("spike1=debug,nitrate_pal=debug,wgpu=warn,vulkan=debug").init();
    info!("=== SPIKE 1: NATIVE HOST ===");

    let event_loop = EventLoop::new()?;
    event_loop.set_control_flow(ControlFlow::Poll);
    event_loop.run_app(&mut SpikeApp::default())?;

    info!("=== SPIKE 1: COMPLETED ===");
    Ok(())
}

#[derive(Default)]
struct SpikeApp { session: Option<Session> }

struct Session {
    window: Arc<Window>,
    instance: VulkanInstance,
    surface: vk::SurfaceKHR,
    device: VulkanDevice,
    swapchain: Swapchain,
    #[allow(dead_code)]
    bridge: WgpuBridge,
    frame_count: u64,
}

impl Session {
    fn new(event_loop: &ActiveEventLoop) -> Result<Self> {
        let attrs = WindowAttributes::default().with_title("SPIKE 1").with_inner_size(winit::dpi::LogicalSize::new(1280, 720));
        let window = Arc::new(event_loop.create_window(attrs)?);

        let instance = VulkanInstance::new(&*window, true)?;
        // SAFETY: instance and window handles are valid
        let surface = unsafe { ash_window::create_surface(instance.entry(), instance.raw(),
            window.display_handle()?.as_raw(), window.window_handle()?.as_raw(), None)? };

        let device = VulkanDevice::new(&instance, surface)?;
        info!("Sync tier: {:?}", device.capabilities().sync_tier);

        let size = window.inner_size();
        let swapchain = Swapchain::new(&instance, &device, surface, size.width, size.height)?;

        // SAFETY: instance and device will outlive bridge
        let bridge = unsafe { WgpuBridge::new(&instance, &device)? };
        info!("wgpu bridge established");

        Ok(Self { window, instance, surface, device, swapchain, bridge, frame_count: 0 })
    }

    fn render(&mut self) -> Result<()> {
        let acquired = self.swapchain.acquire_next_image(&self.device)?;
        submit_clear(&self.device, &self.swapchain, &acquired)?;
        self.swapchain.present(&self.device, &acquired)?;
        self.frame_count += 1;
        if self.frame_count % 300 == 0 { info!("Frame {}", self.frame_count); }
        Ok(())
    }

    fn destroy(&mut self) {
        // SAFETY: we own these resources
        unsafe { self.device.raw().device_wait_idle().ok(); }
        self.swapchain.destroy(&self.device);
        unsafe { self.instance.surface_loader().destroy_surface(self.surface, None); }
    }
}

fn submit_clear(device: &VulkanDevice, swapchain: &Swapchain, acquired: &AcquiredImage) -> Result<()> {
    let dev = device.raw();
    let image = swapchain.image(acquired.index);
    let subresource = vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR,
        base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 };

    let pool_info = vk::CommandPoolCreateInfo::default()
        .queue_family_index(device.families().graphics).flags(vk::CommandPoolCreateFlags::TRANSIENT);
    // SAFETY: device is valid
    let pool = unsafe { dev.create_command_pool(&pool_info, None)? };

    let alloc = vk::CommandBufferAllocateInfo::default().command_pool(pool).level(vk::CommandBufferLevel::PRIMARY).command_buffer_count(1);
    // SAFETY: pool is valid
    let cmds = unsafe { dev.allocate_command_buffers(&alloc)? };
    let Some(&cmd) = cmds.first() else { anyhow::bail!("No command buffer") };

    // SAFETY: cmd is valid, all barriers are correctly formed
    unsafe {
        dev.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT))?;

        let to_transfer = vk::ImageMemoryBarrier::default().image(image)
            .old_layout(vk::ImageLayout::UNDEFINED).new_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
            .src_access_mask(vk::AccessFlags::empty()).dst_access_mask(vk::AccessFlags::TRANSFER_WRITE).subresource_range(subresource);
        dev.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::TRANSFER,
            vk::DependencyFlags::empty(), &[], &[], &[to_transfer]);

        let clear = vk::ClearColorValue { float32: [0.878, 0.439, 0.188, 1.0] }; // #e07030
        dev.cmd_clear_color_image(cmd, image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &clear, &[subresource]);

        let to_present = vk::ImageMemoryBarrier::default().image(image)
            .old_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL).new_layout(vk::ImageLayout::PRESENT_SRC_KHR)
            .src_access_mask(vk::AccessFlags::TRANSFER_WRITE).dst_access_mask(vk::AccessFlags::empty()).subresource_range(subresource);
        dev.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::BOTTOM_OF_PIPE,
            vk::DependencyFlags::empty(), &[], &[], &[to_present]);

        dev.end_command_buffer(cmd)?;
    }

    let wait = [acquired.image_available];
    let signal = [acquired.render_finished];
    let stages = [vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT];
    let submit = vk::SubmitInfo::default().wait_semaphores(&wait).wait_dst_stage_mask(&stages)
        .command_buffers(&cmds).signal_semaphores(&signal);

    // SAFETY: all handles valid
    unsafe {
        dev.queue_submit(device.queues().graphics, &[submit], acquired.submit_fence)?;
        dev.queue_wait_idle(device.queues().graphics)?;
        dev.destroy_command_pool(pool, None);
    }
    Ok(())
}

impl ApplicationHandler for SpikeApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.session.is_none() {
            match Session::new(event_loop) {
                Ok(s) => self.session = Some(s),
                Err(e) => { error!("Init failed: {e}"); event_loop.exit(); }
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        let Some(session) = &mut self.session else { return };
        match event {
            WindowEvent::CloseRequested => { session.destroy(); event_loop.exit(); }
            WindowEvent::RedrawRequested => {
                if let Err(e) = session.render() { error!("Render: {e}"); }
                session.window.request_redraw();
            }
            _ => {}
        }
    }
}
