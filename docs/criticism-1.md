Your blueprint is directionally sound: you are optimizing for the only invariant that really matters at 8K/60—keeping pixel planes resident in GPU memory end-to-end—and you’ve made good companion choices (timeline-style sync, preallocation, incremental layout, compiled styles).

That said, there are a few “this will determine whether the project ships” risks that I would address early, because they cut across decode/render/sync and can force architectural changes if discovered late.

## What looks strongest

* **Correct top-level invariant**: “pixels never touch CPU” is the right north star for 8K/60.
* **Explicit frame graph + monotonic signaling**: the dependency model is clean and maps to modern APIs well (Vulkan timeline semaphores, D3D12 fences, Metal shared events). Timeline semaphores are specifically intended to simplify multi-queue sync vs binary semaphores. ([Vulkan Documentation][1])
* **Compiled CSS as mmap-able binary**: this is a credible way to get “web authoring ergonomics” without paying web-engine runtime costs.
* **Incremental layout strategy**: the “red/green” thinking is correct; it’s the only way you stay under 16ms at scale.

## Critical risks (address these first)

### 1) wgpu + true zero-copy interop is not a solved problem everywhere

Your plan assumes you can import decoder-owned surfaces (DMA-BUF / DXGI shared handle / IOSurface) as wgpu textures in a stable, cross-platform way. In practice:

* **Texture memory import/export is an open/ongoing area in wgpu** (especially DMA-BUF workflows). This is widely cited as a blocker for compositor-class renderers. ([GitHub][2])
* **NV12 / multi-plane formats can be problematic on Metal via wgpu**; there are reports of feature detection/format exposure issues even when native Metal can create the texture. ([GitHub][3])
* wgpu *does* let you reach into backend objects via the HAL layer (e.g., `Texture::as_hal`), but once you do that you’re essentially committing to backend-specific interop code paths and careful lifetime management. ([Docs.rs][4])

**Implication:** keep your `nitrate-pal` approach, but be realistic that “wgpu everywhere” may need to become “wgpu for UI + thin native backend for video surfaces + explicit interop glue” (or even “native API for the whole compositor” on at least one platform).

### 2) Timeline semaphores: great concept, but wgpu may not expose what you want

You’re abstracting “timeline semaphore” as a first-class primitive across Vulkan/DX12/Metal. That’s correct at the native API level, but wgpu’s public API generally does **not** expose external semaphore/fence import/export in a way that lets you do GPU-to-GPU sync with a hardware decoder without falling back to CPU-visible waits.

Notably, wgpu’s Vulkan HAL has an internal “Fence” that is implemented using a Vulkan timeline semaphore. ([wgpu.rs][5])
That’s encouraging, but it also hints that the capability may be *internal* unless you build against HAL internals or custom backends.

**Implication:** design for three sync tiers:

1. **Tier A (best):** GPU timeline wait/signal wired end-to-end (native API path).
2. **Tier B:** GPU wait via native API, wgpu only samples already-synchronized textures (interop boundary is “resource-ready”).
3. **Tier C (fallback):** CPU-side polling/query to avoid correctness bugs on platforms where A/B aren’t feasible (still try to keep it off the main thread).

If you don’t formalize those tiers now, you’ll discover late that “GPU-to-GPU, no CPU” is platform-dependent.

### 3) The “uber-shader” UI loop is not viable as written

You already note it’s simplified, but it’s worth stating plainly: looping over `node_count` UI nodes per pixel in a fragment shader is a non-starter for real UI sizes.

**Recommendation:** keep the “single-pass composition” idea, but change what gets composited:

* **Pass 1 (UI):** Vello (or your own compute raster) renders UI into an intermediate UI color target (and optionally an alpha target).
* **Pass 2 (Compose):** the uber-shader becomes “video sample + colorspace/HDR + UI texture composite”.

That preserves your CPU/GPU boundary rule and keeps composition cheap.

Also: Vello itself describes its current state as **alpha** and calls out ongoing work in areas that matter to you (memory allocation strategy, glyph caching, etc.). ([GitHub][6])
So treat Vello as a strong bet, but not as a dependency you cannot replace.

### 4) HDR correctness needs a more explicit color pipeline

Your shader sketches the right *shape* (YUV→RGB, PQ EOTF, tone map), but HDR playback quality will hinge on details you should make explicit in architecture:

* **Limited vs full range offsets differ by bit depth** (8-bit NV12 vs 10-bit P010). Your constants need to be parameterized by metadata.
* **Matrix depends on primaries + Y′CbCr encoding** (BT.2020 non-constant luminance vs constant luminance; BT.709; etc.).
* **SDR output requires gamut mapping** (BT.2020 → BT.709) in addition to tone mapping.

**Recommendation:** move this into a formal “Color Management” module with:

* parsed per-frame mastering metadata (where present),
* explicit transfer/primaries/range handling,
* test vectors (reference frames) to avoid “it looks okay on my monitor” failures.

### 5) CPU <100MB is plausible, but some current choices will fight you

A few items in the design as written are likely to inflate CPU memory or introduce allocator churn:

* `DashMap` for per-handle fence values is convenient but not “budget-friendly” at your target; also it encourages dynamic growth. Prefer a **fixed-capacity array indexed by pool slot** with `AtomicU64` fence values.
* Many small `queue.write_buffer` calls (per node/range) can become an implicit CPU-side staging churn. Prefer **one mapped staging upload per frame** (ring) and one copy command, or at least batch writes.

## Concrete changes I would make now

### A) Make the “interop boundary” a first-class concept

Define an explicit boundary type that includes **all** the information the renderer needs to treat the decoder output as a sampled texture:

* handle (fd / shared handle / IOSurfaceRef),
* per-plane info (format, offsets, strides, modifiers where relevant),
* color metadata,
* synchronization handle/value (timeline value or fence value).

On Linux, DRM modifiers and plane layouts are not optional if you want robust DMA-BUF import. Vulkan’s DMA-BUF extension is explicitly about importing/exporting memory, and external sync primitives typically accompany that memory. ([Vulkan Documentation][7])

### B) Decide early whether you will use wgpu HAL/private APIs

If you stay with wgpu at the top, you will likely end up either:

* using **wgpu HAL hooks** (`as_hal`) for backend-native interop, ([Docs.rs][4])
* or writing a **custom backend path** for the video plane(s) and handing wgpu a texture that is already “normal”.

This is a strategic choice because it affects portability, upgrade cadence, and how much of your code lives outside the safe wgpu surface.

### C) Keep pipeline caching, but align it with current wgpu behavior

wgpu has a first-class `PipelineCache` / `PipelineCacheDescriptor` API and a helper for deriving a cache key; your cold-boot plan is consistent with that approach. ([Docs.rs][8])
If you plan to embed SPIR-V, note that SPIR-V support in wgpu is feature-gated (`spirv`). ([Docs.rs][9])
Operationally, you should plan for a WGSL-first workflow unless you have a strong reason to carry SPIR-V across every target.

### D) Rework the UI composition path into two GPU passes

* UI raster/tiles → UI RT (compute)
* Video sample + HDR + UI composite → swapchain

You still get “single present pass” semantics from the user’s perspective, but you stop pretending UI can be evaluated procedurally in the fragment shader.

## A practical “prove it fast” validation plan (what I’d prototype first)

To de-risk the whole project, I would build three spikes before fleshing out the rest:

1. **Linux DMA-BUF path**: VA-API decode → import planes → sample in shader → present, with no CPU copy, including modifiers/strides.
2. **Windows shared-handle path**: D3D12 video decode output (NV12) → SRV plane sampling → present.
3. **macOS IOSurface path**: VideoToolbox CVPixelBuffer/IOSurface → Metal textures → sampled composite.

If any one of these requires stepping outside wgpu’s safe surface (likely), you’ll know immediately how much of `nitrate-pal` must be “real” native graphics code vs “thin wrappers”.

## Bottom line

You have the right architecture *shape*. The main thing to tighten is feasibility at the interop layer: **wgpu + cross-platform external surface import + timeline-grade GPU sync** is the part most likely to force redesign. If you treat that as a first-class subsystem—with explicit tiers/fallbacks and a clear boundary object—the rest of the system (compiled styles, incremental layout, preallocated pools) is a strong, coherent plan.


[1]: https://docs.vulkan.org/samples/latest/samples/extensions/timeline_semaphore/README.html?utm_source=chatgpt.com "Timeline semaphore :: Vulkan Documentation Project"
[2]: https://github.com/gfx-rs/wgpu/issues/2320?utm_source=chatgpt.com "Texture memory import API · Issue #2320 · gfx-rs/wgpu - GitHub"
[3]: https://github.com/gfx-rs/wgpu/issues/6921?utm_source=chatgpt.com "Unable to request feature support for NV12 texture on metal"
[4]: https://docs.rs/wgpu/latest/wgpu/struct.Texture.html?utm_source=chatgpt.com "Texture in wgpu - Rust - Docs.rs"
[5]: https://wgpu.rs/doc/wgpu_hal/vulkan/enum.Fence.html?utm_source=chatgpt.com "Fence in wgpu_hal::vulkan - Rust"
[6]: https://github.com/linebender/vello?utm_source=chatgpt.com "GitHub - linebender/vello: A GPU compute-centric 2D renderer."
[7]: https://docs.vulkan.org/refpages/latest/refpages/source/VK_EXT_external_memory_dma_buf.html?utm_source=chatgpt.com "VK_EXT_external_memory_dma_buf (3) :: Vulkan Documentation Project"
[8]: https://docs.rs/wgpu/latest/wgpu/struct.PipelineCacheDescriptor.html?utm_source=chatgpt.com "PipelineCacheDescriptor in wgpu - Rust - Docs.rs"
[9]: https://docs.rs/wgpu/latest/wgpu/enum.ShaderSource.html?utm_source=chatgpt.com "ShaderSource in wgpu - Rust - Docs.rs"
