# Project NITRATE: Final Architecture Specification

## Explicit Bridge Decisions

This section addresses the remaining underspecified elements with concrete, implementation-ready choices.

---

## 1. The wgpu ↔ Native Synchronization Bridge

### Decision: Option A (Native-Controlled Submission) with Option B Fallback

The architecture uses wgpu as a **command generator**, not an end-to-end scheduler. Native code intercepts submission and attaches synchronization primitives.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                    SUBMISSION CONTROL: NATIVE-OWNED COMMAND PATH                         │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │                              WGPU LAYER                                           │  │
│  │                         (Command Generation Only)                                 │  │
│  │                                                                                   │  │
│  │  1. Build Vello scene                                                             │  │
│  │  2. Encode compute passes → wgpu::CommandBuffer                                   │  │
│  │  3. DO NOT CALL queue.submit()                                                    │  │
│  │  4. Instead: extract raw command buffer via HAL                                   │  │
│  │                                                                                   │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│                                         │                                                │
│                          Raw VkCommandBuffer / ID3D12CommandList                        │
│                                         ▼                                                │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │                             NATIVE LAYER                                          │  │
│  │                        (Submission + Sync Control)                                │  │
│  │                                                                                   │  │
│  │  vkQueueSubmit2 / ID3D12CommandQueue::ExecuteCommandLists                         │  │
│  │                                                                                   │  │
│  │  Wait Semaphores:                                                                 │  │
│  │    • video_decode_complete (value: frame_id)                                      │  │
│  │                                                                                   │  │
│  │  Signal Semaphores:                                                               │  │
│  │    • ui_render_complete (value: frame_id)                                         │  │
│  │                                                                                   │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│                                         │                                                │
│                                         ▼                                                │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │                          NATIVE COMPOSITION PASS                                  │  │
│  │                                                                                   │  │
│  │  Wait: ui_render_complete (value: frame_id)                                       │  │
│  │  Execute: video sample + UI sample + blend → swapchain                            │  │
│  │  Signal: present_ready (value: frame_id)                                          │  │
│  │                                                                                   │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Implementation: Command Buffer Extraction

```rust
// nitrate-compositor/src/submission.rs

use wgpu::hal::api::Vulkan as VulkanApi;
use ash::vk;

/// Trait for platform-specific submission with sync control
pub trait NativeSubmitter: Send + Sync {
    /// Submit UI render commands with explicit sync
    fn submit_ui_render(
        &self,
        commands: ExtractedCommands,
        wait_ops: &[SyncWaitOp],
        signal_ops: &[SyncSignalOp],
    ) -> Result<(), Error>;
    
    /// Submit composition pass
    fn submit_compose(
        &self,
        wait_ops: &[SyncWaitOp],
        signal_ops: &[SyncSignalOp],
    ) -> Result<(), Error>;
}

/// Commands extracted from wgpu for native submission
pub enum ExtractedCommands {
    Vulkan(Vec<vk::CommandBuffer>),
    #[cfg(windows)]
    D3D12(Vec<*mut std::ffi::c_void>), // ID3D12CommandList*
    #[cfg(target_os = "macos")]
    Metal(*mut std::ffi::c_void), // MTLCommandBuffer
}

pub struct SyncWaitOp {
    pub semaphore: SemaphoreHandle,
    pub value: u64,
    pub stage: PipelineStage,
}

pub struct SyncSignalOp {
    pub semaphore: SemaphoreHandle,
    pub value: u64,
}

/// Extract raw command buffers from wgpu encoder
/// 
/// # Safety
/// The returned command buffers are only valid until the next wgpu operation
/// that could invalidate them. Submit immediately.
pub unsafe fn extract_commands(
    device: &wgpu::Device,
    encoder: wgpu::CommandEncoder,
) -> Result<ExtractedCommands, Error> {
    // Finish the encoder to get a CommandBuffer
    let command_buffer = encoder.finish();
    
    // Extract the raw handle via HAL
    device.as_hal::<VulkanApi, _, _>(|hal_device| {
        let hal_device = hal_device.ok_or(Error::NoHalAccess)?;
        
        // Access the command buffer's raw handle
        // Note: This requires wgpu internals access - the exact API depends on wgpu version
        command_buffer.as_hal::<VulkanApi, _, _>(|hal_cmd| {
            hal_cmd.map(|cmd| ExtractedCommands::Vulkan(vec![cmd.raw_handle()]))
        }).flatten().ok_or(Error::CommandExtractionFailed)
    }).ok_or(Error::NoHalAccess)?
}

// Vulkan implementation
pub struct VulkanSubmitter {
    device: Arc<ash::Device>,
    queue: vk::Queue,
    queue_family: u32,
}

impl NativeSubmitter for VulkanSubmitter {
    fn submit_ui_render(
        &self,
        commands: ExtractedCommands,
        wait_ops: &[SyncWaitOp],
        signal_ops: &[SyncSignalOp],
    ) -> Result<(), Error> {
        let ExtractedCommands::Vulkan(cmd_buffers) = commands else {
            return Err(Error::WrongBackend);
        };
        
        // Build wait semaphore infos
        let wait_infos: Vec<vk::SemaphoreSubmitInfo> = wait_ops.iter()
            .map(|op| {
                vk::SemaphoreSubmitInfo::builder()
                    .semaphore(op.semaphore.as_vulkan())
                    .value(op.value)
                    .stage_mask(op.stage.to_vulkan())
                    .build()
            })
            .collect();
        
        // Build signal semaphore infos
        let signal_infos: Vec<vk::SemaphoreSubmitInfo> = signal_ops.iter()
            .map(|op| {
                vk::SemaphoreSubmitInfo::builder()
                    .semaphore(op.semaphore.as_vulkan())
                    .value(op.value)
                    .stage_mask(vk::PipelineStageFlags2::ALL_COMMANDS)
                    .build()
            })
            .collect();
        
        // Build command buffer infos
        let cmd_infos: Vec<vk::CommandBufferSubmitInfo> = cmd_buffers.iter()
            .map(|&cmd| {
                vk::CommandBufferSubmitInfo::builder()
                    .command_buffer(cmd)
                    .build()
            })
            .collect();
        
        let submit_info = vk::SubmitInfo2::builder()
            .wait_semaphore_infos(&wait_infos)
            .command_buffer_infos(&cmd_infos)
            .signal_semaphore_infos(&signal_infos);
        
        unsafe {
            self.device.queue_submit2(
                self.queue,
                std::slice::from_ref(&submit_info),
                vk::Fence::null(),
            )?;
        }
        
        Ok(())
    }
    
    fn submit_compose(
        &self,
        wait_ops: &[SyncWaitOp],
        signal_ops: &[SyncSignalOp],
    ) -> Result<(), Error> {
        // Similar to above, but with pre-recorded composition command buffer
        // (composition commands are recorded once and reused)
        unimplemented!("Composition submission")
    }
}
```

### Fallback: Tier C for UI→Compose (Option B)

If command extraction proves too brittle on a platform, fall back to CPU coordination:

```rust
// nitrate-compositor/src/submission.rs

pub struct TierCSubmitter {
    wgpu_queue: wgpu::Queue,
    native_submitter: Box<dyn NativeSubmitter>,
    /// Callback receiver for submission completion
    completion_rx: crossbeam::channel::Receiver<()>,
}

impl TierCSubmitter {
    pub fn submit_ui_render(
        &self,
        encoder: wgpu::CommandEncoder,
    ) -> Result<(), Error> {
        let command_buffer = encoder.finish();
        
        // Submit through wgpu (we lose sync control)
        self.wgpu_queue.submit(std::iter::once(command_buffer));
        
        // Register completion callback
        let (tx, rx) = crossbeam::channel::bounded(1);
        self.wgpu_queue.on_submitted_work_done(move || {
            let _ = tx.send(());
        });
        
        // Block until complete (this is the latency hit)
        rx.recv().map_err(|_| Error::SubmissionLost)?;
        
        Ok(())
    }
}
```

### Platform Decision Matrix

| Platform | Primary Strategy | Fallback |
|----------|-----------------|----------|
| Linux (Vulkan) | Option A: Native submission with `vkQueueSubmit2` | Option B: CPU coordination |
| Windows (DX12) | Option A: Native submission with `ExecuteCommandLists` | Option B: CPU coordination |
| macOS (Metal) | Option A: Native submission with `MTLCommandBuffer` | Option C: Native UI render (if A fails) |

---

## 2. Device Identity: Native-First Creation

### Decision: Native Creates Device, wgpu Wraps It

```rust
// nitrate-pal/src/device.rs

/// Unified device that native owns and wgpu borrows
pub struct UnifiedDevice {
    // Native handles (owned)
    pub vulkan: Option<VulkanDevice>,
    pub d3d12: Option<D3D12Device>,
    pub metal: Option<MetalDevice>,
    
    // wgpu wrapper (borrows native device)
    pub wgpu_instance: wgpu::Instance,
    pub wgpu_adapter: wgpu::Adapter,
    pub wgpu_device: wgpu::Device,
    pub wgpu_queue: wgpu::Queue,
}

pub struct VulkanDevice {
    pub instance: Arc<ash::Instance>,
    pub physical_device: vk::PhysicalDevice,
    pub device: Arc<ash::Device>,
    pub queue: vk::Queue,
    pub queue_family: u32,
    
    // Extension function loaders
    pub timeline_semaphore: ash::extensions::khr::TimelineSemaphore,
    pub external_memory_fd: ash::extensions::khr::ExternalMemoryFd,
    pub external_semaphore_fd: ash::extensions::khr::ExternalSemaphoreFd,
}

impl UnifiedDevice {
    pub fn new_vulkan() -> Result<Self, Error> {
        // 1. Create Vulkan instance with required extensions
        let instance = create_vulkan_instance(&[
            ash::extensions::khr::Surface::name(),
            ash::extensions::khr::ExternalMemoryCapabilities::name(),
            ash::extensions::khr::ExternalSemaphoreCapabilities::name(),
            // Platform-specific surface extension
            #[cfg(target_os = "linux")]
            ash::extensions::khr::WaylandSurface::name(),
            #[cfg(target_os = "linux")]
            ash::extensions::khr::XlibSurface::name(),
        ])?;
        
        // 2. Select physical device with required features
        let physical_device = select_physical_device(&instance, &[
            // Required device extensions
            ash::extensions::khr::Swapchain::name(),
            ash::extensions::khr::TimelineSemaphore::name(),
            ash::extensions::khr::ExternalMemoryFd::name(),
            ash::extensions::khr::ExternalSemaphoreFd::name(),
            ash::extensions::ext::ExternalMemoryDmaBuf::name(),
            ash::extensions::ext::ImageDrmFormatModifier::name(),
        ])?;
        
        // 3. Create logical device with timeline semaphore feature
        let mut timeline_features = vk::PhysicalDeviceTimelineSemaphoreFeatures::builder()
            .timeline_semaphore(true);
        
        let mut vulkan12_features = vk::PhysicalDeviceVulkan12Features::builder()
            .timeline_semaphore(true)
            .push_next(&mut timeline_features);
        
        let device = create_vulkan_device(
            &instance,
            physical_device,
            &mut vulkan12_features,
        )?;
        
        let vulkan_device = VulkanDevice {
            instance: Arc::new(instance),
            physical_device,
            device: Arc::new(device),
            queue: get_queue(&device, queue_family, 0),
            queue_family,
            timeline_semaphore: ash::extensions::khr::TimelineSemaphore::new(&instance, &device),
            external_memory_fd: ash::extensions::khr::ExternalMemoryFd::new(&instance, &device),
            external_semaphore_fd: ash::extensions::khr::ExternalSemaphoreFd::new(&instance, &device),
        };
        
        // 4. Create wgpu instance/adapter/device ON TOP of native device
        let wgpu_instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN,
            ..Default::default()
        });
        
        // Use unsafe HAL access to wrap our existing device
        let (wgpu_adapter, wgpu_device, wgpu_queue) = unsafe {
            create_wgpu_from_vulkan_device(
                &wgpu_instance,
                &vulkan_device,
            )?
        };
        
        Ok(Self {
            vulkan: Some(vulkan_device),
            d3d12: None,
            metal: None,
            wgpu_instance,
            wgpu_adapter,
            wgpu_device,
            wgpu_queue,
        })
    }
}

/// Create wgpu device wrapping an existing Vulkan device
/// 
/// # Safety
/// The Vulkan device must remain valid for the lifetime of the wgpu device.
/// The caller is responsible for ensuring this.
unsafe fn create_wgpu_from_vulkan_device(
    instance: &wgpu::Instance,
    vulkan: &VulkanDevice,
) -> Result<(wgpu::Adapter, wgpu::Device, wgpu::Queue), Error> {
    use wgpu::hal::api::Vulkan;
    
    // Create HAL instance wrapping our Vulkan instance
    let hal_instance = <Vulkan as wgpu::hal::Api>::Instance::from_raw(
        vulkan.instance.handle(),
        vulkan.instance.clone(),
        wgpu::hal::InstanceFlags::empty(),
        vec![], // enabled extensions (already handled)
    )?;
    
    // Expose the physical device as a HAL adapter
    let hal_exposed = hal_instance.expose_adapter(vulkan.physical_device)?;
    
    // Create HAL device wrapping our Vulkan device
    let hal_open = hal_exposed.adapter.device_from_raw(
        vulkan.device.handle(),
        true, // owns_device = true means HAL won't destroy it
        &[], // enabled extensions
        wgpu::hal::DeviceFeatures::default(),
        vulkan.queue_family,
        0, // queue index
    )?;
    
    // Wrap in wgpu types
    let adapter = instance.create_adapter_from_hal::<Vulkan>(hal_exposed);
    let (device, queue) = adapter.create_device_from_hal::<Vulkan>(
        hal_open,
        &wgpu::DeviceDescriptor {
            label: Some("NITRATE Device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
        },
        None,
    )?;
    
    Ok((adapter, device, queue))
}
```

---

## 3. UI Render Target: RGBA8 with VRAM Budget

### Decision: RGBA8 for UI, Linear Sampling, Defined Reference White for HDR

```rust
// nitrate-ui/src/target.rs

/// UI render target configuration
pub struct UiTargetConfig {
    /// Resolution (may be lower than display for VRAM savings)
    pub width: u32,
    pub height: u32,
    
    /// Format: always RGBA8 to fit VRAM budget
    /// - For SDR: Rgba8UnormSrgb (hardware linearizes on sample)
    /// - For HDR: Rgba8Unorm (shader handles conversion)
    pub format: UiTargetFormat,
    
    /// Reference white level for HDR compositing (nits)
    /// UI is authored for SDR; this defines how bright "white" is in HDR output
    pub reference_white_nits: f32,
}

#[derive(Clone, Copy)]
pub enum UiTargetFormat {
    /// sRGB: hardware linearizes on sample, ideal for SDR output
    Srgb,
    /// Linear UNORM: shader must handle conversion, needed for precise HDR control
    LinearUnorm,
}

impl Default for UiTargetConfig {
    fn default() -> Self {
        Self {
            width: 3840,  // 4K for 8K display (2x downsample is acceptable for UI)
            height: 2160,
            format: UiTargetFormat::Srgb,
            reference_white_nits: 80.0, // Standard SDR reference white
        }
    }
}

impl UiTargetConfig {
    /// Calculate VRAM usage
    pub fn vram_bytes(&self) -> u64 {
        // RGBA8 = 4 bytes per pixel
        self.width as u64 * self.height as u64 * 4
    }
    
    /// Validate against budget
    pub fn validate(&self, max_vram_mb: u64) -> Result<(), Error> {
        let usage_mb = self.vram_bytes() / (1024 * 1024);
        if usage_mb > max_vram_mb {
            return Err(Error::VramBudgetExceeded {
                requested: usage_mb,
                budget: max_vram_mb,
            });
        }
        Ok(())
    }
}

// VRAM budget example:
// 4K RGBA8 UI RT: 3840 * 2160 * 4 = ~33 MB (acceptable)
// 8K RGBA8 UI RT: 7680 * 4320 * 4 = ~132 MB (too large, use 4K)
```

### UI Resolution Strategy

```rust
// nitrate-ui/src/target.rs

/// Select UI resolution based on display and VRAM budget
pub fn select_ui_resolution(
    display_width: u32,
    display_height: u32,
    vram_budget_mb: u64,
) -> (u32, u32) {
    // Target: UI RT should be ≤50MB to leave room for video frames
    const UI_BUDGET_MB: u64 = 50;
    
    let mut width = display_width;
    let mut height = display_height;
    
    // Downsample until within budget
    while (width as u64 * height as u64 * 4) > (UI_BUDGET_MB * 1024 * 1024) {
        width = (width + 1) / 2;
        height = (height + 1) / 2;
    }
    
    // Ensure minimum resolution
    width = width.max(1920);
    height = height.max(1080);
    
    (width, height)
}

// For 8K display: select_ui_resolution(7680, 4320, 50) → (3840, 2160)
// UI is rendered at 4K, bilinear upscaled during composition
```

---

## 4. Swapchain Format and OETF Specification

### Decision: sRGB Swapchain for SDR, Explicit Formats per Platform

```rust
// nitrate-compositor/src/swapchain.rs

/// Swapchain configuration with explicit format semantics
pub struct SwapchainConfig {
    pub width: u32,
    pub height: u32,
    pub format: SwapchainFormat,
    pub present_mode: PresentMode,
}

#[derive(Clone, Copy)]
pub enum SwapchainFormat {
    /// SDR: sRGB format, hardware applies OETF on write
    /// Shader outputs LINEAR values, format encodes to sRGB
    Sdr {
        vulkan: vk::Format,  // VK_FORMAT_B8G8R8A8_SRGB
        d3d12: u32,          // DXGI_FORMAT_R8G8B8A8_UNORM_SRGB
        metal: u32,          // MTLPixelFormatBGRA8Unorm_sRGB
    },
    
    /// HDR10: 10-bit with PQ transfer function
    /// Shader outputs PQ-encoded values (not linear!)
    Hdr10 {
        vulkan: vk::Format,  // VK_FORMAT_A2B10G10R10_UNORM_PACK32
        d3d12: u32,          // DXGI_FORMAT_R10G10B10A2_UNORM
        metal: u32,          // MTLPixelFormatBGR10A2Unorm
    },
    
    /// HDR scRGB: 16-bit float linear
    /// Shader outputs LINEAR values, display handles conversion
    HdrScrgb {
        vulkan: vk::Format,  // VK_FORMAT_R16G16B16A16_SFLOAT
        d3d12: u32,          // DXGI_FORMAT_R16G16B16A16_FLOAT
        metal: u32,          // MTLPixelFormatRGBA16Float
    },
}

impl SwapchainFormat {
    /// Does the hardware apply transfer function on write?
    pub fn hardware_encodes(&self) -> bool {
        match self {
            Self::Sdr { .. } => true,   // sRGB formats auto-encode
            Self::Hdr10 { .. } => false, // UNORM, shader must encode PQ
            Self::HdrScrgb { .. } => false, // Linear, display applies EOTF
        }
    }
    
    /// What should the shader output?
    pub fn shader_output_space(&self) -> OutputSpace {
        match self {
            Self::Sdr { .. } => OutputSpace::Linear, // Hardware encodes
            Self::Hdr10 { .. } => OutputSpace::Pq,   // Shader must PQ-encode
            Self::HdrScrgb { .. } => OutputSpace::Linear, // Display decodes
        }
    }
}

#[derive(Clone, Copy)]
pub enum OutputSpace {
    /// Output linear values; hardware or display applies OETF
    Linear,
    /// Output PQ-encoded values (for HDR10 UNORM targets)
    Pq,
}
```

### Composition Shader with Format Awareness

```wgsl
// nitrate-compositor/shaders/compose.wgsl

struct OutputConfig {
    /// 0 = linear (hardware encodes), 1 = PQ (shader encodes)
    output_space: u32,
    /// Reference white for UI in nits (e.g., 80.0 for SDR reference)
    ui_reference_white: f32,
    /// Display max luminance (for HDR UI lifting)
    display_max_nits: f32,
    _pad: f32,
}

@group(0) @binding(5) var<uniform> output: OutputConfig;

// ... (previous color pipeline code) ...

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    // 1-6: Process video (as before, result is linear normalized [0,1])
    var video_linear = process_video(uv);
    
    // 7. Sample UI (sRGB texture → hardware linearizes → linear values)
    let ui = textureSample(ui_texture, linear_sampler, uv);
    
    // 8. For HDR output: lift UI from SDR to HDR
    var ui_linear = ui.rgb;
    if output.output_space == 1u {
        // Scale UI by reference white relative to display max
        // e.g., 80 nits / 1000 nits = 0.08 for typical HDR10
        ui_linear = ui_linear * (output.ui_reference_white / output.display_max_nits);
    }
    
    // 9. Composite in LINEAR space (always correct)
    let composited_linear = ui_linear * ui.a + video_linear * (1.0 - ui.a);
    
    // 10. Apply output transfer function based on swapchain format
    var output_color: vec3<f32>;
    switch output.output_space {
        case 0u: {
            // SDR sRGB format: output linear, hardware encodes
            output_color = saturate(composited_linear);
        }
        case 1u: {
            // HDR10 UNORM format: output PQ-encoded
            // Scale to absolute nits first
            let nits = composited_linear * output.display_max_nits;
            output_color = oetf_pq(nits);
        }
        default: {
            output_color = saturate(composited_linear);
        }
    }
    
    return vec4(output_color, 1.0);
}

// PQ OETF (inverse of EOTF)
fn oetf_pq(nits: vec3<f32>) -> vec3<f32> {
    let y = nits / 10000.0; // Normalize to [0, 1]
    let m1 = 0.1593017578125;
    let m2 = 78.84375;
    let c1 = 0.8359375;
    let c2 = 18.8515625;
    let c3 = 18.6875;
    
    let ym1 = pow(max(y, vec3(0.0)), vec3(m1));
    let num = c1 + c2 * ym1;
    let den = 1.0 + c3 * ym1;
    return pow(num / den, vec3(m2));
}
```

---

## 5. DMA-BUF Spike with Explicit Plane Layouts

### Corrected Vulkan Import Using Explicit Layouts

```rust
// spikes/linux_dmabuf/src/import.rs

use ash::vk;

/// Import DMA-BUF with explicit plane layouts (required for real-world content)
pub fn import_dmabuf_explicit(
    device: &ash::Device,
    desc: &DmaBufDescriptor,
) -> Result<ImportedImage, Error> {
    // Validate: we expect a single layer with 2 planes for NV12
    if desc.layers.len() != 1 || desc.layers[0].planes.len() != 2 {
        return Err(Error::UnsupportedFormat);
    }
    
    let layer = &desc.layers[0];
    let width = infer_width_from_stride(layer)?;
    let height = infer_height(desc)?;
    
    // Build explicit plane layouts from PRIME2 descriptor
    let plane_layouts: Vec<vk::SubresourceLayout> = layer.planes.iter()
        .map(|plane| {
            vk::SubresourceLayout {
                offset: plane.offset,
                size: 0,  // Derived from image dimensions
                row_pitch: plane.stride as u64,
                array_pitch: 0,
                depth_pitch: 0,
            }
        })
        .collect();
    
    // Get modifier from the object backing plane 0
    let modifier = desc.objects[layer.planes[0].object_index as usize].modifier;
    
    // Use EXPLICIT create info (not list)
    let mut drm_explicit_info = vk::ImageDrmFormatModifierExplicitCreateInfoEXT::builder()
        .drm_format_modifier(modifier)
        .plane_layouts(&plane_layouts);
    
    let mut external_memory_info = vk::ExternalMemoryImageCreateInfo::builder()
        .handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
    
    let image_info = vk::ImageCreateInfo::builder()
        .image_type(vk::ImageType::TYPE_2D)
        .format(drm_format_to_vulkan(layer.drm_format)?)
        .extent(vk::Extent3D { width, height, depth: 1 })
        .mip_levels(1)
        .array_layers(1)
        .samples(vk::SampleCountFlags::TYPE_1)
        .tiling(vk::ImageTiling::DRM_FORMAT_MODIFIER_EXT)
        .usage(vk::ImageUsageFlags::SAMPLED)
        .sharing_mode(vk::SharingMode::EXCLUSIVE)
        .push_next(&mut external_memory_info)
        .push_next(&mut drm_explicit_info);
    
    let image = unsafe { device.create_image(&image_info, None)? };
    
    // Bind memory from each object
    // For single-object case (common), import fd and bind
    let fd = desc.objects[0].fd.as_raw_fd();
    
    let mut import_info = vk::ImportMemoryFdInfoKHR::builder()
        .handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT)
        .fd(fd);
    
    let mem_reqs = unsafe { device.get_image_memory_requirements(image) };
    
    let alloc_info = vk::MemoryAllocateInfo::builder()
        .allocation_size(mem_reqs.size)
        .memory_type_index(find_memory_type(device, mem_reqs.memory_type_bits)?)
        .push_next(&mut import_info);
    
    let memory = unsafe { device.allocate_memory(&alloc_info, None)? };
    unsafe { device.bind_image_memory(image, memory, 0)? };
    
    // Create per-plane image views
    let y_view = create_plane_view(device, image, vk::ImageAspectFlags::PLANE_0)?;
    let uv_view = create_plane_view(device, image, vk::ImageAspectFlags::PLANE_1)?;
    
    Ok(ImportedImage {
        image,
        memory,
        y_view,
        uv_view,
        width,
        height,
    })
}

fn create_plane_view(
    device: &ash::Device,
    image: vk::Image,
    aspect: vk::ImageAspectFlags,
) -> Result<vk::ImageView, vk::Result> {
    let format = match aspect {
        vk::ImageAspectFlags::PLANE_0 => vk::Format::R8_UNORM,  // Y plane
        vk::ImageAspectFlags::PLANE_1 => vk::Format::R8G8_UNORM, // UV plane
        _ => return Err(vk::Result::ERROR_FORMAT_NOT_SUPPORTED),
    };
    
    let view_info = vk::ImageViewCreateInfo::builder()
        .image(image)
        .view_type(vk::ImageViewType::TYPE_2D)
        .format(format)
        .subresource_range(vk::ImageSubresourceRange {
            aspect_mask: aspect,
            base_mip_level: 0,
            level_count: 1,
            base_array_layer: 0,
            layer_count: 1,
        });
    
    unsafe { device.create_image_view(&view_info, None) }
}

fn drm_format_to_vulkan(drm_format: u32) -> Result<vk::Format, Error> {
    // DRM_FORMAT_NV12 = 0x3231564E ("NV12" in little-endian)
    const DRM_FORMAT_NV12: u32 = 0x3231564E;
    // DRM_FORMAT_P010 = 0x30313050 ("P010" in little-endian)
    const DRM_FORMAT_P010: u32 = 0x30313050;
    
    match drm_format {
        DRM_FORMAT_NV12 => Ok(vk::Format::G8_B8R8_2PLANE_420_UNORM),
        DRM_FORMAT_P010 => Ok(vk::Format::G10X6_B10X6R10X6_2PLANE_420_UNORM_3PACK16),
        _ => Err(Error::UnsupportedDrmFormat(drm_format)),
    }
}
```

---

## 6. Updated Spike Pass Criteria

### Spike 1: Linux DMA-BUF

**Pass criteria:**
- [ ] Import works with **explicit plane layouts** (not just modifier list)
- [ ] Plane offsets and strides from PRIME2 are honored
- [ ] Multi-plane image views sample correct data (Y vs UV)
- [ ] sync_file import works (explicit sync, not implicit)
- [ ] Timeline semaphore wait/signal works across decode→compose

### Spike 2: Windows D3D12

**Pass criteria:**
- [ ] Shared handle import works
- [ ] Per-plane SRVs sample correctly
- [ ] ID3D12Fence wait/signal works across decode→compose
- [ ] wgpu device created on same ID3D12Device as decoder

### Spike 3: macOS IOSurface

**Pass criteria:**
- [ ] CVMetalTextureCache import works
- [ ] Planes share backing IOSurface with decoder
- [ ] MTLSharedEvent wait/signal works
- [ ] wgpu device created on same MTLDevice

### Spike 4: wgpu↔Native Bridge (NEW)

**Pass criteria:**
- [ ] wgpu device successfully wraps native-created device
- [ ] Command buffer extraction via HAL works
- [ ] Native submission with attached semaphores works
- [ ] UI RT (native-owned) successfully imported into wgpu
- [ ] Full pipeline: native decode → wgpu UI render → native compose → present

---

## Summary: What Is Now Explicit

| Decision Point | Choice |
|----------------|--------|
| **Submission control** | Native-controlled (Option A), with Tier C fallback (Option B) |
| **Device identity** | Native creates, wgpu wraps via HAL |
| **UI RT format** | RGBA8 (Srgb or Unorm), ≤50MB budget |
| **UI resolution** | Scale to fit VRAM; 4K for 8K displays |
| **Swapchain format** | sRGB for SDR (hardware encodes), explicit per-platform |
| **Shader output** | Linear for sRGB targets, PQ-encoded for HDR10 UNORM |
| **DMA-BUF import** | Explicit plane layouts via `VkImageDrmFormatModifierExplicitCreateInfoEXT` |
| **Sync Tier B** | sync_file first-class, implicit as last resort |
| **Compositing** | Always in linear light; OETF applied once at end |

The architecture is now implementation-ready pending spike validation of the wgpu↔native bridge.
