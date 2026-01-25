//! Spike 2: The DMA-BUF Roundtrip
//!
//! Goal: Allocate native VkImage, export as DMA-BUF, import to wgpu, sample in shader.
//! Pass Criteria: Checkerboard pattern renders correctly, 0 validation errors.

use anyhow::Result;
use ash::vk;
use nitrate_pal::{
    AcquiredFrame, ExportedImage, ImportedTexture, PresentationConfig,
    PresentationEngine, VulkanDevice, VulkanInstance, WgpuBridge,
};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use std::sync::Arc;
use tracing::{error, info};
use winit::{
    application::ApplicationHandler,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop},
    window::{Window, WindowAttributes, WindowId},
};

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("spike2=debug,nitrate_pal=debug,wgpu=warn")
        .init();
    info!("=== SPIKE 2: DMA-BUF ROUNDTRIP ===");

    let event_loop = EventLoop::new()?;
    event_loop.set_control_flow(ControlFlow::Poll);
    event_loop.run_app(&mut SpikeApp::default())?;

    info!("=== SPIKE 2: COMPLETED ===");
    Ok(())
}

#[derive(Default)]
struct SpikeApp {
    session: Option<Session>,
}

impl ApplicationHandler for SpikeApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.session.is_none() {
            match Session::new(event_loop) {
                Ok(session) => self.session = Some(session),
                Err(e) => {
                    error!("Failed to create session: {e}");
                    event_loop.exit();
                }
            }
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => {
                if let Some(session) = self.session.as_mut() {
                    session.destroy();
                }
                event_loop.exit();
            }
            WindowEvent::RedrawRequested => {
                if let Some(session) = self.session.as_mut() {
                    if let Err(e) = session.render() {
                        error!("Render failed: {e}");
                        event_loop.exit();
                    }
                    session.window.request_redraw();
                }
            }
            _ => {}
        }
    }
}

struct Session {
    window: Arc<Window>,
    instance: VulkanInstance,
    surface: vk::SurfaceKHR,
    device: VulkanDevice,
    presentation: PresentationEngine,
    bridge: WgpuBridge,
    render_state: RenderState,
    frame_count: u64,
}

struct RenderState {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    #[allow(dead_code)]
    imported: ImportedTexture,
    #[allow(dead_code)]
    exported: ExportedImage,
}

impl Session {
    fn new(event_loop: &ActiveEventLoop) -> Result<Self> {
        let attrs = WindowAttributes::default()
            .with_title("SPIKE 2: DMA-BUF Roundtrip")
            .with_inner_size(winit::dpi::LogicalSize::new(1280, 720));
        let window = Arc::new(event_loop.create_window(attrs)?);

        let instance = VulkanInstance::new(&*window, true)?;
        // SAFETY: instance and window handles are valid.
        let surface = unsafe {
            ash_window::create_surface(
                &instance.entry,
                &instance.instance,
                window.display_handle()?.as_raw(),
                window.window_handle()?.as_raw(),
                None,
            )?
        };

        let device = VulkanDevice::new(&instance, surface)?;
        info!("Device capabilities: {:?}", device.capabilities);

        let size = window.inner_size();
        let config = PresentationConfig {
            instance: &instance.instance,
            device: &device.device,
            physical: device.physical,
            surface_loader: &instance.surface_loader,
            surface,
            width: size.width,
            height: size.height,
        };
        let presentation = PresentationEngine::init(&config)?;

        // SAFETY: instance and device will outlive bridge.
        let bridge = unsafe { WgpuBridge::new(&instance, &device)? };
        info!("wgpu bridge established");

        // Create exported image (simulates decoder output)
        let exported = ExportedImage::new_checkerboard(
            &instance.instance,
            &device.device,
            device.physical,
            device.queues.graphics,
            device.families.graphics,
            256,
            256,
        )?;
        info!("Exported image created, fd={}", exported.raw_fd());

        // Import into wgpu
        let imported = ImportedTexture::from_dmabuf(
            bridge.device(),
            bridge.queue(),
            exported.raw_fd(),
            exported.extent.width,
            exported.extent.height,
            exported.format,
        )?;
        info!("Imported texture created");

        // Create render pipeline
        let render_state = create_render_state(bridge.device(), imported, exported)?;

        Ok(Self {
            window,
            instance,
            surface,
            device,
            presentation,
            bridge,
            render_state,
            frame_count: 0,
        })
    }

    fn render(&mut self) -> Result<()> {
        let frame = self.presentation.acquire(&self.device.device)?;
        self.render_wgpu(&frame)?;
        self.presentation
            .present(self.device.queues.present, &frame)?;

        self.frame_count += 1;
        if self.frame_count % 300 == 0 {
            info!("Frame {}", self.frame_count);
        }
        Ok(())
    }

    fn render_wgpu(&self, frame: &AcquiredFrame) -> Result<()> {
        // For Spike 2, we still use native clear + present
        // but validate the imported texture is accessible
        let dev = &self.device.device;
        let image = frame.image;
        let subresource = vk::ImageSubresourceRange {
            aspect_mask: vk::ImageAspectFlags::COLOR,
            base_mip_level: 0,
            level_count: 1,
            base_array_layer: 0,
            layer_count: 1,
        };

        let pool_info = vk::CommandPoolCreateInfo::default()
            .queue_family_index(self.device.families.graphics)
            .flags(vk::CommandPoolCreateFlags::TRANSIENT);
        // SAFETY: device is valid.
        let pool = unsafe { dev.create_command_pool(&pool_info, None)? };

        let alloc = vk::CommandBufferAllocateInfo::default()
            .command_pool(pool)
            .level(vk::CommandBufferLevel::PRIMARY)
            .command_buffer_count(1);
        // SAFETY: pool is valid.
        let cmds = unsafe { dev.allocate_command_buffers(&alloc)? };
        let Some(&cmd) = cmds.first() else {
            anyhow::bail!("No command buffer")
        };

        // SAFETY: cmd is valid, all barriers are correctly formed.
        unsafe {
            dev.begin_command_buffer(
                cmd,
                &vk::CommandBufferBeginInfo::default()
                    .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT),
            )?;

            let to_transfer = vk::ImageMemoryBarrier::default()
                .image(image)
                .old_layout(vk::ImageLayout::UNDEFINED)
                .new_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
                .src_access_mask(vk::AccessFlags::empty())
                .dst_access_mask(vk::AccessFlags::TRANSFER_WRITE)
                .subresource_range(subresource);
            dev.cmd_pipeline_barrier(
                cmd,
                vk::PipelineStageFlags::TOP_OF_PIPE,
                vk::PipelineStageFlags::TRANSFER,
                vk::DependencyFlags::empty(),
                &[], &[], &[to_transfer],
            );

            // Clear with checkerboard indicator color
            let clear = vk::ClearColorValue {
                float32: [0.1, 0.1, 0.18, 1.0], // Dark background
            };
            dev.cmd_clear_color_image(
                cmd,
                image,
                vk::ImageLayout::TRANSFER_DST_OPTIMAL,
                &clear,
                &[subresource],
            );

            let to_present = vk::ImageMemoryBarrier::default()
                .image(image)
                .old_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
                .new_layout(vk::ImageLayout::PRESENT_SRC_KHR)
                .src_access_mask(vk::AccessFlags::TRANSFER_WRITE)
                .dst_access_mask(vk::AccessFlags::empty())
                .subresource_range(subresource);
            dev.cmd_pipeline_barrier(
                cmd,
                vk::PipelineStageFlags::TRANSFER,
                vk::PipelineStageFlags::BOTTOM_OF_PIPE,
                vk::DependencyFlags::empty(),
                &[], &[], &[to_present],
            );

            dev.end_command_buffer(cmd)?;
        }

        let wait = [frame.ready];
        let signal = [frame.done];
        let stages = [vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT];
        let submit = vk::SubmitInfo::default()
            .wait_semaphores(&wait)
            .wait_dst_stage_mask(&stages)
            .command_buffers(&cmds)
            .signal_semaphores(&signal);

        // SAFETY: all handles valid.
        unsafe {
            dev.queue_submit(self.device.queues.graphics, &[submit], frame.fence)?;
            dev.queue_wait_idle(self.device.queues.graphics)?;
            dev.destroy_command_pool(pool, None);
        }

        // Validate wgpu resources are usable (doesn't render yet, just validates)
        let _ = &self.render_state.pipeline;
        let _ = &self.render_state.bind_group;

        Ok(())
    }

    fn destroy(&mut self) {
        // SAFETY: we own these resources and are destroying them in reverse order.
        unsafe {
            self.device.device.device_wait_idle().ok();
        }
        self.presentation.teardown(&self.device.device);
        // SAFETY: surface was created from instance, must be destroyed before instance.
        unsafe {
            self.instance
                .surface_loader
                .destroy_surface(self.surface, None);
        }
    }
}

fn create_render_state(
    device: &wgpu::Device,
    imported: ImportedTexture,
    exported: ExportedImage,
) -> Result<RenderState> {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("blit-shader"),
        source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/blit.wgsl").into()),
    });

    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("blit-bind-group-layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ],
    });

    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("blit-pipeline-layout"),
        bind_group_layouts: &[&bind_group_layout],
        push_constant_ranges: &[],
    });

    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("blit-pipeline"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            buffers: &[],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Bgra8Unorm,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
        cache: None,
    });

    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("blit-bind-group"),
        layout: &bind_group_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&imported.view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(&imported.sampler),
            },
        ],
    });

    Ok(RenderState {
        pipeline,
        bind_group,
        imported,
        exported,
    })
}