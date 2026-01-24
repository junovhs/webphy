# Project NITRATE: Revised Architecture

## Acknowledgment of Critical Feedback

Your review correctly identifies the fault lines that would cause this project to fail late rather than early. The core insight—that **wgpu's cross-platform abstraction does not currently extend to external surface import and GPU-to-GPU synchronization**—forces a fundamental rearchitecture of the interop layer.

This revision addresses each identified risk with concrete changes and defines explicit fallback tiers where platform capabilities diverge.

---

## 1. The Interop Boundary: A First-Class Subsystem

The original design treated platform interop as an implementation detail hidden behind traits. This revision elevates it to **the central architectural decision**, with explicit acknowledgment that the video path may bypass wgpu entirely on some platforms.

### The Fundamental Choice: Hybrid Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           REVISED ARCHITECTURE: HYBRID MODEL                             │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │                              UI RENDERING (wgpu)                                   │  │
│  │  • Safe, cross-platform                                                            │  │
│  │  • Vello compute raster → UI render target                                         │  │
│  │  • All non-video GPU work                                                          │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│                                         │                                                │
│                                         │ wgpu::Texture (UI RT)                         │
│                                         ▼                                                │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │                         COMPOSITION LAYER (Native API)                             │  │
│  │  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐               │  │
│  │  │ ash (Vulkan)    │    │ windows (DX12)  │    │ metal-rs        │               │  │
│  │  │                 │    │                 │    │                 │               │  │
│  │  │ • Import DMA-BUF│    │ • Open shared   │    │ • IOSurface     │               │  │
│  │  │ • Timeline sema │    │   handle        │    │   texture       │               │  │
│  │  │ • Final compose │    │ • ID3D12Fence   │    │ • MTLSharedEvent│               │  │
│  │  │ • Present       │    │ • Final compose │    │ • Final compose │               │  │
│  │  │                 │    │ • Present       │    │ • Present       │               │  │
│  │  └─────────────────┘    └─────────────────┘    └─────────────────┘               │  │
│  │                                         ▲                                          │  │
│  │                                         │                                          │  │
│  └─────────────────────────────────────────┼──────────────────────────────────────────┘  │
│                                            │                                             │
│                           ImportedSurface + SyncPrimitive                               │
│                                            │                                             │
│  ┌─────────────────────────────────────────┴──────────────────────────────────────────┐  │
│  │                         VIDEO DECODE (Platform Native)                             │  │
│  │  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐               │  │
│  │  │ VA-API          │    │ D3D12VA/MF      │    │ VideoToolbox    │               │  │
│  │  │ → DMA-BUF       │    │ → Shared Handle │    │ → IOSurface     │               │  │
│  │  └─────────────────┘    └─────────────────┘    └─────────────────┘               │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key decision:** The composition pass runs on **native APIs**, not wgpu. wgpu handles only UI rendering (where its cross-platform abstraction is stable). The video surface never enters wgpu's texture system.

### The ImportedSurface Type

This is the boundary object that carries all information needed for zero-copy import:

```rust
// nitrate-pal/src/surface.rs

use std::os::unix::io::RawFd;
use std::sync::Arc;

/// Complete description of an externally-owned video surface.
/// This is the "handoff" object between decode and render.
#[derive(Debug)]
pub struct ImportedSurface {
    /// Platform-specific handle
    pub handle: SurfaceHandle,
    
    /// Per-plane descriptions (Y, UV for NV12; Y, U, V for I420)
    pub planes: ArrayVec<PlaneDescriptor, 3>,
    
    /// Color metadata (essential for correct rendering)
    pub color: ColorMetadata,
    
    /// Synchronization primitive (how to know decode is complete)
    pub sync: SyncHandle,
    
    /// Frame timing (for A/V sync)
    pub pts: i64,
    pub duration: i64,
}

/// Platform-specific memory handle
#[derive(Debug)]
pub enum SurfaceHandle {
    /// Linux: DMA-BUF file descriptor
    DmaBuf {
        fd: RawFd,
        /// DRM format modifier (critical for tiled/compressed formats)
        modifier: u64,
        /// DRM fourcc format code
        drm_format: u32,
    },
    
    /// Windows: DXGI shared handle (NT handle)
    DxgiShared {
        handle: *mut std::ffi::c_void, // HANDLE
        /// Whether this is a keyed mutex (D3D11 interop) or fence-synchronized
        sync_mode: DxgiSyncMode,
    },
    
    /// macOS: IOSurface reference
    IoSurface {
        surface: *mut std::ffi::c_void, // IOSurfaceRef
    },
}

#[derive(Debug, Clone, Copy)]
pub enum DxgiSyncMode {
    /// Pure D3D12: synchronized via ID3D12Fence
    Fence,
    /// D3D11 interop: synchronized via IDXGIKeyedMutex
    KeyedMutex,
}

/// Description of a single plane within the surface
#[derive(Debug, Clone, Copy)]
pub struct PlaneDescriptor {
    /// Offset in bytes from start of allocation
    pub offset: u64,
    /// Row stride in bytes
    pub stride: u32,
    /// Width in pixels (may differ from surface width for chroma)
    pub width: u32,
    /// Height in pixels
    pub height: u32,
    /// Pixel format for this plane
    pub format: PlaneFormat,
}

#[derive(Debug, Clone, Copy)]
pub enum PlaneFormat {
    /// 8-bit luma
    R8,
    /// 10-bit luma (in 16-bit container)
    R16,
    /// 8-bit chroma (NV12 UV plane)
    Rg8,
    /// 10-bit chroma (P010 UV plane, in 16-bit container)
    Rg16,
}

/// Complete color metadata for correct YUV→RGB conversion
#[derive(Debug, Clone, Copy)]
pub struct ColorMetadata {
    /// Color primaries (defines the RGB triangle)
    pub primaries: ColorPrimaries,
    /// Transfer function (gamma/PQ/HLG)
    pub transfer: TransferFunction,
    /// YCbCr matrix coefficients
    pub matrix: MatrixCoefficients,
    /// Value range
    pub range: ColorRange,
    
    /// HDR metadata (optional, for HDR10/HDR10+)
    pub mastering: Option<MasteringMetadata>,
    pub content_light: Option<ContentLightLevel>,
}

#[derive(Debug, Clone, Copy)]
pub enum ColorPrimaries {
    Bt709,
    Bt2020,
    DciP3,
    Unknown,
}

#[derive(Debug, Clone, Copy)]
pub enum TransferFunction {
    Srgb,       // ~gamma 2.2
    Bt1886,     // Rec.709/1886 EOTF
    Pq,         // ST.2084 (HDR10)
    Hlg,        // Hybrid Log-Gamma
    Linear,
    Unknown,
}

#[derive(Debug, Clone, Copy)]
pub enum MatrixCoefficients {
    Bt709,
    Bt2020Ncl,  // Non-constant luminance (common)
    Bt2020Cl,   // Constant luminance (rare)
    Identity,   // RGB (no conversion needed)
    Unknown,
}

#[derive(Debug, Clone, Copy)]
pub enum ColorRange {
    /// Limited range: Y [16-235], UV [16-240] for 8-bit
    Limited,
    /// Full range: [0-255] for 8-bit
    Full,
}

#[derive(Debug, Clone, Copy)]
pub struct MasteringMetadata {
    /// Display primaries (xy chromaticity)
    pub display_primaries: [[f32; 2]; 3],
    /// White point (xy chromaticity)
    pub white_point: [f32; 2],
    /// Max luminance in cd/m² (nits)
    pub max_luminance: f32,
    /// Min luminance in cd/m²
    pub min_luminance: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct ContentLightLevel {
    /// Maximum Content Light Level
    pub max_cll: u16,
    /// Maximum Frame Average Light Level
    pub max_fall: u16,
}

/// Synchronization handle for knowing when decode is complete
#[derive(Debug)]
pub enum SyncHandle {
    /// Vulkan timeline semaphore with target value
    VulkanTimeline {
        semaphore: u64, // VkSemaphore (opaque handle)
        value: u64,
    },
    
    /// DMA-BUF sync file (Linux implicit sync)
    DmaBufSyncFile {
        fd: RawFd,
    },
    
    /// D3D12 fence with target value
    D3D12Fence {
        fence: *mut std::ffi::c_void, // ID3D12Fence*
        value: u64,
    },
    
    /// D3D11 keyed mutex (acquire key)
    KeyedMutex {
        key: u64,
    },
    
    /// Metal shared event with target value
    MetalSharedEvent {
        event: *mut std::ffi::c_void, // MTLSharedEvent*
        value: u64,
    },
    
    /// Fallback: CPU-side "decode complete" signal
    /// Use only when GPU sync is unavailable
    CpuSignal {
        ready: Arc<std::sync::atomic::AtomicBool>,
    },
}
```

---

## 2. Synchronization Tiers

Your observation about defining explicit sync tiers is critical. Here's the formalized tier system:

```rust
// nitrate-pal/src/sync.rs

/// Synchronization capability tier, detected at runtime
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SyncTier {
    /// Tier A: Full GPU-to-GPU timeline synchronization
    /// - Vulkan: VK_KHR_timeline_semaphore + external semaphore export
    /// - DX12: ID3D12Fence shared across contexts
    /// - Metal: MTLSharedEvent
    /// 
    /// The render queue waits on the decode signal without CPU involvement.
    GpuTimeline,
    
    /// Tier B: GPU wait on externally-signaled resource
    /// - Resource is marked "ready" by decoder (implicit sync or fence)
    /// - Renderer issues GPU wait command, but sync point is "resource-ready"
    /// - Still no CPU blocking, but less fine-grained than Tier A
    GpuResourceReady,
    
    /// Tier C: CPU-coordinated handoff
    /// - CPU polls or waits for decode completion
    /// - Then submits render work knowing resource is safe
    /// - Introduces latency but guarantees correctness
    CpuCoordinated,
}

/// Runtime capability detection
pub struct SyncCapabilities {
    pub tier: SyncTier,
    pub details: SyncDetails,
}

pub enum SyncDetails {
    Vulkan {
        has_timeline_semaphore: bool,
        has_external_semaphore_fd: bool,
        has_external_memory_dma_buf: bool,
    },
    D3D12 {
        has_shared_fence: bool,
        has_shared_handle: bool,
    },
    Metal {
        has_shared_event: bool,
        has_iosurface_texture: bool,
    },
}

impl SyncCapabilities {
    /// Detect capabilities for Vulkan device
    pub fn detect_vulkan(
        instance: &ash::Instance,
        physical_device: ash::vk::PhysicalDevice,
    ) -> Self {
        use ash::vk;
        
        // Check for timeline semaphore support (Vulkan 1.2 core or extension)
        let mut timeline_features = vk::PhysicalDeviceTimelineSemaphoreFeatures::default();
        let mut features2 = vk::PhysicalDeviceFeatures2::builder()
            .push_next(&mut timeline_features)
            .build();
        
        unsafe {
            instance.get_physical_device_features2(physical_device, &mut features2);
        }
        
        let has_timeline = timeline_features.timeline_semaphore == vk::TRUE;
        
        // Check for external semaphore/memory extensions
        let extensions = unsafe {
            instance.enumerate_device_extension_properties(physical_device)
        }.unwrap_or_default();
        
        let ext_names: Vec<_> = extensions.iter()
            .map(|e| unsafe { std::ffi::CStr::from_ptr(e.extension_name.as_ptr()) })
            .collect();
        
        let has_external_semaphore_fd = ext_names.iter()
            .any(|n| n.to_bytes() == b"VK_KHR_external_semaphore_fd");
        let has_external_memory_dma_buf = ext_names.iter()
            .any(|n| n.to_bytes() == b"VK_EXT_external_memory_dma_buf");
        
        let tier = if has_timeline && has_external_semaphore_fd && has_external_memory_dma_buf {
            SyncTier::GpuTimeline
        } else if has_external_memory_dma_buf {
            // Can import memory, but sync may be implicit (dma_fence in buffer)
            SyncTier::GpuResourceReady
        } else {
            SyncTier::CpuCoordinated
        };
        
        SyncCapabilities {
            tier,
            details: SyncDetails::Vulkan {
                has_timeline_semaphore: has_timeline,
                has_external_semaphore_fd,
                has_external_memory_dma_buf,
            },
        }
    }
}
```

### Sync Tier Implementation Patterns

```rust
// nitrate-compositor/src/sync_strategy.rs

use crate::pal::{SyncTier, SyncHandle, ImportedSurface};

pub trait SyncStrategy: Send + Sync {
    /// Called before building render commands for a frame
    /// Returns when it's safe to start building (may be immediate or may wait)
    fn prepare_frame(&self, surface: &ImportedSurface) -> PrepareResult;
    
    /// Returns GPU wait commands to inject into command buffer (if any)
    fn gpu_wait_commands(&self, surface: &ImportedSurface) -> Option<GpuWaitOp>;
}

pub enum PrepareResult {
    /// Proceed immediately; GPU will handle synchronization
    Immediate,
    /// CPU had to wait; latency was incurred but frame is now safe
    WaitedCpu { wait_time_us: u64 },
}

pub struct GpuWaitOp {
    pub semaphore: u64,
    pub value: u64,
    pub stage_mask: ash::vk::PipelineStageFlags2,
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// TIER A: GPU Timeline (Optimal)
// ═══════════════════════════════════════════════════════════════════════════════════════

pub struct GpuTimelineStrategy {
    // Shared timeline semaphore between decoder and renderer
    shared_semaphore: ash::vk::Semaphore,
}

impl SyncStrategy for GpuTimelineStrategy {
    fn prepare_frame(&self, _surface: &ImportedSurface) -> PrepareResult {
        // No CPU work needed; GPU handles everything
        PrepareResult::Immediate
    }
    
    fn gpu_wait_commands(&self, surface: &ImportedSurface) -> Option<GpuWaitOp> {
        match &surface.sync {
            SyncHandle::VulkanTimeline { semaphore, value } => {
                Some(GpuWaitOp {
                    semaphore: *semaphore,
                    value: *value,
                    // Wait before fragment shader reads the texture
                    stage_mask: ash::vk::PipelineStageFlags2::FRAGMENT_SHADER,
                })
            }
            _ => None,
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// TIER B: GPU Resource Ready (DMA-BUF implicit sync)
// ═══════════════════════════════════════════════════════════════════════════════════════

pub struct GpuResourceReadyStrategy;

impl SyncStrategy for GpuResourceReadyStrategy {
    fn prepare_frame(&self, _surface: &ImportedSurface) -> PrepareResult {
        // For DMA-BUF with implicit sync, the kernel handles synchronization
        // when we import the buffer. No explicit wait needed.
        PrepareResult::Immediate
    }
    
    fn gpu_wait_commands(&self, surface: &ImportedSurface) -> Option<GpuWaitOp> {
        // If we have a sync_file fd, we could import it as a semaphore
        // For now, relying on implicit sync during import
        match &surface.sync {
            SyncHandle::DmaBufSyncFile { fd } => {
                // Import sync_file as binary semaphore and wait
                // (implementation depends on driver support)
                None // Simplified; real impl would import the fd
            }
            _ => None,
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// TIER C: CPU Coordinated (Fallback)
// ═══════════════════════════════════════════════════════════════════════════════════════

pub struct CpuCoordinatedStrategy;

impl SyncStrategy for CpuCoordinatedStrategy {
    fn prepare_frame(&self, surface: &ImportedSurface) -> PrepareResult {
        let start = std::time::Instant::now();
        
        match &surface.sync {
            SyncHandle::CpuSignal { ready } => {
                // Spin-wait with backoff (not ideal, but correct)
                let mut backoff = 1;
                while !ready.load(std::sync::atomic::Ordering::Acquire) {
                    if backoff < 1000 {
                        // Spin
                        for _ in 0..backoff {
                            std::hint::spin_loop();
                        }
                        backoff *= 2;
                    } else {
                        // Yield to OS
                        std::thread::yield_now();
                    }
                }
            }
            SyncHandle::D3D12Fence { fence, value } => {
                // Use ID3D12Fence::SetEventOnCompletion + WaitForSingleObject
                // (Platform-specific implementation)
                unimplemented!("D3D12 fence CPU wait")
            }
            _ => {}
        }
        
        PrepareResult::WaitedCpu {
            wait_time_us: start.elapsed().as_micros() as u64,
        }
    }
    
    fn gpu_wait_commands(&self, _surface: &ImportedSurface) -> Option<GpuWaitOp> {
        // CPU already waited; no GPU wait needed
        None
    }
}
```

---

## 3. Two-Pass UI Composition

The original uber-shader was indeed non-viable. Here's the corrected architecture:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           TWO-PASS COMPOSITION PIPELINE                                  │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  PASS 1: UI Rasterization (wgpu, compute shader via Vello)                              │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                                   │  │
│  │  Input:  Scene graph (paths, text, images)                                        │  │
│  │  Output: UI Render Target (RGBA8, same resolution as swapchain or lower)          │  │
│  │                                                                                   │  │
│  │  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐            │  │
│  │  │ Path Encoding   │────▶│ Tile Binning    │────▶│ Fine Raster     │            │  │
│  │  │ (CPU: ~1ms)     │     │ (Compute)       │     │ (Compute)       │            │  │
│  │  └─────────────────┘     └─────────────────┘     └─────────────────┘            │  │
│  │                                                          │                       │  │
│  │                                                          ▼                       │  │
│  │                                              ┌─────────────────────┐             │  │
│  │                                              │ UI Render Target    │             │  │
│  │                                              │ (wgpu::Texture)     │             │  │
│  │                                              │ RGBA8, premul alpha │             │  │
│  │                                              └──────────┬──────────┘             │  │
│  └──────────────────────────────────────────────────────────┼────────────────────────┘  │
│                                                             │                           │
│                                                             │ Interop: extract raw      │
│                                                             │ Vulkan/D3D12/Metal handle │
│                                                             ▼                           │
│  PASS 2: Final Composition (Native API)                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                                   │  │
│  │  Inputs:                                                                          │  │
│  │    • Video Y plane (imported, R8/R16)                                             │  │
│  │    • Video UV plane (imported, RG8/RG16)                                          │  │
│  │    • UI render target (from wgpu, RGBA8)                                          │  │
│  │    • Color metadata (uniforms)                                                    │  │
│  │                                                                                   │  │
│  │  Pipeline: Single fullscreen triangle draw                                        │  │
│  │    1. Sample Y + UV                                                               │  │
│  │    2. YUV → Linear RGB (matrix from metadata)                                     │  │
│  │    3. Apply EOTF (PQ/HLG/sRGB based on metadata)                                  │  │
│  │    4. Tone map if needed (HDR → SDR)                                              │  │
│  │    5. Gamut map if needed (BT.2020 → BT.709)                                      │  │
│  │    6. Apply output transfer function (sRGB)                                       │  │
│  │    7. Sample UI texture                                                           │  │
│  │    8. Alpha composite (premultiplied)                                             │  │
│  │                                                                                   │  │
│  │  Output: Swapchain image                                                          │  │
│  │                                                                                   │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### wgpu ↔ Native Interop for UI Texture

Since the composition pass runs on native APIs, we need to extract the raw handle from wgpu's UI render target:

```rust
// nitrate-render/src/interop.rs

use wgpu::hal::api::Vulkan as VulkanApi;
use ash::vk;

/// Extract the raw Vulkan image handle from a wgpu texture
/// 
/// # Safety
/// The returned handle is only valid while the wgpu::Texture is alive.
/// The caller must not destroy or modify the image.
pub unsafe fn extract_vulkan_image(
    device: &wgpu::Device,
    texture: &wgpu::Texture,
) -> Option<vk::Image> {
    // Use wgpu's HAL access to get the underlying Vulkan image
    texture.as_hal::<VulkanApi, _, _>(|hal_texture| {
        hal_texture.map(|t| t.raw_handle())
    }).flatten()
}

/// For DX12: extract ID3D12Resource
#[cfg(windows)]
pub unsafe fn extract_d3d12_resource(
    device: &wgpu::Device,
    texture: &wgpu::Texture,
) -> Option<*mut std::ffi::c_void> {
    use wgpu::hal::api::Dx12 as Dx12Api;
    
    texture.as_hal::<Dx12Api, _, _>(|hal_texture| {
        hal_texture.map(|t| t.resource().as_raw() as *mut std::ffi::c_void)
    }).flatten()
}

/// For Metal: extract MTLTexture
#[cfg(target_os = "macos")]
pub unsafe fn extract_metal_texture(
    device: &wgpu::Device,
    texture: &wgpu::Texture,
) -> Option<*mut std::ffi::c_void> {
    use wgpu::hal::api::Metal as MetalApi;
    
    texture.as_hal::<MetalApi, _, _>(|hal_texture| {
        hal_texture.map(|t| t.as_raw() as *mut std::ffi::c_void)
    }).flatten()
}
```

---

## 4. Color Management Module

This addresses the HDR correctness concerns with a formal, metadata-driven color pipeline:

```rust
// nitrate-color/src/lib.rs

pub mod metadata;
pub mod matrix;
pub mod transfer;
pub mod tonemap;
pub mod gamut;

use crate::pal::ColorMetadata;

/// Complete color pipeline configuration, derived from frame metadata
#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct ColorPipelineParams {
    /// YUV to RGB matrix (3x3, row-major, padded to 4x3 for GPU alignment)
    pub yuv_to_rgb: [[f32; 4]; 3],
    
    /// YUV offset (depends on range and bit depth)
    pub yuv_offset: [f32; 4],
    
    /// Transfer function ID (for shader switch)
    pub transfer_function: u32,
    
    /// Tone mapping mode
    pub tonemap_mode: u32,
    
    /// Source max luminance (nits, from mastering metadata or default)
    pub src_max_luminance: f32,
    
    /// Target max luminance (nits, from display capabilities)
    pub dst_max_luminance: f32,
    
    /// Gamut mapping mode (0 = none, 1 = clip, 2 = compress)
    pub gamut_map_mode: u32,
    
    /// Bit depth (8 or 10, affects offset calculation)
    pub bit_depth: u32,
    
    /// Padding for 16-byte alignment
    pub _pad: [u32; 2],
}

impl ColorPipelineParams {
    pub fn from_metadata(
        meta: &ColorMetadata,
        bit_depth: u32,
        display_max_nits: f32,
    ) -> Self {
        // Calculate YUV offset based on range and bit depth
        let yuv_offset = match (meta.range, bit_depth) {
            (ColorRange::Limited, 8) => [16.0/255.0, 128.0/255.0, 128.0/255.0, 0.0],
            (ColorRange::Limited, 10) => [64.0/1023.0, 512.0/1023.0, 512.0/1023.0, 0.0],
            (ColorRange::Full, _) => [0.0, 0.5, 0.5, 0.0],
        };
        
        // Select YUV→RGB matrix based on color primaries and matrix coefficients
        let yuv_to_rgb = matrix::select_matrix(meta.primaries, meta.matrix, meta.range, bit_depth);
        
        // Determine if tone mapping is needed
        let src_max = meta.mastering
            .map(|m| m.max_luminance)
            .unwrap_or(1000.0); // Default HDR assumption
        
        let needs_tonemap = src_max > display_max_nits * 1.1; // 10% headroom
        
        // Determine if gamut mapping is needed
        let needs_gamut_map = matches!(
            (meta.primaries, display_primaries()),
            (ColorPrimaries::Bt2020, ColorPrimaries::Bt709)
        );
        
        Self {
            yuv_to_rgb,
            yuv_offset,
            transfer_function: meta.transfer.to_shader_id(),
            tonemap_mode: if needs_tonemap { 1 } else { 0 },
            src_max_luminance: src_max,
            dst_max_luminance: display_max_nits,
            gamut_map_mode: if needs_gamut_map { 2 } else { 0 },
            bit_depth,
            _pad: [0; 2],
        }
    }
}

// nitrate-color/src/matrix.rs

/// YUV to RGB conversion matrices
/// 
/// These are derived from ITU-R BT.709, BT.2020, etc.
/// All matrices assume [Y, Cb, Cr] input order and output linear RGB.

pub fn select_matrix(
    primaries: ColorPrimaries,
    matrix: MatrixCoefficients,
    range: ColorRange,
    bit_depth: u32,
) -> [[f32; 4]; 3] {
    // The matrix depends on Kr, Kb coefficients which come from the standard
    let (kr, kb) = match matrix {
        MatrixCoefficients::Bt709 => (0.2126, 0.0722),
        MatrixCoefficients::Bt2020Ncl => (0.2627, 0.0593),
        MatrixCoefficients::Bt2020Cl => {
            // Constant luminance uses different derivation
            // This is rare in practice
            (0.2627, 0.0593)
        }
        MatrixCoefficients::Identity => {
            // RGB input, no conversion needed (identity matrix)
            return [
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
            ];
        }
        MatrixCoefficients::Unknown => {
            // Default to BT.709
            (0.2126, 0.0722)
        }
    };
    
    // Scale factors for limited vs full range
    let (y_scale, c_scale) = match (range, bit_depth) {
        (ColorRange::Limited, 8) => (255.0 / 219.0, 255.0 / 224.0),
        (ColorRange::Limited, 10) => (1023.0 / 876.0, 1023.0 / 896.0),
        (ColorRange::Full, _) => (1.0, 1.0),
    };
    
    // Derive matrix from Kr, Kb
    // Standard YCbCr to RGB conversion:
    // R = Y + (2 - 2*Kr) * Cr
    // G = Y - (Kb/Kg)*(2-2*Kb)*Cb - (Kr/Kg)*(2-2*Kr)*Cr
    // B = Y + (2 - 2*Kb) * Cb
    // where Kg = 1 - Kr - Kb
    
    let kg = 1.0 - kr - kb;
    
    let r_cr = (2.0 - 2.0 * kr) * c_scale;
    let g_cb = -(kb / kg) * (2.0 - 2.0 * kb) * c_scale;
    let g_cr = -(kr / kg) * (2.0 - 2.0 * kr) * c_scale;
    let b_cb = (2.0 - 2.0 * kb) * c_scale;
    
    [
        [y_scale, 0.0,    r_cr,   0.0], // R
        [y_scale, g_cb,   g_cr,   0.0], // G
        [y_scale, b_cb,   0.0,    0.0], // B
    ]
}

// nitrate-color/src/transfer.rs

impl TransferFunction {
    pub fn to_shader_id(&self) -> u32 {
        match self {
            TransferFunction::Srgb => 0,
            TransferFunction::Bt1886 => 1,
            TransferFunction::Pq => 2,
            TransferFunction::Hlg => 3,
            TransferFunction::Linear => 4,
            TransferFunction::Unknown => 0, // Default to sRGB
        }
    }
}
```

### Revised Composition Shader with Proper Color Pipeline

```wgsl
// nitrate-compositor/shaders/compose.wgsl

// ═══════════════════════════════════════════════════════════════════════════════════════
// UNIFORMS
// ═══════════════════════════════════════════════════════════════════════════════════════

struct ColorParams {
    yuv_to_rgb: mat3x4<f32>,  // 3 rows, 4 columns (padded)
    yuv_offset: vec4<f32>,
    transfer_function: u32,
    tonemap_mode: u32,
    src_max_luminance: f32,
    dst_max_luminance: f32,
    gamut_map_mode: u32,
    bit_depth: u32,
    _pad: vec2<u32>,
}

@group(0) @binding(0) var<uniform> color: ColorParams;
@group(0) @binding(1) var y_plane: texture_2d<f32>;
@group(0) @binding(2) var uv_plane: texture_2d<f32>;
@group(0) @binding(3) var ui_texture: texture_2d<f32>;
@group(0) @binding(4) var linear_sampler: sampler;

// ═══════════════════════════════════════════════════════════════════════════════════════
// TRANSFER FUNCTIONS (EOTF: Electrical to Optical)
// ═══════════════════════════════════════════════════════════════════════════════════════

fn eotf_srgb(v: vec3<f32>) -> vec3<f32> {
    let low = v / 12.92;
    let high = pow((v + 0.055) / 1.055, vec3(2.4));
    return select(high, low, v <= vec3(0.04045));
}

fn eotf_bt1886(v: vec3<f32>) -> vec3<f32> {
    // BT.1886 with gamma 2.4 and black level adjustment
    // Simplified: treat as pure power function
    return pow(max(v, vec3(0.0)), vec3(2.4));
}

fn eotf_pq(v: vec3<f32>) -> vec3<f32> {
    // ST.2084 PQ EOTF
    let m1 = 0.1593017578125;
    let m2 = 78.84375;
    let c1 = 0.8359375;
    let c2 = 18.8515625;
    let c3 = 18.6875;
    
    let vp = pow(max(v, vec3(0.0)), vec3(1.0 / m2));
    let num = max(vp - c1, vec3(0.0));
    let den = c2 - c3 * vp;
    // Output in nits (cd/m²), normalized to 10000
    return pow(num / den, vec3(1.0 / m1)) * 10000.0;
}

fn eotf_hlg(v: vec3<f32>) -> vec3<f32> {
    // Hybrid Log-Gamma OETF inverse
    let a = 0.17883277;
    let b = 0.28466892;
    let c = 0.55991073;
    
    let low = v * v / 3.0;
    let high = (exp((v - c) / a) + b) / 12.0;
    return select(high, low, v <= vec3(0.5));
}

fn apply_eotf(v: vec3<f32>, tf: u32) -> vec3<f32> {
    switch tf {
        case 0u: { return eotf_srgb(v); }
        case 1u: { return eotf_bt1886(v); }
        case 2u: { return eotf_pq(v); }
        case 3u: { return eotf_hlg(v); }
        case 4u: { return v; } // Linear
        default: { return eotf_srgb(v); }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// TONE MAPPING
// ═══════════════════════════════════════════════════════════════════════════════════════

fn tonemap_aces(x: vec3<f32>) -> vec3<f32> {
    // ACES RRT + ODT approximation (Narkowicz fit)
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return saturate((x * (a * x + b)) / (x * (c * x + d) + e));
}

fn tonemap_reinhard_extended(x: vec3<f32>, white_point: f32) -> vec3<f32> {
    // Extended Reinhard with white point
    let numerator = x * (1.0 + x / (white_point * white_point));
    return numerator / (1.0 + x);
}

fn apply_tonemap(linear: vec3<f32>, mode: u32, src_max: f32, dst_max: f32) -> vec3<f32> {
    if mode == 0u {
        // No tone mapping (passthrough or HDR display)
        return linear;
    }
    
    // Normalize by source max luminance
    let normalized = linear / src_max;
    
    // Apply ACES tone mapping
    let tonemapped = tonemap_aces(normalized);
    
    // Scale to destination range
    return tonemapped * dst_max;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// GAMUT MAPPING (BT.2020 → BT.709)
// ═══════════════════════════════════════════════════════════════════════════════════════

// BT.2020 to BT.709 3x3 matrix (Bradford adaptation)
const BT2020_TO_BT709 = mat3x3<f32>(
    vec3( 1.6605, -0.1246, -0.0182),
    vec3(-0.5876,  1.1329, -0.1006),
    vec3(-0.0728, -0.0083,  1.1187)
);

fn gamut_map_compress(rgb: vec3<f32>) -> vec3<f32> {
    // Convert BT.2020 to BT.709
    var mapped = BT2020_TO_BT709 * rgb;
    
    // Soft-clip out-of-gamut values instead of hard clamp
    // This preserves hue better than simple saturation
    let max_component = max(mapped.r, max(mapped.g, mapped.b));
    if max_component > 1.0 {
        // Desaturate proportionally
        let luminance = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
        let excess = max_component - 1.0;
        let factor = 1.0 / max_component;
        mapped = mix(vec3(luminance), mapped, factor);
    }
    
    return saturate(mapped);
}

fn apply_gamut_map(rgb: vec3<f32>, mode: u32) -> vec3<f32> {
    switch mode {
        case 0u: { return rgb; }                          // No mapping
        case 1u: { return saturate(BT2020_TO_BT709 * rgb); } // Simple clip
        case 2u: { return gamut_map_compress(rgb); }      // Soft compress
        default: { return rgb; }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// OUTPUT TRANSFER FUNCTION (OETF: Optical to Electrical)
// ═══════════════════════════════════════════════════════════════════════════════════════

fn oetf_srgb(linear: vec3<f32>) -> vec3<f32> {
    let low = linear * 12.92;
    let high = 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055;
    return select(high, low, linear <= vec3(0.0031308));
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// MAIN FRAGMENT SHADER
// ═══════════════════════════════════════════════════════════════════════════════════════

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    // 1. Sample video planes
    let y = textureSample(y_plane, linear_sampler, uv).r;
    let uv_sample = textureSample(uv_plane, linear_sampler, uv).rg;
    
    // 2. Apply YUV offset (range + bit-depth specific)
    let yuv = vec3(y, uv_sample.x, uv_sample.y) - color.yuv_offset.xyz;
    
    // 3. YUV to RGB conversion (matrix from metadata)
    let rgb_electrical = vec3(
        dot(color.yuv_to_rgb[0].xyz, yuv),
        dot(color.yuv_to_rgb[1].xyz, yuv),
        dot(color.yuv_to_rgb[2].xyz, yuv)
    );
    
    // 4. Apply EOTF (electrical → linear light)
    var rgb_linear = apply_eotf(rgb_electrical, color.transfer_function);
    
    // 5. Tone mapping (HDR → SDR if needed)
    rgb_linear = apply_tonemap(
        rgb_linear, 
        color.tonemap_mode,
        color.src_max_luminance,
        color.dst_max_luminance
    );
    
    // 6. Gamut mapping (BT.2020 → BT.709 if needed)
    rgb_linear = apply_gamut_map(rgb_linear, color.gamut_map_mode);
    
    // 7. Apply output transfer function (linear → sRGB)
    let video_rgb = oetf_srgb(saturate(rgb_linear));
    
    // 8. Sample UI (already in sRGB, premultiplied alpha)
    let ui = textureSample(ui_texture, linear_sampler, uv);
    
    // 9. Composite (premultiplied alpha over)
    let out_rgb = ui.rgb + video_rgb * (1.0 - ui.a);
    
    return vec4(out_rgb, 1.0);
}
```

---

## 5. Fixed-Capacity Memory Management

Addressing the DashMap and allocation concerns:

```rust
// nitrate-decode/src/pool.rs

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

/// Maximum frames in flight (compile-time constant)
const MAX_POOL_SIZE: usize = 8;

/// Fixed-capacity frame pool with atomic fence tracking
/// 
/// Design choices:
/// - Fixed array instead of DashMap (no dynamic growth)
/// - Per-slot AtomicU64 for fence values (no locks)
/// - Bitset for availability (cache-friendly)
pub struct FramePool {
    /// Fixed array of pre-allocated surfaces
    slots: [PoolSlot; MAX_POOL_SIZE],
    
    /// Bitmask of available slots (1 = available)
    /// Using AtomicUsize for lock-free acquire/release
    available_mask: AtomicUsize,
    
    /// Current pool size (may be less than MAX_POOL_SIZE)
    size: usize,
    
    /// Last completed GPU fence value (for reclamation)
    gpu_completed_value: AtomicU64,
}

struct PoolSlot {
    /// The actual GPU surface handle
    surface: Option<SurfaceHandle>,
    
    /// Fence value when GPU will be done with this frame
    /// u64::MAX means "not in use"
    fence_value: AtomicU64,
}

impl FramePool {
    pub fn new(device: &impl VideoDevice, count: usize) -> Result<Self, Error> {
        assert!(count <= MAX_POOL_SIZE);
        
        // Initialize all slots
        let mut slots: [PoolSlot; MAX_POOL_SIZE] = std::array::from_fn(|_| PoolSlot {
            surface: None,
            fence_value: AtomicU64::new(u64::MAX),
        });
        
        // Allocate surfaces for the requested count
        for i in 0..count {
            slots[i].surface = Some(device.allocate_decode_surface(
                7680, 4320,
                SurfaceFormat::Nv12,
            )?);
        }
        
        // All allocated slots start as available
        let available_mask = (1 << count) - 1;
        
        Ok(Self {
            slots,
            available_mask: AtomicUsize::new(available_mask),
            size: count,
            gpu_completed_value: AtomicU64::new(0),
        })
    }
    
    /// Acquire a frame slot for decoding
    /// Returns None if all slots are in use (backpressure signal)
    pub fn acquire(&self) -> Option<FrameSlotGuard> {
        loop {
            let mask = self.available_mask.load(Ordering::Acquire);
            if mask == 0 {
                // No slots available
                return None;
            }
            
            // Find first available slot
            let slot_idx = mask.trailing_zeros() as usize;
            let slot_bit = 1 << slot_idx;
            
            // Try to claim it atomically
            let new_mask = mask & !slot_bit;
            match self.available_mask.compare_exchange_weak(
                mask,
                new_mask,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    // Successfully claimed
                    return Some(FrameSlotGuard {
                        pool: self,
                        slot_idx,
                    });
                }
                Err(_) => {
                    // Another thread beat us, retry
                    continue;
                }
            }
        }
    }
    
    /// Called when GPU signals completion of a fence value
    /// Reclaims any slots whose fence value is now complete
    pub fn reclaim(&self, completed_value: u64) {
        self.gpu_completed_value.store(completed_value, Ordering::Release);
        
        for i in 0..self.size {
            let fence = self.slots[i].fence_value.load(Ordering::Acquire);
            if fence != u64::MAX && fence <= completed_value {
                // This slot's GPU work is complete, mark as available
                self.slots[i].fence_value.store(u64::MAX, Ordering::Release);
                self.available_mask.fetch_or(1 << i, Ordering::Release);
            }
        }
    }
    
    /// Get surface handle for a slot
    pub fn surface(&self, slot_idx: usize) -> Option<&SurfaceHandle> {
        self.slots.get(slot_idx).and_then(|s| s.surface.as_ref())
    }
}

pub struct FrameSlotGuard<'a> {
    pool: &'a FramePool,
    slot_idx: usize,
}

impl<'a> FrameSlotGuard<'a> {
    /// Mark this slot as in-use until the given fence value completes
    pub fn set_fence(&self, value: u64) {
        self.pool.slots[self.slot_idx].fence_value.store(value, Ordering::Release);
    }
    
    pub fn surface(&self) -> &SurfaceHandle {
        self.pool.surface(self.slot_idx).unwrap()
    }
    
    pub fn slot_index(&self) -> usize {
        self.slot_idx
    }
}

impl Drop for FrameSlotGuard<'_> {
    fn drop(&mut self) {
        // If fence was never set, return to pool immediately
        let fence = self.pool.slots[self.slot_idx].fence_value.load(Ordering::Acquire);
        if fence == u64::MAX {
            self.pool.available_mask.fetch_or(1 << self.slot_idx, Ordering::Release);
        }
        // Otherwise, reclaim() will handle it when GPU completes
    }
}
```

### Batched GPU Buffer Uploads

```rust
// nitrate-layout/src/upload.rs

use std::mem::size_of;

/// Ring buffer for batched GPU uploads
/// 
/// Design:
/// - Single mapped staging buffer, reused each frame
/// - Write all node updates into contiguous region
/// - Single copy command to GPU buffer
pub struct UploadRing {
    /// Mapped staging buffer (persistently mapped)
    staging: wgpu::Buffer,
    staging_ptr: *mut u8,
    staging_size: usize,
    
    /// Current write offset within staging buffer
    write_offset: usize,
    
    /// Records of what was written (for copy commands)
    pending_copies: Vec<BufferCopy>,
}

struct BufferCopy {
    src_offset: u64,
    dst_offset: u64,
    size: u64,
}

impl UploadRing {
    /// Maximum staging buffer size (256KB should be plenty for UI nodes)
    const STAGING_SIZE: usize = 256 * 1024;
    
    pub fn new(device: &wgpu::Device) -> Self {
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Layout Upload Staging"),
            size: Self::STAGING_SIZE as u64,
            usage: wgpu::BufferUsages::MAP_WRITE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: true,
        });
        
        let staging_ptr = staging.slice(..).get_mapped_range_mut().as_mut_ptr();
        
        Self {
            staging,
            staging_ptr,
            staging_size: Self::STAGING_SIZE,
            write_offset: 0,
            pending_copies: Vec::with_capacity(64),
        }
    }
    
    /// Begin a new frame's uploads
    pub fn begin_frame(&mut self) {
        self.write_offset = 0;
        self.pending_copies.clear();
    }
    
    /// Write a node update to the staging buffer
    /// Returns false if staging buffer is full (should flush and retry)
    pub fn write_node(
        &mut self,
        node: &GpuNode,
        dst_buffer_offset: u64,
    ) -> bool {
        let node_size = size_of::<GpuNode>();
        
        if self.write_offset + node_size > self.staging_size {
            return false;
        }
        
        // Write to staging buffer
        unsafe {
            let dst = self.staging_ptr.add(self.write_offset) as *mut GpuNode;
            std::ptr::write(dst, *node);
        }
        
        // Record copy
        self.pending_copies.push(BufferCopy {
            src_offset: self.write_offset as u64,
            dst_offset: dst_buffer_offset,
            size: node_size as u64,
        });
        
        self.write_offset += node_size;
        true
    }
    
    /// Encode all pending copies into the command encoder
    pub fn flush(&self, encoder: &mut wgpu::CommandEncoder, dst_buffer: &wgpu::Buffer) {
        // Coalesce adjacent copies
        let mut coalesced = Vec::with_capacity(self.pending_copies.len());
        
        for copy in &self.pending_copies {
            if let Some(last) = coalesced.last_mut() {
                let last: &mut BufferCopy = last;
                // Check if this copy is adjacent to the last
                if last.src_offset + last.size == copy.src_offset
                    && last.dst_offset + last.size == copy.dst_offset
                {
                    // Extend the last copy
                    last.size += copy.size;
                    continue;
                }
            }
            coalesced.push(*copy);
        }
        
        // Encode copy commands
        for copy in coalesced {
            encoder.copy_buffer_to_buffer(
                &self.staging,
                copy.src_offset,
                dst_buffer,
                copy.dst_offset,
                copy.size,
            );
        }
    }
}
```

---

## 6. Spike Validation Plan

Before building the full system, these three spikes prove or disprove the critical assumptions:

### Spike 1: Linux DMA-BUF (Vulkan)

```rust
// spikes/linux_dmabuf/src/main.rs

//! Spike: VA-API decode → DMA-BUF → Vulkan import → render
//!
//! Success criteria:
//! - Video frame appears on screen
//! - No memcpy in perf trace
//! - Correct handling of DRM modifiers

use ash::vk;
use std::os::unix::io::RawFd;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Create Vulkan instance with required extensions
    let extensions = [
        ash::extensions::khr::ExternalMemoryFd::name(),
        ash::extensions::ext::ExternalMemoryDmaBuf::name(),
        ash::extensions::ext::ImageDrmFormatModifier::name(),
        ash::extensions::khr::TimelineSemaphore::name(),
        ash::extensions::khr::ExternalSemaphoreFd::name(),
    ];
    
    let instance = create_vulkan_instance(&extensions)?;
    let (physical_device, device, queue) = create_vulkan_device(&instance)?;
    
    // 2. Initialize VA-API with Vulkan interop
    let va_display = vaapi::Display::open()?;
    let va_config = va_display.create_config(
        vaapi::Profile::HEVC_Main10,
        vaapi::Entrypoint::VLD,
    )?;
    
    // 3. Create DMA-BUF exportable surfaces
    let surface = va_display.create_surface(
        7680, 4320,
        vaapi::RTFormat::YUV420_10,
        vaapi::SurfaceAttrib::MemoryType(vaapi::MemoryType::DrmPrime2),
    )?;
    
    // 4. Decode a frame
    let context = va_display.create_context(&va_config, 7680, 4320)?;
    decode_frame(&context, &surface, compressed_data)?;
    
    // 5. Export DMA-BUF handles
    let export = surface.export_prime2()?;
    let dma_buf_fd = export.objects[0].fd;
    let modifier = export.objects[0].drm_format_modifier;
    
    // 6. Import into Vulkan
    let vk_image = import_dmabuf_to_vulkan(
        &device,
        dma_buf_fd,
        7680, 4320,
        modifier,
    )?;
    
    // 7. Create image view and sample in shader
    let image_view = create_image_view(&device, vk_image)?;
    
    // 8. Render to swapchain
    render_frame(&device, &queue, image_view)?;
    
    println!("Spike 1 PASSED: DMA-BUF → Vulkan zero-copy working");
    Ok(())
}

fn import_dmabuf_to_vulkan(
    device: &ash::Device,
    fd: RawFd,
    width: u32,
    height: u32,
    modifier: u64,
) -> Result<vk::Image, vk::Result> {
    // This is the critical test: can we import with the decoder's modifier?
    
    let mut external_memory_info = vk::ExternalMemoryImageCreateInfo::builder()
        .handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
    
    let modifiers = [modifier];
    let mut modifier_list = vk::ImageDrmFormatModifierListCreateInfoEXT::builder()
        .drm_format_modifiers(&modifiers);
    
    let image_info = vk::ImageCreateInfo::builder()
        .image_type(vk::ImageType::TYPE_2D)
        .format(vk::Format::G10X6_B10X6R10X6_2PLANE_420_UNORM_3PACK16)
        .extent(vk::Extent3D { width, height, depth: 1 })
        .mip_levels(1)
        .array_layers(1)
        .samples(vk::SampleCountFlags::TYPE_1)
        .tiling(vk::ImageTiling::DRM_FORMAT_MODIFIER_EXT)
        .usage(vk::ImageUsageFlags::SAMPLED)
        .push_next(&mut external_memory_info)
        .push_next(&mut modifier_list);
    
    let image = unsafe { device.create_image(&image_info, None)? };
    
    // Import the memory
    let mut import_fd_info = vk::ImportMemoryFdInfoKHR::builder()
        .handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT)
        .fd(fd);
    
    let mem_reqs = unsafe { device.get_image_memory_requirements(image) };
    
    let alloc_info = vk::MemoryAllocateInfo::builder()
        .allocation_size(mem_reqs.size)
        .memory_type_index(find_memory_type(device, mem_reqs.memory_type_bits)?)
        .push_next(&mut import_fd_info);
    
    let memory = unsafe { device.allocate_memory(&alloc_info, None)? };
    unsafe { device.bind_image_memory(image, memory, 0)? };
    
    Ok(image)
}
```

### Spike 2: Windows D3D12 Shared Handle

```rust
// spikes/windows_shared/src/main.rs

//! Spike: Media Foundation decode → Shared Handle → D3D12 SRV → render

use windows::{
    Win32::Graphics::Direct3D12::*,
    Win32::Graphics::Dxgi::*,
    Win32::Media::MediaFoundation::*,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Create D3D12 device
    let device = create_d3d12_device()?;
    
    // 2. Create shared fence for sync
    let fence: ID3D12Fence = unsafe {
        device.CreateFence(0, D3D12_FENCE_FLAG_SHARED)?
    };
    
    let fence_handle = unsafe {
        device.CreateSharedHandle(&fence, None, GENERIC_ALL.0, None)?
    };
    
    // 3. Initialize Media Foundation with D3D12 integration
    let mf_dxgi_manager = create_dxgi_device_manager(&device)?;
    
    // 4. Create decoder
    let decoder = create_hevc_decoder(&mf_dxgi_manager)?;
    
    // 5. Decode frame (output is D3D12 texture)
    let decoded_texture = decode_frame(&decoder, compressed_data)?;
    
    // 6. Get shared handle for the decoded texture
    let shared_handle = unsafe {
        device.CreateSharedHandle(&decoded_texture, None, GENERIC_ALL.0, None)?
    };
    
    // 7. Open in render context (simulating separate context)
    let imported_texture: ID3D12Resource = unsafe {
        let mut resource = None;
        device.OpenSharedHandle(shared_handle, &mut resource)?;
        resource.unwrap()
    };
    
    // 8. Create SRV for NV12 planes
    // Note: D3D12 requires separate views for Y and UV planes
    let y_srv = create_srv_for_plane(&device, &imported_texture, 0)?;
    let uv_srv = create_srv_for_plane(&device, &imported_texture, 1)?;
    
    // 9. Wait on fence and render
    let fence_value = 1;
    command_queue.Wait(&fence, fence_value)?;
    render_frame(&device, y_srv, uv_srv)?;
    
    println!("Spike 2 PASSED: D3D12 shared handle zero-copy working");
    Ok(())
}

fn create_srv_for_plane(
    device: &ID3D12Device,
    texture: &ID3D12Resource,
    plane: u32,
) -> Result<D3D12_CPU_DESCRIPTOR_HANDLE, Error> {
    let desc = texture.GetDesc();
    
    // NV12 format requires specific plane selection
    let srv_desc = D3D12_SHADER_RESOURCE_VIEW_DESC {
        Format: if plane == 0 {
            DXGI_FORMAT_R8_UNORM  // Y plane
        } else {
            DXGI_FORMAT_R8G8_UNORM  // UV plane
        },
        ViewDimension: D3D12_SRV_DIMENSION_TEXTURE2D,
        Shader4ComponentMapping: D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING,
        Anonymous: D3D12_SHADER_RESOURCE_VIEW_DESC_0 {
            Texture2D: D3D12_TEX2D_SRV {
                MostDetailedMip: 0,
                MipLevels: 1,
                PlaneSlice: plane,
                ResourceMinLODClamp: 0.0,
            },
        },
    };
    
    let handle = allocate_descriptor(device)?;
    unsafe {
        device.CreateShaderResourceView(texture, Some(&srv_desc), handle);
    }
    Ok(handle)
}
```

### Spike 3: macOS IOSurface

```rust
// spikes/macos_iosurface/src/main.rs

//! Spike: VideoToolbox decode → IOSurface → Metal texture → render

use metal::{Device, Texture};
use core_video_sys::*;
use core_media_sys::*;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Create Metal device
    let device = Device::system_default().expect("No Metal device");
    
    // 2. Create CVMetalTextureCache for zero-copy texture creation
    let texture_cache = create_metal_texture_cache(&device)?;
    
    // 3. Create VideoToolbox decoder
    let decoder = create_vt_decoder(7680, 4320, kCMVideoCodecType_HEVC)?;
    
    // 4. Decode frame - output is CVPixelBuffer backed by IOSurface
    let pixel_buffer = decode_frame(&decoder, compressed_data)?;
    
    // 5. Verify IOSurface backing
    let io_surface = unsafe { CVPixelBufferGetIOSurface(pixel_buffer) };
    assert!(!io_surface.is_null(), "CVPixelBuffer must be IOSurface-backed");
    
    // 6. Create Metal textures from planes (zero-copy!)
    let y_texture = create_texture_from_plane(&texture_cache, pixel_buffer, 0)?;
    let uv_texture = create_texture_from_plane(&texture_cache, pixel_buffer, 1)?;
    
    // 7. Verify textures share memory with decoder output
    let y_iosurface = y_texture.iosurface();
    assert_eq!(y_iosurface as *const _, io_surface, "Must share IOSurface");
    
    // 8. Render
    render_frame(&device, y_texture, uv_texture)?;
    
    println!("Spike 3 PASSED: IOSurface → Metal zero-copy working");
    Ok(())
}

fn create_texture_from_plane(
    cache: &CVMetalTextureCache,
    pixel_buffer: CVPixelBufferRef,
    plane: usize,
) -> Result<Texture, Error> {
    let width = unsafe { CVPixelBufferGetWidthOfPlane(pixel_buffer, plane) };
    let height = unsafe { CVPixelBufferGetHeightOfPlane(pixel_buffer, plane) };
    
    let format = match plane {
        0 => MTLPixelFormat::R8Unorm,   // Y plane
        1 => MTLPixelFormat::RG8Unorm,  // UV plane
        _ => panic!("Invalid plane"),
    };
    
    let mut texture_ref: CVMetalTextureRef = std::ptr::null_mut();
    let status = unsafe {
        CVMetalTextureCacheCreateTextureFromImage(
            std::ptr::null(),  // allocator
            cache.as_ptr(),
            pixel_buffer,
            std::ptr::null(),  // texture attributes
            format as u64,
            width,
            height,
            plane,
            &mut texture_ref,
        )
    };
    
    if status != 0 {
        return Err(Error::TextureCreationFailed(status));
    }
    
    // Extract Metal texture from CV wrapper
    let metal_texture = unsafe { CVMetalTextureGetTexture(texture_ref) };
    
    Ok(Texture::from_raw(metal_texture))
}
```

---

## 7. Revised Module Hierarchy

```
nitrate/
├── nitrate-core/                 # Shared types, error handling
│
├── nitrate-pal/                  # Platform Abstraction (CRITICAL PATH)
│   ├── lib.rs                    # Trait definitions + capability detection
│   ├── surface.rs                # ImportedSurface type (boundary object)
│   ├── sync.rs                   # SyncTier + SyncStrategy traits
│   ├── vulkan/                   # ash-based Vulkan implementation
│   │   ├── device.rs             # Device creation with extensions
│   │   ├── import.rs             # DMA-BUF import
│   │   ├── timeline.rs           # Timeline semaphore
│   │   └── compose.rs            # Native composition pass
│   ├── dx12/                     # windows-rs D3D12 implementation
│   │   ├── device.rs
│   │   ├── import.rs             # Shared handle import
│   │   ├── fence.rs              # ID3D12Fence
│   │   └── compose.rs
│   └── metal/                    # metal-rs implementation
│       ├── device.rs
│       ├── import.rs             # IOSurface import
│       ├── event.rs              # MTLSharedEvent
│       └── compose.rs
│
├── nitrate-color/                # Color management (NEW)
│   ├── lib.rs
│   ├── metadata.rs               # ColorMetadata parsing from containers
│   ├── matrix.rs                 # YUV→RGB matrices
│   ├── transfer.rs               # EOTF/OETF functions
│   ├── tonemap.rs                # HDR→SDR tone mapping
│   └── gamut.rs                  # Gamut mapping (BT.2020→BT.709)
│
├── nitrate-decode/               # Hardware video decoding
│   ├── lib.rs
│   ├── pool.rs                   # Fixed-capacity frame pool
│   ├── timeline.rs               # Frame timeline tracking
│   └── platform/
│       ├── vaapi.rs              # Linux VA-API
│       ├── mf.rs                 # Windows Media Foundation
│       └── vt.rs                 # macOS VideoToolbox
│
├── nitrate-style/                # CSS compilation (unchanged)
├── nitrate-layout/               # Layout with batched upload (revised)
│   ├── cache.rs                  # Red-Green incremental
│   └── upload.rs                 # Batched GPU upload ring
│
├── nitrate-ui/                   # UI rendering (wgpu only)
│   ├── lib.rs
│   ├── vello.rs                  # Vello integration
│   └── target.rs                 # UI render target management
│
├── nitrate-compositor/           # Final composition (native APIs)
│   ├── lib.rs
│   ├── compose.rs                # Two-pass composition orchestration
│   ├── shaders/
│   │   └── compose.wgsl          # Color-correct composition shader
│   └── present.rs                # Swapchain + frame pacing
│
└── nitrate-app/                  # Application framework
```

---

## 8. Summary: What Changed

| Original Design | Revised Design | Rationale |
|-----------------|----------------|-----------|
| wgpu for entire pipeline | wgpu for UI only; native APIs for composition | wgpu external texture import is not stable/complete |
| Abstract timeline semaphore trait | Explicit sync tiers with fallback chain | Platform capabilities vary; need graceful degradation |
| Per-pixel UI node loop in shader | Two-pass: Vello → RT, then compose | O(n) per-pixel is non-viable |
| Implicit color handling | Formal ColorMetadata + parameterized shader | HDR correctness requires explicit metadata |
| DashMap for fence tracking | Fixed-capacity array with AtomicU64 | Budget compliance + no allocation |
| Many small write_buffer calls | Single staging ring with batched copy | Reduce staging churn |

The critical insight from your review—**that the interop layer is the risk**—is now reflected in the architecture. The spikes exist to validate assumptions before the rest of the system is built. If any spike fails, it informs which fallback tier becomes the primary path for that platform.
