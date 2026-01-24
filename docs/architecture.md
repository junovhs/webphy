# NITRATE Architecture Specification

**Version:** 1.1 (Revised)
**Date:** 2026-01-24
**Status:** Spike Phase - Critical Interop Validation

---

## 1. Project Overview

NITRATE is a physics-based film simulation engine targeting:
- **8K 60fps** zero-copy playback
- **Sub-100MB** CPU memory footprint
- **Native-owned** resource lifecycle (Pixels never touch CPU)

### The Core Invariant
**"Native Owns, wgpu Borrows."**
The application is a Native Vulkan/D3D12/Metal engine that uses wgpu strictly as a sub-system for rasterizing UI into a texture.

---

## 2. The Hybrid Bridge Architecture

### 2.1 Device Identity (Native-First)
To ensure zero-copy compatibility, the GPU device is created by the Native Layer.
1. **Native:** Creates `ash::Instance`, `ash::Device`, and Queues. Enables `VK_KHR_external_memory_fd` & `VK_KHR_timeline_semaphore`.
2. **wgpu:** Initialized via `unsafe` HAL hooks to wrap the *existing* Native device.
   * *Why:* Ensures decoder and renderer share the exact same physical device, memory heaps, and queue families.

### 2.2 The Composition Loop (Native Controlled)
wgpu is treated as a **Command Generator**, not a Scheduler.

1. **Decode:** Native Decoder writes Y/UV planes to `ImportedSurface`. Signals `TimelineSemaphore(N)`.
2. **UI Render:**
   - Vello encodes draw commands to `wgpu::CommandEncoder`.
   - **CRITICAL:** We do *not* call `wgpu::Queue::submit`.
   - Instead, we extract the raw `VkCommandBuffer` via HAL.
3. **Submission:**
   - Native performs `vkQueueSubmit`.
   - **Waits:** `TimelineSemaphore(N)` (Video Ready).
   - **Executes:** Extracted UI CmdBuf + Native Composition CmdBuf.
   - **Signals:** `TimelineSemaphore(N+1)` (Present Ready).
4. **Present:** Native Swapchain presents when `N+1` is signaled.

### 2.3 Sync Tiers (Runtime Ladder)

| Tier | Strategy | Implementation |
|------|----------|----------------|
| **A (Gold)** | **Timeline Semaphores** | GPU waits on specific u64 values. Zero CPU blocking. |
| **B (Silver)** | **Imported Fences** | `sync_file` (Linux) or Shared Handle (Win). One-shot sync. |
| **C (Bronze)** | **CPU Coordination** | `queue.on_submitted_work_done()` callback → Native Submit. |

---

## 3. Data Flow & Memory Strategy

### 3.1 The "Pressure-Aware" Pool
To survive 8K without OOM:
- **Structure:** `[PoolSlot; 8]` fixed array.
- **Tracking:** `AtomicU64` fence values track GPU usage. No Mutexes.
- **Backpressure:** If all slots are busy (GPU lag), the **Network Thread blocks**. We do not buffer packets in RAM.

### 3.2 The Boundary Object: `ImportedSurface`
The only object passed between Decoder and Compositor.
```rust
struct ImportedSurface {
    handle: SurfaceHandle, // DMA-BUF fd / Shared Handle
    planes: [PlaneDesc; 3], // Offsets/Strides for Y/U/V
    sync: SyncHandle,       // The semaphore to wait on
    color: ColorMetadata,   // Primaries/Transfer/Matrix
}
```

---

## 4. Composition Pipeline (Linear Light)

All blending happens in **Linear Light**. Gamma is the enemy.

See `architecture-details.md` for the full pipeline specification, directory structure, and spike plan.
