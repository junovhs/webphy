Broadly: this revision is a major improvement, and it addresses the highest-risk assumption (that wgpu would give you stable external-surface import + external GPU sync). I am satisfied with the **direction** (hybrid model + explicit sync tiers + boundary object + two-pass UI), but I would **not** sign off yet as “architecturally complete” because there is still one unresolved fault line and a few concrete technical issues that will surface immediately in spikes.

Below is the sign-off gap analysis.

---

## What is now solid

1. **Hybrid model (wgpu for UI, native for video+present)**
   This is the correct reaction to the current state of external memory/sync in wgpu (still platform-dependent and often requiring unsafe backend work). ([GitHub][1])

2. **ImportedSurface as a boundary object**
   Making surface description + sync + color metadata explicit is the right architecture for cross-platform correctness.

3. **Explicit SyncTier ladder**
   This is exactly what you need to avoid “late failure” when one platform can’t do timeline sharing.

4. **Two-pass UI (Vello → UI RT → compose)**
   This removes the biggest performance non-starter.

5. **DashMap removal / fixed-capacity pool**
   Good move for predictability and memory budget.

---

## The remaining fault line: wgpu ↔ native *synchronization and ownership*

### The problem

“Extract raw handle from a wgpu texture, then use it in native composition” is not sufficient on its own.

* `Texture::as_hal` / raw-handle extraction is **explicitly unsafe** and places the burden of lifetime, usage-state, and synchronization correctness on you. ([Docs.rs][2])
* Even if the handle stays valid, you still must guarantee that:

  1. the UI compute pass has completed writing the UI RT, and
  2. the native compose pass sees the resource in a readable state, and
  3. wgpu will not concurrently reuse/transition/destroy that resource.

wgpu does not generally export an “external semaphore/fence for this submission” that you can wait on from native, so you risk reintroducing Tier C behavior (CPU coordination) just to bridge UI→compose.

### What I would change

You need to pick one of these explicit strategies:

**Strategy 1 (preferred if feasible): Make the UI RT native-owned, import into wgpu**

* Allocate the UI render target in Vulkan/D3D12/Metal.
* Wrap/import it into wgpu (using HAL-level “texture from raw” patterns with correct drop guards).
* Now *native* can safely read it after submitting the wgpu work because it owns the resource and can control synchronization boundaries more directly. (wgpu-hal’s “drop guard” semantics are part of how this is typically done.) ([GitHub][3])

**Strategy 2: Move UI rasterization into native as well**

* If Strategy 1 proves too brittle, the cleanest architecture is: decode + UI + compose all native per-platform.
* You can still keep your CSS/layout pipeline identical; only the raster backend changes.

**Strategy 3: Accept Tier C between UI and compose**

* This is the least desirable, but it can be made correct: `queue.on_submitted_work_done()` (or equivalent) then native compose.
* It will likely cost latency and occasionally frame time, but it is a defined fallback if you cannot bridge semaphores.

Until you choose and design this bridge explicitly, the hybrid architecture can still “fail late,” just in a different place.

---

## Concrete technical corrections needed

### 1) Linux DMA-BUF: SurfaceHandle must support *multiple objects* and plane↔object mapping

Your current `SurfaceHandle::DmaBuf { fd, modifier, drm_format }` assumes a single fd. In real DRM PRIME flows, a format can involve multiple planes and potentially multiple backing objects, depending on modifier and driver. The kernel DMA-BUF documentation explicitly frames planes as having offsets/strides, and libva’s PRIME2 structures are designed around plane/object relationships. ([Kernel.org][4])

**Fix:** represent DMA-BUF as:

* `objects: [OwnedFd; N]` (or Vec with cap),
* per-plane: `{ object_index, offset, stride, ... }`,
* modifier per object (or per layer, depending on descriptor).

### 2) Tier B “implicit sync during import” is not a safe default

Relying on implicit sync is increasingly fragile in modern explicit-sync pipelines; the kernel docs and industry discussions are clear that explicit synchronization (e.g., sync_file) is the direction of travel, and implicit sync can interfere with compositor-grade scheduling. ([LWN.net][5])

**Fix:** for Tier B, treat `sync_file` import as a first-class path (Vulkan `VK_KHR_external_semaphore_fd` with sync-fd handle types, where supported), and treat “implicit only” as a last resort.

### 3) Your wgpu upload ring is invalid as written (mapped buffers can’t be used by GPU)

In wgpu/WebGPU, a buffer is either **mapped for CPU** or **available to the GPU**, never both. Submitting copy commands that read from a still-mapped staging buffer will fail/panic. ([Docs.rs][6])

**Fix:** use `wgpu::util::StagingBelt` (it exists specifically for “many small writes”), or use `queue.write_buffer` with batching. ([Wgpu][7])

### 4) Color compositing: you are mixing color spaces incorrectly

In your compose shader you:

* convert video to sRGB (`oetf_srgb`),
* then sample UI (which you describe as “already sRGB”),
* then composite in that space.

Correct compositing should be done in **linear light**, then apply the output transfer function once at the end. Also, if your UI RT is created as an sRGB texture, sampling typically yields linear values; if it’s UNORM, sampling yields non-linear only if you encoded it that way. This must be nailed down per backend.

**Fix:** define UI RT format and sampling behavior explicitly:

* Option A: UI RT is linear RGBA (preferred); composite linear.
* Option B: UI RT is sRGB; ensure sampling produces linear; composite linear; apply final OETF.

### 5) Vulkan multi-planar sampling details are still tricky

You are doing manual Y+UV plane sampling and conversion. That can work, but Vulkan also has first-class Y′CbCr sampling support via `VK_KHR_sampler_ycbcr_conversion`, which exists largely to handle “video decoder outputs and cameras” correctly. ([Vulkan Documentation][8])

You do not have to use ycbcr conversion, but if you *don’t*, your spike must validate:

* correct plane aspect image views,
* correct normalization for UNORM formats,
* correct offsets/scales for limited/full range.

At minimum, treat `VK_KHR_sampler_ycbcr_conversion` as a viable optimization/fallback on Vulkan.

---

## Are the spikes the right plan?

Yes. The spike set is correct and early.

But update the “pass criteria” to include:

* **explicit sync validation** (at least one path that does not rely on implicit sync),
* **modifier/plane correctness** (export descriptor may include multiple objects; verify),
* **UI→compose bridge viability** (even if UI is a solid color RT for the spike, prove the interop + sync semantics).

---

## Verdict

I am satisfied that this revision is now pointed at a shippable architecture, *provided* you explicitly resolve the wgpu↔native bridge (resource ownership + GPU-visible synchronization). Right now, that bridge is still underspecified, and it is the only remaining “late failure” vector.

If you implement one of the three bridge strategies above (ideally native-owned UI RT imported into wgpu) and fix the DMA-BUF multi-object modeling + staging upload correctness, then I would consider this architecture ready for full execution.

[1]: https://github.com/gfx-rs/wgpu/issues/2320?utm_source=chatgpt.com "Texture memory import API · Issue #2320 · gfx-rs/wgpu - GitHub"
[2]: https://docs.rs/wgpu/latest/wgpu/struct.Texture.html?utm_source=chatgpt.com "Texture in wgpu - Rust - Docs.rs"
[3]: https://github.com/gfx-rs/wgpu/issues/6142?utm_source=chatgpt.com "[wgpu-hal] [Vulkan] Possibly changing the difference in ... - GitHub"
[4]: https://www.kernel.org/doc/html//latest/userspace-api/dma-buf-alloc-exchange.html?utm_source=chatgpt.com "Exchanging pixel buffers — The Linux Kernel documentation"
[5]: https://lwn.net/Articles/859290/?utm_source=chatgpt.com "dma-buf: Add an API for exporting sync files (v12) - LWN.net"
[6]: https://docs.rs/wgpu/latest/wgpu/struct.Buffer.html?utm_source=chatgpt.com "Buffer in wgpu - Rust - Docs.rs"
[7]: https://wgpu.rs/doc/wgpu/util/struct.StagingBelt.html?utm_source=chatgpt.com "StagingBelt in wgpu::util - Rust"
[8]: https://docs.vulkan.org/refpages/latest/refpages/source/VK_KHR_sampler_ycbcr_conversion.html?utm_source=chatgpt.com "VK_KHR_sampler_ycbcr_conversion (3) :: Vulkan Documentation Project"
