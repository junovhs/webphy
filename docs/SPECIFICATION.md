This is a **technical synthesis** of all prior documentation, reviews, and corrections. It strips out the "proposal/critique" history and presents only the **final, approved architectural specification** and the **immediate execution plan**.

This document is approximately **5,000 tokens** of high-density technical context. It contains every struct definition, logic flow, and constraint required for an AI to implement Phase 1.

---

# PROJECT NITRATE: MASTER ARCHITECTURAL SPECIFICATION
**Version:** 1.0 (Post-Audit Consensus)
**Target:** 8K/60fps Video Engine, <100MB CPU RAM, Zero-Copy, Rust.

## 1. Core Architecture: The Hybrid "Native-First" Model

The central architectural decision is **Inverted Ownership**. We do not use `wgpu` as the platform abstraction layer. We use **Native APIs** (Vulkan/DX12/Metal) as the host, and `wgpu` is strictly a "Guest" compute runner for UI.

### 1.1 Ownership Hierarchy
1.  **Native Layer (The Host):**
    *   Owns the `Device`, `Window`, `Swapchain`, and `PresentQueue`.
    *   Owns the Video Decoder and Video Surfaces (`VkImage`/`ID3D12Resource`).
    *   Owns the **Synchronization Primitives** (Timeline Semaphores/Fences).
    *   Performs the final **Composition Pass** (Video + UI + Color Management).
2.  **WGPU Layer (The Guest):**
    *   Wraps the Native Device via `wgpu-hal` (unsafe).
    *   Owns the **UI Render Target** (Texture).
    *   Runs **Vello** (Compute) to rasterize UI into that target.
    *   **Does NOT submit work directly.** It builds command buffers that the Native Layer steals and submits.

### 1.2 The "Tiered" Synchronization Strategy
We cannot rely on `wgpu` for cross-context synchronization. We implement three tiers of synchronization, selected at runtime based on platform capabilities.

*   **Tier A (Primary - "Command Stealing"):**
    *   Record UI commands in `wgpu`.
    *   **Extract** the raw `VkCommandBuffer`/`ID3D12CommandList` via HAL.
    *   Submit via **Native Queue** (`vkQueueSubmit2`) with explicit Timeline Semaphore waits/signals.
    *   *Benefit:* True GPU-to-GPU sync, zero CPU blocking.
*   **Tier B (Implicit/Resource):**
    *   Rely on `sync_file` (Linux) or Keyed Mutexes.
    *   GPU waits on a specific resource handle becoming ready.
*   **Tier C (Fallback - CPU Coordinated):**
    *   Wait for UI completion on CPU.
    *   Submit Composition.
    *   *Cost:* Latency spike. *Benefit:* Stability on old drivers.

---

## 2. Data Flow & Pipelines

### 2.1 The Two-Pass Render Loop
We strictly separate UI generation from final composition.

**Pass 1: UI Generation (WGPU / Vello)**
*   **Input:** Vector Scene Graph.
*   **Output:** `UI Render Target` (Texture).
*   **Format:** `Rgba8Unorm` (Linear data) or `Rgba16Float`.
    *   *Note:* Do **not** use sRGB formats for Storage Textures (WebGPU spec violation).
*   **Alpha:** **Premultiplied**.
*   **Uploads:** Uses `StagingBelt` (Ring Buffer) for scene data. No per-frame allocation.

**Pass 2: Final Composition (Native)**
*   **Input:**
    1.  Video Luma Plane (R8/R16).
    2.  Video Chroma Plane (RG8/RG16).
    3.  UI Texture (Imported from WGPU).
    4.  Color Metadata (Uniforms).
*   **Operation:** Fullscreen Triangle via Native Pipeline.
*   **Logic (Strict Linear Light):**
    1.  `YUV` $\to$ `RGB_Linear` (Matrix).
    2.  `EOTF` (PQ/HLG) $\to$ Linear Nits.
    3.  Tone Map (HDR $\to$ SDR / Display Nits).
    4.  `Output = UI.rgb + Video.rgb * (1.0 - UI.a)`.
    5.  `OETF` (Linear $\to$ sRGB/Display).

### 2.2 Color Management
**Gamma-space blending is forbidden.** All blending happens in Linear Light.

*   **Struct:** `ColorMetadata` (parsed from video container).
*   **Uniforms:** `mat4` for YUV conversion, `u32` for Transfer Function ID (PQ/HLG), `f32` for Mastering Luminance.
*   **Tone Mapping:** ACES or Reinhard.

---

## 3. Implementation Details: Structures & Logic

### 3.1 The Interop Boundary Object
This struct is the "handoff" between the Native Video Decoder and the Renderer.

```rust
// nitrate-pal/src/surface.rs

#[derive(Debug)]
pub struct ImportedSurface {
    /// Platform-specific handle (FD, Shared Handle, etc.)
    pub handle: SurfaceHandle,
    /// Detailed plane layout (Offset/Stride for PRIME2)
    pub planes: ArrayVec<PlaneDescriptor, 3>,
    /// Color Science Data
    pub color: ColorMetadata,
    /// Synchronization Primitive
    pub sync: SyncHandle,
}

#[derive(Debug)]
pub enum SurfaceHandle {
    DmaBuf {
        fd: std::os::unix::io::RawFd,
        modifier: u64, // CRITICAL for tiled memory
        drm_format: u32,
        // Must support multi-object (PRIME2) in implementation
    },
    DxgiShared {
        handle: *mut std::ffi::c_void,
        sync_mode: DxgiSyncMode, // Fence vs KeyedMutex
    },
    IoSurface {
        surface: *mut std::ffi::c_void,
    },
}
```

### 3.2 Fixed-Capacity Memory Pool
To guarantee <100MB usage, we never allocate frames dynamically.

```rust
// nitrate-decode/src/pool.rs

const POOL_SIZE: usize = 8; // Hard limit

pub struct FramePool {
    // Fixed array. No DashMap. No Vec growth.
    slots: [PoolSlot; POOL_SIZE],
    // Atomic bitmask of available slots.
    available_mask: AtomicUsize,
}

struct PoolSlot {
    surface: Option<SurfaceHandle>,
    // The fence value the GPU must reach before we overwrite this
    gpu_fence_value: AtomicU64,
}

// Backpressure Logic:
// If available_mask == 0, the decoder thread SLEEPS.
// This forces TCP/Network backpressure naturally.
```

### 3.3 The Composition Shader (WGSL Logic)
This logic must be replicated in the Native Shader (GLSL/HLSL) or compiled via Naga.

```wgsl
// Logic Reference
fn fs_main(uv: vec2<f32>) -> vec4<f32> {
    // 1. Decode Video
    let y = sample(y_plane, uv);
    let uv_vals = sample(uv_plane, uv);
    let rgb_linear = yuv_to_linear_rgb(y, uv_vals, metadata); // Matrix + EOTF
    let rgb_mapped = tone_map(rgb_linear, metadata);

    // 2. Sample UI (Premultiplied Linear)
    let ui = sample(ui_texture, uv);

    // 3. Blend
    let final_linear = ui.rgb + rgb_mapped * (1.0 - ui.a);

    // 4. Encode
    return linear_to_output_curve(final_linear);
}
```

---

## 4. Platform Specifics

### 4.1 Linux (Vulkan / VA-API)
*   **Import:** `VK_EXT_external_memory_dma_buf`.
*   **Format Info:** Must use `VkImageDrmFormatModifierExplicitCreateInfoEXT`. Implicit modifiers are dangerous/broken on some drivers.
*   **Sync:** `VK_KHR_timeline_semaphore`. Import `sync_file` (Tier B) if timeline not supported.

### 4.2 Windows (D3D12 / Media Foundation)
*   **Import:** `ID3D12Device::OpenSharedHandle`.
*   **Sync:** `ID3D12Fence` (Shared).
*   **Constraint:** The `ID3D12Device` used by `wgpu` must be the *same* physical device (LUID match) as the Native device.

### 4.3 macOS (Metal / VideoToolbox)
*   **Import:** `CVPixelBuffer` $\to$ `IOSurface` $\to$ `MTLTexture`.
*   **Sync:** `MTLSharedEvent`.

---

## 5. Execution Roadmap: Phase 1 (The Spikes)

We do not write the full application yet. We write **4 Spikes** to validate the architecture.

### Spike 1: The Native Host
*   **Goal:** Create `ash::Device`, wrap in `wgpu` via HAL, render a triangle.
*   **Code Path:** `crates/nitrate-pal/src/vulkan/device.rs` -> `unsafe fn create_wgpu_from_ash(...)`.
*   **Pass Criteria:** Orange screen, 0 Validation Errors.

### Spike 2: The DMA-BUF Roundtrip
*   **Goal:** Native `VkImage` allocation (simulating Decoder) $\to$ Export FD $\to$ Import WGPU $\to$ Shader Sample.
*   **Focus:** Verify `VkImageDrmFormatModifierExplicitCreateInfoEXT` works.
*   **Pass Criteria:** Checkerboard pattern renders correctly.

### Spike 3: The Bridge (Command Stealing)
*   **Goal:** Record `wgpu` commands, **finish()**, extract `VkCommandBuffer` (HAL), submit via `ash::queue_submit`.
*   **Risk:** Highest. Requires peering into `wgpu` internals via `as_hal`.
*   **Pass Criteria:** WGPU draw call appears on screen via Native submit.

### Spike 4: The Sync
*   **Goal:** Create Timeline Semaphore. Signal (1) on Thread A. Submit Spike 3 work with Wait(1) on Thread B.
*   **Pass Criteria:** Rendering occurs. **CPU usage is near-zero** (no spin-waits).

---

## 6. Directory Structure (Final)

```text
crates/
├── nitrate-pal/         # PLATFORM ABSTRACTION (The Native Core)
│   ├── src/lib.rs       # SyncTier enum, SyncStrategy trait
│   ├── src/surface.rs   # ImportedSurface, PlaneDescriptor structs
│   ├── src/vulkan/      # Ash backend + HAL Interop
│   ├── src/dx12/        # Windows backend
│   └── src/metal/       # macOS backend
│
├── nitrate-ui/          # UI GENERATOR
│   ├── src/vello.rs     # Vello integration
│   └── src/target.rs    # UI Render Target (Linear Format)
│
├── nitrate-compositor/  # THE NATIVE RENDERER
│   ├── src/compose.rs   # Native Fullscreen Pass
│   └── src/bridge.rs    # WGPU Command Buffer Extraction logic
│
├── nitrate-color/       # COLOR SCIENCE
│   └── src/math.rs      # Matrix generation, EOTF/OETF funcs
│
├── nitrate-decode/      # VIDEO DECODE
│   └── src/pool.rs      # Fixed [PoolSlot; 8] logic
│
└── nitrate-app/         # BINARIES
    ├── src/bin/spike1.rs
    ├── src/bin/spike2.rs
    ├── src/bin/spike3.rs
    └── src/bin/spike4.rs
```

## 7. Immediate Next Steps

1.  **Initialize `crates/nitrate-pal`**.
2.  **Implement `nitrate-pal/src/vulkan/device.rs`** (Native Device creation).
3.  **Implement `nitrate-pal/src/vulkan/bridge.rs`** (WGPU Wrapper / `create_from_hal`).
4.  **Write `spike1.rs`** and verify the "Native Owns, WGPU Borrows" hypothesis.
