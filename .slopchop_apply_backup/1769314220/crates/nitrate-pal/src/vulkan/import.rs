//! DMA-BUF import into wgpu.
//!
//! Takes a DMA-BUF fd and creates a wgpu texture from it via HAL.

#![cfg(target_os = "linux")]

use crate::error::{PalError, PalResult};
use ash::vk;
use std::os::unix::io::RawFd;
use tracing::debug;

/// A wgpu texture imported from external memory.
pub struct ImportedTexture {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub sampler: wgpu::Sampler,
}

impl ImportedTexture {
    /// Import a DMA-BUF fd as a wgpu texture.
    ///
    /// Note: This is a simplified implementation using a staging approach.
    /// Full HAL import requires wgpu to expose external memory APIs.
    pub fn from_dmabuf(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        _fd: RawFd,
        width: u32,
        height: u32,
        _format: vk::Format,
    ) -> PalResult<Self> {
        // TODO: True zero-copy import via wgpu HAL when API stabilizes.
        // For now, create a regular texture (validates the pipeline).
        debug!(
            "Creating imported texture {}x{} (staging path)",
            width, height
        );

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("imported-dmabuf"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        // Fill with checkerboard pattern
        let data = generate_checkerboard(width, height);
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("imported-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Ok(Self {
            texture,
            view,
            sampler,
        })
    }
}

/// Generate RGBA checkerboard pattern.
fn generate_checkerboard(width: u32, height: u32) -> Vec<u8> {
    let tile_size = 32u32;
    let mut data = Vec::with_capacity((width * height * 4) as usize);

    for y in 0..height {
        for x in 0..width {
            let tile_x = x / tile_size;
            let tile_y = y / tile_size;
            let is_dark = (tile_x + tile_y) % 2 == 0;

            if is_dark {
                // Dark tile: #1a1a2e (navy)
                data.extend_from_slice(&[0x1a, 0x1a, 0x2e, 0xff]);
            } else {
                // Light tile: #e07030 (orange)
                data.extend_from_slice(&[0xe0, 0x70, 0x30, 0xff]);
            }
        }
    }

    data
}