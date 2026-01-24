# NITRATE Implementation Details

**Supplement to `architecture.md`**

## 1. Memory Strategy: "Pressure-Aware" Pools

To maintain the **<100MB CPU footprint** while handling **132MB 8K frames**, we strictly forbid CPU-side allocation of video frames.

### 1.1 The Fixed Pool
We use a pre-allocated ring of GPU resources tracked by atomic fences.

```rust
// nitrate-decode/src/pool.rs

const POOL_SIZE: usize = 8;

pub struct FramePool {
    // The fixed slots. No Vec<T>, no dynamic growth.
    slots: [PoolSlot; POOL_SIZE],
    
    // Atomic bitmask of available slots (1 = free)
    available: AtomicUsize,
    
    // The highest fence value the GPU has completed
    gpu_complete: AtomicU64,
}

struct PoolSlot {
    // The raw GPU handle (DMA-BUF / Texture)
    surface: SurfaceHandle,
    
    // The fence value we must reach before this slot is reusable
    release_fence: AtomicU64,
}
```

### 1.2 Backpressure Logic
When the pool is full (`available == 0`), we do **not** buffer packets in CPU RAM.
*   **Action:** The Decode Thread sleeps.
*   **Result:** The TCP/Network socket fills up.
*   **Outcome:** The remote server stops sending data (TCP Window Full).
*   **Benefit:** Memory usage remains flat regardless of network speed or pause state.

---

## 2. Color Pipeline: The "Linear Light" Mandate

We explicitly reject "Gamma Space Blending" which causes dark halos around UI text.

### 2.1 Pipeline Stages
1.  **Input:** YUV (Non-Linear, Limited Range)
2.  **Matrix:** `YUV -> RGB` (Result: Non-Linear RGB)
3.  **EOTF:** `Non-Linear -> Linear Light`
    *   SDR: $x^{2.4}$
    *   HDR: PQ (ST.2084) or HLG
4.  **Tone Map:** `Source Nits -> Display Nits`
    *   SDR: Simple gamma correction
    *   HDR: ACES or Reinhard
5.  **UI Blend:** `Video_Linear * (1-A) + UI_Linear * A`
    *   *Constraint:* UI Render Target must be `Rgba16Float` (Linear) or `Rgba8Unorm` (SRGB-encoded, linearized on sample).
6.  **OETF:** `Linear -> Output Encoded` (sRGB / Rec.2020)

### 2.2 Metadata Struct
This struct is passed to the Uber-Shader as a uniform.

```rust
#[repr(C)]
struct ColorUniforms {
    yuv_mat: mat4x4,       // Color conversion matrix
    yuv_offset: vec4,      // Offsets for limited range
    transfer_fn: u32,      // 0=sRGB, 1=PQ, 2=HLG
    tonemap_mode: u32,     // 0=None, 1=ACES
    display_nits: f32,     // Target brightness
    ui_white_nits: f32,    // How bright is "White" UI in HDR?
}
```

---

## 3. The Interop Bridge: Implementation Pattern

This describes **Strategy A (Native Controlled)**.

### 3.1 wgpu Wrapper
We use unsafe HAL access to wrap the native device.

```rust
// nitrate-pal/src/vulkan/device.rs

pub unsafe fn create_wgpu_wrapper(
    instance: &ash::Instance,
    device: &ash::Device,
    physical_device: vk::PhysicalDevice
) -> (wgpu::Device, wgpu::Queue) {
    use wgpu::hal::api::Vulkan;
    
    // 1. Wrap Instance
    let hal_instance = <Vulkan as Api>::Instance::from_raw(
        instance.handle(), 
        instance.clone(), 
        ...
    );
    
    // 2. Expose Adapter
    let hal_adapter = hal_instance.expose_adapter(physical_device, ...);
    
    // 3. Open Device
    let hal_device = hal_adapter.adapter.device_from_raw(
        device.handle(), 
        true, // internal_ref_count: we own the device
        ...
    );
    
    // 4. Create wgpu objects
    let (device, queue) = adapter.create_device_from_hal(hal_device, ...);
    return (device, queue);
}
```

### 3.2 Command Buffer Extraction
How we steal the command buffer from wgpu.

```rust
// nitrate-compositor/src/bridge.rs

pub unsafe fn extract_vk_cmd_buf(
    device: &wgpu::Device,
    encoder: wgpu::CommandEncoder
) -> vk::CommandBuffer {
    let cmd_buf = encoder.finish();
    
    // Access internals via HAL
    device.as_hal::<Vulkan, _, _>(|hal_device| {
        cmd_buf.as_hal::<Vulkan, _, _>(|hal_cmd| {
            hal_cmd.raw_handle()
        })
    }).unwrap()
}
```

---

## 4. Spike Plan (Validation Strategy)

The architecture is hypothetical until these Spikes pass.

### Spike 1: The Native Host
*   **Goal:** Create an `ash` device, wrap it in `wgpu`, and clear the screen using `wgpu`.
*   **Pass Criteria:** No validation errors, wgpu renders correctly to a Native Swapchain.

### Spike 2: The DMA-BUF Roundtrip
*   **Goal:** Allocate memory in Native (simulating a decoder), Export FD, Import to wgpu, Sample in Shader.
*   **Pass Criteria:** Texture appears in wgpu render pass with correct stride/tiling.

### Spike 3: The Bridge (Command Stealing)
*   **Goal:** Record a wgpu pass, steal the CmdBuf, submit via `ash::queue_submit`.
*   **Pass Criteria:** The wgpu draw call executes correctly when submitted by Native.

### Spike 4: The Sync
*   **Goal:** Create a Timeline Semaphore. Signal it (simulating decode). Submit Spike 3's buffer with a `wait_semaphore` operation.
*   **Pass Criteria:** GPU waits for signal. No CPU blocking detected.

---

## 5. UI Architecture: Compiled CSS

To maintain performance, we do not parse CSS at runtime on the UI thread.

### 5.1 The Compiler
*   **Input:** CSS files.
*   **Process:** Parse $\to$ Hash Selectors $\to$ Intern Properties $\to$ Serialize.
*   **Output:** `theme.bin` (Memory-mappable).

### 5.2 The Runtime (Zero-Copy)
*   **Load:** `mmap("theme.bin")`.
*   **Match:** Bloom filter check $\to$ Binary search on selector hash.
*   **Result:** `ResolvedStyle` struct (indices into GPU property pools).
*   **Layout:** Taffy (Flexbox/Grid) with incremental caching (Red/Green tree).