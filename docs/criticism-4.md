Net: this is *much* closer to an implementation-ready spec. The interop layer is now treated as the primary risk, the DMA-BUF modeling is realistic, linear-light compositing is explicitly required, and your spike plan is the right gating mechanism.

That said, I would still **not** treat this as “architecturally done” yet, for one reason: **Option A (native-controlled submission of wgpu-recorded command buffers) is very likely to be brittle or infeasible without effectively forking/embedding wgpu-core/hal**.

Below is the punch list—what’s solid, what’s still a trap, and what I would change before committing.

---

## What is now solid

### 1) Interop is correctly elevated to a first-class subsystem

Your explicit tiers and pass/fail spikes are exactly how you prevent late-stage collapse.

### 2) DMA-BUF modeling is materially improved

Moving from a single-fd fantasy to a PRIME2-like descriptor is the correct direction.

### 3) Linear-light compositing is explicitly mandated

You’ve correctly identified (and corrected) the “blend in non-linear space” halo problem.

---

## The remaining “late failure” vector: Option A (native submission of wgpu commands)

### Why it’s risky

Even if you can *extract* a raw `VkCommandBuffer`, wgpu’s execution model is not “one encoder → one native command buffer submitted exactly as-is.”

Two key facts:

1. **wgpu may insert extra command buffers between yours to handle state transitions/barriers** (“batching barriers”). If you bypass `Queue::submit`, you also bypass this stitching unless you reimplement it. ([Wgpu][1])

2. Internally, wgpu-core’s encoder/command machinery can hold **multiple raw command buffers and reorder them** specifically because the backend submission takes a list of buffers at once. ([doc.servo.org][2])

Additionally, Vulkan ordering in wgpu’s HAL backend has historically required **relay semaphores / special handling** to preserve the ordering guarantees wgpu promises at the API level; it’s an area with known sharp edges. ([GitHub][3])

### What this implies

Option A is not “just submit the raw handle with `vkQueueSubmit2` and your own semaphores.” In practice it tends to become one of:

* **A pinned wgpu fork** where you add an officially supported “external submission” path that still performs wgpu’s barrier stitching + lifetime tracking + ordered submission semantics, or
* **Dropping to wgpu-hal directly** (and accepting that you’re now responsible for much more correctness/synchronization glue), or
* **Abandoning Option A** and treating Tier C (CPU coordination) as the realistic cross-platform bridge.

### Recommendation

Treat Spike 4 as a **go/no-go for Option A**, *with an explicit commitment decision*:

* **If Spike 4 passes only by reaching into wgpu internals** (private structs, fragile `as_hal` assumptions, version-specific behavior), assume you will be maintaining a fork and budget accordingly.
* If you are not willing to carry that maintenance burden, **promote Tier C for UI→compose to the default** and make Option A a *platform-specific optimization* (likely Vulkan-only).

---

## Concrete issues in the “Final Architecture Specification”

### 1) UI render target format conflicts with Vello’s requirements

You specify RGBA8 sRGB as the default UI RT, but Vello’s wgpu renderer expects the target texture to be `Rgba8Unorm` and to include `STORAGE_BINDING` usage. ([Docs.rs][4])

In wgpu/WebGPU, sRGB formats are generally **not valid as storage textures**, so “compute raster → sRGB UI RT” is not a safe assumption.

**Fix:** make the UI RT **`Rgba8Unorm` (linear)** as the canonical target for the Vello compute path, and treat UI authored colors as linearized in the renderer/shader pipeline. If you need sRGB authoring semantics, convert at authoring boundaries (style/color parsing) or at composition sampling (but do not rely on storage writing into an sRGB texture).

### 2) Alpha compositing math is inconsistent with your “premultiplied” premise

Your final shader draft uses:

```
composited_linear = ui_linear * ui.a + video_linear * (1 - ui.a)
```

That is **straight-alpha** compositing. Earlier you explicitly wanted **premultiplied** (“out = src + dst*(1-src.a)”).

Vello-style renderers commonly output **premultiplied alpha**. If your UI RT is premultiplied, the correct form is:

```
composited_linear = ui.rgb + video_linear * (1 - ui.a)
```

(no extra multiply by `ui.a`).

**Fix:** pick one convention (strongly recommend **premultiplied alpha end-to-end**) and enforce it in:

* UI renderer output
* composition shader math
* any intermediate blits/resolves

### 3) DMA-BUF import still assumes “single object” at bind time

Your import function acknowledges multi-object descriptors, but the sample bind path still effectively imports/binds **only `objects[0]`**.

If you encounter multi-object exports, you may need per-plane/per-object binding via `vkBindImageMemory2` plus `VkBindImagePlaneMemoryInfo` (and correct object/plane mapping). The “single object common case” is fine as a fast path, but don’t let the code structure imply it’s universally valid.

**Fix:** implement:

* Fast path: `num_objects == 1`
* General path: `num_objects > 1` with explicit per-plane binding

### 4) “Infer width/height from stride” is the wrong direction

For video surfaces you already know coded size (and display size) from the bitstream/container. Stride is an allocation detail; it should not be used to infer dimensions.

**Fix:** treat width/height as authoritative inputs from decode metadata and validate that plane pitches are compatible, not the other way around.

---

## What I would sign off on (conditional) vs not

### I would sign off on (conditional on spikes)

* Hybrid pipeline: native decode + native composition, wgpu/Vello only for UI generation
* Sync tiers + spike gating
* Linear-light compositing with output transfer applied once at the end
* PRIME2-style DMA-BUF descriptors

### I would **not** sign off on yet

* Option A as the “primary” strategy, unless you explicitly accept that it may require a wgpu fork / deep internal integration. The public-facing wgpu model is not designed around “you submit my command buffers for me,” and wgpu’s own docs/internal architecture strongly suggest there is hidden submission work you would be bypassing. ([Wgpu][1])

---

## Practical path forward

1. **Update the spec** to make UI RT = `Rgba8Unorm` (linear) for the compute path, and lock in premultiplied alpha.
2. **Run Spike 4 first**, before polishing anything else.
3. Decide upfront:

   * **Fork wgpu** (Option A viable), or
   * **Tier C default** (ship reliably), or
   * **Native UI renderer** (eliminate the bridge entirely).

If you tell me which of those three you’re willing to own (maintenance burden vs latency), I can give you a tighter “minimum viable implementation plan” and a risk-adjusted milestone breakdown.

[1]: https://wgpu.rs/doc/wgpu/api/command_encoder/struct.CommandEncoder.html?utm_source=chatgpt.com "CommandEncoder in wgpu::api::command_encoder - Rust"
[2]: https://doc.servo.org/wgpu_core/command/struct.CommandEncoder.html?utm_source=chatgpt.com "CommandEncoder in wgpu_core::command - Rust - doc.servo.org"
[3]: https://github.com/gfx-rs/wgpu/issues/5559?utm_source=chatgpt.com "Vulkan Swapchain and Submit Synchronization Incorrect"
[4]: https://docs.rs/vello/latest/vello/struct.Renderer.html?utm_source=chatgpt.com "Renderer in vello - Rust - Docs.rs"
