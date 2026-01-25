//! Render pipeline and frame submission for Spike 2.

use anyhow::Result;
use ash::vk;
use nitrate_pal::vulkan::{ImportedTexture, VulkanDevice};
use nitrate_pal::AcquiredFrame;

/// Holds wgpu render state for the blit pipeline.
pub struct BlitPipeline {
    pub pipeline: wgpu::RenderPipeline,
    pub bind_group: wgpu::BindGroup,
}

impl BlitPipeline {
    /// Creates the blit pipeline and bind group from an imported texture.
    pub fn new(device: &wgpu::Device, imported: &ImportedTexture) -> Result<Self> {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("blit-shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/blit.wgsl").into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("blit-layout"),
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

        Ok(Self { pipeline, bind_group })
    }
}

/// Render a frame using native Vulkan commands.
pub fn render_frame(device: &VulkanDevice, frame: &AcquiredFrame) -> Result<()> {
    let dev = &device.device;
    let subresource = vk::ImageSubresourceRange {
        aspect_mask: vk::ImageAspectFlags::COLOR,
        base_mip_level: 0, level_count: 1,
        base_array_layer: 0, layer_count: 1,
    };

    let pool_info = vk::CommandPoolCreateInfo::default()
        .queue_family_index(device.families.graphics)
        .flags(vk::CommandPoolCreateFlags::TRANSIENT);

    // SAFETY: Device is valid.
    let pool = unsafe { dev.create_command_pool(&pool_info, None)? };
    let result = record_and_submit(dev, device, pool, frame, subresource);

    // SAFETY: Pool is valid.
    unsafe { dev.destroy_command_pool(pool, None); }
    result
}

fn record_and_submit(
    dev: &ash::Device,
    device: &VulkanDevice,
    pool: vk::CommandPool,
    frame: &AcquiredFrame,
    subresource: vk::ImageSubresourceRange,
) -> Result<()> {
    let alloc = vk::CommandBufferAllocateInfo::default()
        .command_pool(pool)
        .level(vk::CommandBufferLevel::PRIMARY)
        .command_buffer_count(1);

    // SAFETY: Pool is valid.
    let cmds = unsafe { dev.allocate_command_buffers(&alloc)? };
    let cmd = cmds.first().copied().ok_or_else(|| anyhow::anyhow!("No cmd"))?;

    record_clear_commands(dev, cmd, frame.image, subresource)?;

    let wait = [frame.ready];
    let signal = [frame.done];
    let stages = [vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT];
    let submit = vk::SubmitInfo::default()
        .wait_semaphores(&wait).wait_dst_stage_mask(&stages)
        .command_buffers(&cmds).signal_semaphores(&signal);

    // SAFETY: All handles valid.
    unsafe {
        dev.queue_submit(device.queues.graphics, &[submit], frame.fence)?;
        dev.queue_wait_idle(device.queues.graphics)?;
    }
    Ok(())
}

fn record_clear_commands(
    dev: &ash::Device,
    cmd: vk::CommandBuffer,
    image: vk::Image,
    subresource: vk::ImageSubresourceRange,
) -> Result<()> {
    // SAFETY: All handles valid, barriers correctly formed.
    unsafe {
        dev.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default()
            .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT))?;

        let to_transfer = vk::ImageMemoryBarrier::default()
            .image(image)
            .old_layout(vk::ImageLayout::UNDEFINED)
            .new_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
            .src_access_mask(vk::AccessFlags::empty())
            .dst_access_mask(vk::AccessFlags::TRANSFER_WRITE)
            .subresource_range(subresource);
        dev.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::TOP_OF_PIPE,
            vk::PipelineStageFlags::TRANSFER, vk::DependencyFlags::empty(),
            &[], &[], &[to_transfer]);

        let clear = vk::ClearColorValue { float32: [0.1, 0.1, 0.18, 1.0] };
        dev.cmd_clear_color_image(cmd, image,
            vk::ImageLayout::TRANSFER_DST_OPTIMAL, &clear, &[subresource]);

        let to_present = vk::ImageMemoryBarrier::default()
            .image(image)
            .old_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
            .new_layout(vk::ImageLayout::PRESENT_SRC_KHR)
            .src_access_mask(vk::AccessFlags::TRANSFER_WRITE)
            .dst_access_mask(vk::AccessFlags::empty())
            .subresource_range(subresource);
        dev.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::TRANSFER,
            vk::PipelineStageFlags::BOTTOM_OF_PIPE, vk::DependencyFlags::empty(),
            &[], &[], &[to_present]);

        dev.end_command_buffer(cmd)?;
    }
    Ok(())
}