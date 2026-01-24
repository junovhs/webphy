# NITRATE Architecture Details

**Supplement to `architecture.md`**

## 1. Composition Pipeline (Linear Light)

1. **Input:** NV12/P010 (Non-Linear).
2. **Transform:** `YUV -> RGB` Matrix.
3. **Linearize:** Apply EOTF (PQ / HLG / Gamma 2.2).
4. **Tone Map:** `nits -> display_nits` (ACES / Reinhard).
5. **UI Blend:** `UI_Linear + Video_Linear * (1 - UI_Alpha)`.
6. **Output:** Apply OETF (sRGB) -> Swapchain.

**Format Requirement:** UI Render Target must be `Rgba16Float` or `Rgba8Unorm` (treated as Linear).

---

## 2. Execution Plan (Spikes)

We do not build the app until the Bridge is proven.

- **Spike 1 (Device):** Create `ash::Device`, wrap in wgpu, render a triangle.
- **Spike 2 (DMA-BUF):** Allocate `VkImage` (Native), Export FD, Import to wgpu, Sample.
- **Spike 3 (The Bridge):** Record wgpu commands, extract `VkCommandBuffer`, submit via `ash` with Semaphore wait.
- **Spike 4 (Video):** Hook up FFmpeg/VA-API to Spike 2.

---

## 3. Directory Structure

```
crates/
├── nitrate-pal/         # NATIVE LAYER (The Boss)
│   ├── src/vulkan/      # Device ownership, Semaphores
│   └── src/surface.rs   # ImportedSurface def
├── nitrate-ui/          # GUEST LAYER
│   └── src/lib.rs       # Vello -> wgpu encoder
├── nitrate-compositor/  # THE GLUE
│   └── src/compose.wgsl # Uber-shader
└── nitrate-app/         # ORCHESTRATOR
    └── src/main.rs      # Event Loop
```

---

## 4. Platform Specifics

### Linux (Primary)
- **Decode:** VA-API via `libva`.
- **Import:** `VK_EXT_external_memory_dma_buf`.
- **Sync:** `VK_KHR_timeline_semaphore`.

### Windows (Future)
- **Decode:** Media Foundation.
- **Import:** `VK_KHR_external_memory_win32` / Shared Handle.
- **Sync:** `ID3D12Fence`.

### macOS (Future)
- **Decode:** VideoToolbox.
- **Import:** `IOSurface`.
- **Sync:** `MTLSharedEvent`.