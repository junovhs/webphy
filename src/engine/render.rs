use super::context::GpuContext;
use anyhow::{Context, Result};
use wgpu::{Color, LoadOp, Operations, RenderPassColorAttachment, RenderPassDescriptor, StoreOp};

/// NITRATE brand color: warm film orange
const CLEAR_COLOR: Color = Color {
    r: 0.95,
    g: 0.45,
    b: 0.20,
    a: 1.0,
};

pub fn draw_frame(gpu: &GpuContext) -> Result<()> {
    // Get the next frame texture
    let frame = gpu
        .surface
        .get_current_texture()
        .context("Failed to acquire next swapchain texture")?;

    let view = frame.texture.create_view(&Default::default());

    // Create command encoder
    let mut encoder = gpu.device.create_command_encoder(&Default::default());

    // Begin render pass (just clears to color for now)
    {
        let _pass = encoder.begin_render_pass(&RenderPassDescriptor {
            label: Some("clear_pass"),
            color_attachments: &[Some(RenderPassColorAttachment {
                view: &view,
                resolve_target: None,
                ops: Operations {
                    load: LoadOp::Clear(CLEAR_COLOR),
                    store: StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        // Pass ends here when _pass is dropped
    }

    // Submit commands
    gpu.queue.submit(std::iter::once(encoder.finish()));

    // Present frame
    frame.present();

    Ok(())
}
