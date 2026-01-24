# NITRATE Roadmap to v1.0

**Status:** Spike Phase  
**Target:** Physics-based film simulation with 8K zero-copy playback

---

## Broad Strokes: The Six Phases

```
┌─────────────────────────────────────────────────────────────────────────┐
│  PHASE 1: PROVE THE BRIDGE                                              │
│  ─────────────────────────                                              │
│  Validate the "Native Owns, wgpu Borrows" architecture actually works.  │
│  This is highest-risk. If it fails, we pivot before wasting effort.     │
│                                                                         │
│  Exit Criteria: All 4 spikes pass on Linux/Vulkan                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PHASE 2: VIDEO PIPELINE                                                │
│  ───────────────────────                                                │
│  Real video decode → GPU texture. No film effects yet, just playback.   │
│                                                                         │
│  • VA-API decoder integration                                           │
│  • Frame pool with backpressure                                         │
│  • Basic seeking                                                        │
│                                                                         │
│  Exit Criteria: Play a 4K video file, frames appear on screen           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PHASE 3: COLOR PIPELINE                                                │
│  ───────────────────────                                                │
│  Correct color science. SDR and HDR content display accurately.         │
│                                                                         │
│  • compose.wgsl uber-shader                                             │
│  • YUV→RGB matrices (BT.709, BT.2020)                                   │
│  • EOTF/OETF (gamma, PQ, HLG)                                           │
│  • Tone mapping (ACES, Reinhard, BT.2390)                               │
│                                                                         │
│  Exit Criteria: HDR10 content displays correctly on SDR monitor         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PHASE 4: UI SYSTEM                                                     │
│  ──────────────────                                                     │
│  The "Volatile Memory" interface. Dark film photography aesthetic.      │
│                                                                         │
│  • Vello renderer integration                                           │
│  • Transport controls (play/pause/seek)                                 │
│  • Parameter sliders                                                    │
│  • Sidebar + viewport layout                                            │
│                                                                         │
│  Exit Criteria: Usable player with the reference CSS look               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PHASE 5: FILM SIMULATION                                               │
│  ────────────────────────                                               │
│  The product differentiator. Physics-based film emulation.              │
│                                                                         │
│  • Halation (light bleed around highlights)                             │
│  • Film grain (temporal + spatial noise)                                │
│  • Color response curves (per-stock emulation)                          │
│  • Gate weave / flicker (optional vintage mode)                         │
│                                                                         │
│  Exit Criteria: "This looks like actual film" reaction                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PHASE 6: POLISH & SHIP                                                 │
│  ──────────────────────                                                 │
│  Production readiness. Performance, stability, packaging.               │
│                                                                         │
│  • 8K 60fps validation                                                  │
│  • Windows port (Media Foundation + D3D12)                              │
│  • macOS port (VideoToolbox + Metal)                                    │
│  • Error recovery / graceful degradation                                │
│  • Installer / packaging                                                │
│                                                                         │
│  Exit Criteria: v1.0 release                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Time Estimates (Rough)

| Phase | Effort | Risk |
|-------|--------|------|
| 1. Prove the Bridge | 2-3 weeks | **HIGH** — architecture viability |
| 2. Video Pipeline | 3-4 weeks | Medium — known problem space |
| 3. Color Pipeline | 2-3 weeks | Low — well-documented math |
| 4. UI System | 4-6 weeks | Medium — Vello is young |
| 5. Film Simulation | 4-6 weeks | Medium — R&D required |
| 6. Polish & Ship | 4-8 weeks | Low — execution work |

**Total: ~5-7 months** for a solo developer working full-time.

---

---

# PHASE 1: PROVE THE BRIDGE (Detailed)

This phase has one job: **validate or kill the hybrid architecture**.

## Overview

We execute four spikes in sequence. Each spike builds on the previous. If any spike fails in a way that can't be resolved, we document the failure and reassess the architecture before proceeding.

```
Spike 1          Spike 2          Spike 3          Spike 4
────────────────────────────────────────────────────────────►
Native Device    DMA-BUF Import   Command Steal    Timeline Sync
    │                │                 │                │
    ▼                ▼                 ▼                ▼
 ash + wgpu       Texture in        vkQueueSubmit    GPU-GPU wait
  coexist          shader           with wgpu cmd    no CPU block
```

---

## Spike 1: The Native Host

**Goal:** Create an `ash::Device`, wrap it in wgpu, render via wgpu.

### Tasks

```
┌─────────────────────────────────────────────────────────────┐
│ 1.1  Create spike harness                                   │
├─────────────────────────────────────────────────────────────┤
│      • New binary: crates/nitrate-app/src/bin/spike1.rs     │
│      • Minimal winit window                                 │
│      • No UI, just a render loop                            │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ 1.2  Native device creation                                 │
├─────────────────────────────────────────────────────────────┤
│      • Use existing VulkanDevice::new()                     │
│      • Enable VK_KHR_external_memory_fd                     │
│      • Enable VK_KHR_timeline_semaphore                     │
│      • Create VkSurfaceKHR via ash-window                   │
│      • Create VkSwapchainKHR (native-owned)                 │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ 1.3  wgpu HAL wrapper                                       │
├─────────────────────────────────────────────────────────────┤
│      • Implement create_wgpu_from_ash() in vulkan/bridge.rs │
│      • Use wgpu::hal::api::Vulkan                           │
│      • Wrap existing ash::Instance                          │
│      • Wrap existing ash::Device                            │
│      • Expose wgpu::Device + wgpu::Queue                    │
│      • Document all unsafe blocks                           │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ 1.4  Render to native swapchain                             │
├─────────────────────────────────────────────────────────────┤
│      • Create wgpu::TextureView from swapchain image        │
│      • Clear to accent color (#e07030)                      │
│      • Submit via wgpu::Queue::submit()                     │
│      • Present via vkQueuePresentKHR (native)               │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ 1.5  Validation                                             │
├─────────────────────────────────────────────────────────────┤
│      • Run with VK_LAYER_KHRONOS_validation                 │
│      • Zero validation errors                               │
│      • Window shows solid orange color                      │
│      • No memory leaks (valgrind)                           │
└─────────────────────────────────────────────────────────────┘
```

### Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `crates/nitrate-app/src/bin/spike1.rs` | NEW | Spike harness |
| `crates/nitrate-pal/src/vulkan/bridge.rs` | NEW | wgpu HAL wrapper |
| `crates/nitrate-pal/src/vulkan/swapchain.rs` | NEW | Native swapchain |
| `crates/nitrate-pal/src/vulkan/mod.rs` | MODIFY | Export new modules |
| `crates/nitrate-pal/src/vulkan/device.rs` | MODIFY | Add bridge support |

### Pass Criteria

- [ ] Window displays solid #e07030 orange
- [ ] Zero Vulkan validation errors
- [ ] `cargo clippy` passes (no unwrap/expect)
- [ ] Resize works without crash

### Failure Modes & Mitigations

| Failure | Mitigation |
|---------|------------|
| wgpu HAL API unstable/private | Pin wgpu version, consider forking |
| Can't share device handles | Try `unsafe_create_device_from_raw` |
| Queue family mismatch | Ensure both use same family index |

---

## Spike 2: The DMA-BUF Roundtrip

**Goal:** Allocate GPU memory natively, export as DMA-BUF, import to wgpu, sample in shader.

### Tasks

```
┌─────────────────────────────────────────────────────────────┐
│ 2.1  Native texture allocation                              │
├─────────────────────────────────────────────────────────────┤
│      • Create VkImage (RGBA8, 256x256)                      │
│      • Allocate VkDeviceMemory with EXPORTABLE flag         │
│      • Fill with test pattern via staging buffer            │
│      • Export as DMA-BUF fd                                 │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ 2.2  wgpu texture import                                    │
├─────────────────────────────────────────────────────────────┤
│      • Use wgpu::hal to import external memory              │
│      • Create wgpu::Texture from imported memory            │
│      • Create wgpu::TextureView                             │
│      • Create wgpu::Sampler                                 │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ 2.3  Sample in shader                                       │
├─────────────────────────────────────────────────────────────┤
│      • Write simple fullscreen quad shader                  │
│      • Bind imported texture                                │
│      • Render to swapchain                                  │
│      • Verify test pattern appears correctly                │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ 2.4  Modifier / tiling test                                 │
├─────────────────────────────────────────────────────────────┤
│      • Test with DRM_FORMAT_MOD_LINEAR                      │
│      • Test with driver-preferred tiling modifier           │
│      • Verify both display correctly                        │
└─────────────────────────────────────────────────────────────┘
```

### Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `crates/nitrate-app/src/bin/spike2.rs` | NEW | Spike harness |
| `crates/nitrate-pal/src/vulkan/export.rs` | NEW | DMA-BUF export |
| `crates/nitrate-pal/src/vulkan/import.rs` | NEW | wgpu import |
| `crates/nitrate-app/src/shaders/blit.wgsl` | NEW | Fullscreen quad |

### Pass Criteria

- [ ] Test pattern (checkerboard) displays correctly
- [ ] Works with linear and tiled memory
- [ ] No validation errors
- [ ] fd is properly closed on drop

---

## Spike 3: The Bridge (Command Stealing)

**Goal:** Record wgpu commands, extract VkCommandBuffer, submit via native queue.

### Tasks

```
┌─────────────────────────────────────────────────────────────┐
│ 3.1  Command buffer extraction                              │
├─────────────────────────────────────────────────────────────┤
│      • Create wgpu::CommandEncoder                          │
│      • Record a clear + draw                                │
│      • Finish to wgpu::CommandBuffer                        │
│      • Extract raw VkCommandBuffer via HAL                  │
│      • DO NOT call wgpu::Queue::submit()                    │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ 3.2  Native submission                                      │
├─────────────────────────────────────────────────────────────┤
│      • Create VkSemaphore (binary, for image acquire)       │
│      • vkAcquireNextImageKHR with semaphore                 │
│      • vkQueueSubmit with:                                  │
│        - wait: acquire semaphore                            │
│        - command: extracted wgpu cmd buf                    │
│        - signal: render complete semaphore                  │
│      • vkQueuePresentKHR                                    │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ 3.3  Validation                                             │
├─────────────────────────────────────────────────────────────┤
│      • wgpu-recorded draw call executes correctly           │
│      • No double-submit errors                              │
│      • No synchronization errors                            │
│      • Clean shutdown (no leaks)                            │
└─────────────────────────────────────────────────────────────┘
```

### Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `crates/nitrate-app/src/bin/spike3.rs` | NEW | Spike harness |
| `crates/nitrate-pal/src/vulkan/bridge.rs` | MODIFY | Add cmd extraction |
| `crates/nitrate-pal/src/vulkan/submit.rs` | NEW | Native submission |

### Pass Criteria

- [ ] wgpu draw call renders via native submit
- [ ] Zero validation errors
- [ ] No resource lifetime issues
- [ ] Works for 1000+ frames without degradation

### Critical Risk

This is the **highest-risk spike**. If wgpu doesn't expose stable APIs for command buffer extraction, alternatives:

1. **Fork wgpu** — add the access we need
2. **Pivot to wgpu-only** — use wgpu for everything, accept sync limitations
3. **Pivot to ash-only** — abandon wgpu, write Vello backend for Vulkan

---

## Spike 4: The Sync

**Goal:** GPU-GPU synchronization via timeline semaphores.

### Tasks

```
┌─────────────────────────────────────────────────────────────┐
│ 4.1  Timeline semaphore creation                            │
├─────────────────────────────────────────────────────────────┤
│      • Create VkSemaphore with TIMELINE type                │
│      • Initial value = 0                                    │
│      • Store in native context                              │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ 4.2  Producer-consumer simulation                           │
├─────────────────────────────────────────────────────────────┤
│      • "Decoder" thread: submit work, signal N              │
│      • "Compositor" thread: wait on N, submit, signal N+1   │
│      • Use vkQueueSubmit2 with timeline wait/signal         │
│      • Verify GPU pipeline stays full                       │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ 4.3  CPU-free verification                                  │
├─────────────────────────────────────────────────────────────┤
│      • No vkWaitForFences in hot path                       │
│      • No vkDeviceWaitIdle                                  │
│      • Measure: CPU should be ~idle during playback         │
│      • Profile with perf / tracy                            │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ 4.4  Fallback path (Tier C)                                 │
├─────────────────────────────────────────────────────────────┤
│      • Disable timeline semaphores                          │
│      • Verify CpuSync fallback works                        │
│      • Measure CPU overhead (should be higher but stable)   │
└─────────────────────────────────────────────────────────────┘
```

### Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `crates/nitrate-app/src/bin/spike4.rs` | NEW | Spike harness |
| `crates/nitrate-pal/src/vulkan/timeline.rs` | NEW | Timeline semaphore wrapper |
| `crates/nitrate-pal/src/sync.rs` | MODIFY | Implement TierA strategy |

### Pass Criteria

- [ ] GPU waits on timeline value (verified via validation)
- [ ] Zero CPU blocking in steady state
- [ ] Graceful Tier C fallback on old hardware
- [ ] 60fps sustained with <5% CPU usage

---

## Phase 1 Exit Checklist

Before proceeding to Phase 2, ALL of these must be true:

```
[ ] Spike 1 passes — ash + wgpu coexist
[ ] Spike 2 passes — DMA-BUF roundtrip works
[ ] Spike 3 passes — command stealing works
[ ] Spike 4 passes — timeline sync works

[ ] All spikes run without validation errors
[ ] All spikes pass clippy --pedantic
[ ] All spikes have no .unwrap() / .expect() in non-test code
[ ] Architecture documented with actual (not theoretical) code

[ ] Decision recorded: proceed / pivot / abort
```

---

## Appendix: Spike Binary Template

```rust
//! Spike N: [Title]
//!
//! Goal: [One sentence]
//! Pass Criteria: [Measurable outcome]

use anyhow::Result;
use tracing::info;

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("spike=debug,wgpu=warn,ash=debug")
        .init();

    info!("=== SPIKE N: [TITLE] ===");

    // Setup
    let ctx = setup()?;

    // Execute
    let result = execute(&ctx)?;

    // Validate
    validate(&result)?;

    info!("=== SPIKE N: PASSED ===");
    Ok(())
}
```

---

## Next Actions

1. **Create `spike1.rs`** harness with minimal window
2. **Implement `vulkan/bridge.rs`** with HAL wrapper
3. **Run with validation layers** and fix all errors
4. **Document findings** in `docs/spike-results.md`
