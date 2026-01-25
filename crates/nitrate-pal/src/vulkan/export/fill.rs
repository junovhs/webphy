//! Test pattern fill for exported images.

use crate::error::{PalError, PalResult, VulkanError};
use ash::vk;

/// Fills an image with a solid color (test pattern).
pub fn fill_checkerboard(
    device: &ash::Device,
    queue: vk::Queue,
    family_index: u32,
    image: vk::Image,
) -> PalResult<()> {
    let pool_info = vk::CommandPoolCreateInfo::default()
        .queue_family_index(family_index)
        .flags(vk::CommandPoolCreateFlags::TRANSIENT);

    // SAFETY: Device is valid.
    let pool = unsafe { device.create_command_pool(&pool_info, None) }
        .map_err(VulkanError::Api)?;

    let result = fill_inner(device, queue, pool, image);

    // SAFETY: Pool is valid, we're done with commands.
    unsafe { device.destroy_command_pool(pool, None) };

    result
}

fn fill_inner(
    device: &ash::Device,
    queue: vk::Queue,
    pool: vk::CommandPool,
    image: vk::Image,
) -> PalResult<()> {
    let alloc = vk::CommandBufferAllocateInfo::default()
        .command_pool(pool)
        .level(vk::CommandBufferLevel::PRIMARY)
        .command_buffer_count(1);

    // SAFETY: Pool is valid.
    let cmds = unsafe { device.allocate_command_buffers(&alloc) }
        .map_err(VulkanError::Api)?;

    let cmd = cmds.first().copied()
        .ok_or_else(|| PalError::Export("No command buffer".into()))?;

    record_fill_commands(device, cmd, image)?;
    submit_and_wait(device, queue, cmd)
}

fn record_fill_commands(
    device: &ash::Device,
    cmd: vk::CommandBuffer,
    image: vk::Image,
) -> PalResult<()> {
    let subresource = vk::ImageSubresourceRange::default()
        .aspect_mask(vk::ImageAspectFlags::COLOR)
        .level_count(1)
        .layer_count(1);

    // SAFETY: Command buffer is valid, barriers correctly formed.
    unsafe {
        device.begin_command_buffer(
            cmd,
            &vk::CommandBufferBeginInfo::default()
                .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT),
        ).map_err(VulkanError::Api)?;

        let to_transfer = vk::ImageMemoryBarrier::default()
            .image(image)
            .old_layout(vk::ImageLayout::UNDEFINED)
            .new_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
            .src_access_mask(vk::AccessFlags::empty())
            .dst_access_mask(vk::AccessFlags::TRANSFER_WRITE)
            .subresource_range(subresource);

        device.cmd_pipeline_barrier(
            cmd,
            vk::PipelineStageFlags::TOP_OF_PIPE,
            vk::PipelineStageFlags::TRANSFER,
            vk::DependencyFlags::empty(),
            &[], &[], &[to_transfer],
        );

        // Orange test color: #e07030
        let clear = vk::ClearColorValue {
            float32: [0.878, 0.439, 0.188, 1.0],
        };
        device.cmd_clear_color_image(
            cmd,
            image,
            vk::ImageLayout::TRANSFER_DST_OPTIMAL,
            &clear,
            &[subresource],
        );

        let to_shader = vk::ImageMemoryBarrier::default()
            .image(image)
            .old_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
            .new_layout(vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL)
            .src_access_mask(vk::AccessFlags::TRANSFER_WRITE)
            .dst_access_mask(vk::AccessFlags::SHADER_READ)
            .subresource_range(subresource);

        device.cmd_pipeline_barrier(
            cmd,
            vk::PipelineStageFlags::TRANSFER,
            vk::PipelineStageFlags::FRAGMENT_SHADER,
            vk::DependencyFlags::empty(),
            &[], &[], &[to_shader],
        );

        device.end_command_buffer(cmd).map_err(VulkanError::Api)?;
    }

    Ok(())
}

fn submit_and_wait(
    device: &ash::Device,
    queue: vk::Queue,
    cmd: vk::CommandBuffer,
) -> PalResult<()> {
    let cmds = [cmd];
    let submit = vk::SubmitInfo::default().command_buffers(&cmds);

    // SAFETY: Device and queue are valid.
    unsafe {
        let fence = device.create_fence(&vk::FenceCreateInfo::default(), None)
            .map_err(VulkanError::Api)?;
        device.queue_submit(queue, &[submit], fence)
            .map_err(VulkanError::Api)?;
        device.wait_for_fences(&[fence], true, u64::MAX)
            .map_err(VulkanError::Api)?;
        device.destroy_fence(fence, None);
    }

    Ok(())
}