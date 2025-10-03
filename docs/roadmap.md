# Disposable Night — Next-Gen Authenticity Roadmap (Technical Spec)

**Audience:** core developers working on Disposable Night / webphy
**Purpose:** a definitive, build-ready plan to evolve the app from “good film vibe” to *indistinguishably authentic* emulation across disposable 35 mm, Polaroid/instant, consumer camcorders (VHS/MiniDV/Hi8), and early-smartphone (circa 2010) footage.
**Scope:** new modules, rewrites, parameters, shader/CPU algorithms, pipeline order, export/cadence, presets, testing, and delivery plan.

---

## 0) Design Principles & Constraints

* **Realism emerges from layers.** Prefer many subtle, physically-motivated artifacts over a few heavy artistic filters.
* **Color discipline.** Do physically-based math in linear light; convert to/from sRGB only at boundaries. Be explicit per stage.
* **Parallels across preview & export.** The headless Electron export must render bit-identical to on-screen “Native Output Preview” mode at the chosen native resolution/cadence.
* **Non-destructive, modular pipeline.** Small, single-responsibility passes with explicit inputs/outputs.
* **Determinism by seed.** Pseudorandom effects accept seeds for reproducibility; vary over time via seeded frame counters.

---

## 1) Current Baseline (for reference)

* **ExposureFlashModule** (linear EV & inverse-square flash)
* **ToneModule** (S-curve + lift/crush/shoulder)
* **SplitCastModule** (artistic split toning & color cast)
* **BloomVignetteOptics** (bright pass → pyramid blur → add, plus vignette, clarity, chromatic aberration)
* **MotionBlurModule** (24-tap with “wiggle”)
* **HandheldCameraModule** (multi-octave noise transform)
* **FilmGrainModule** (AV1-inspired mixed noise with intensity curve)

We will **keep** Exposure/Flash, Handheld, Grain, and Bloom core; **rewrite** Tone into a filmic response; **add** new physically-based modules; and **split** Bloom to house new optics variants.

---

## 2) Target Pipeline (high-level order)

```
[Media Ingest → Linearize if needed]
ExposureFlash → (Optional) GateWeave transform → FilmicResponse
→ LensOptics/MTF → Bloom/Halation (+ variants)
→ (Optional) RollingShutter → MotionBlur
→ (Optional) CCD Vertical Smear → Vignette/Clarity/CA
→ (Optional) SparseDefects/LightLeaks
→ FilmGrain (placement configurable)
→ OutputFormat (Downsample + Cadence)
→ (Optional) Interlacing/HeadSwitch → CodecArtifacts
→ OSD/DateStamp → Display/Export
```

Notes:

* **GateWeave** is distinct from **Handheld** (operator motion). GateWeave is tiny, slow, and always on for film/camcorder looks. Handheld remains a creative control.
* **Grain placement** can be `pre_resize` (film scan look) or `post_codec` (digital feel).

---

## 3) Priority Plan Overview

| Priority | Module                                       | Type      | Goal                                                 |
| -------- | -------------------------------------------- | --------- | ---------------------------------------------------- |
| **P0**   | FilmicResponse (rewrite Tone)                | Core      | Film/stock-accurate curve & crossover                |
| **P0**   | LensOptics/MTF                               | New       | Real lens softness, field falloff, subtle distortion |
| **P0**   | TemporalInstability (Flicker/Weave/WB drift) | New (CPU) | Temporal authenticity cues                           |
| **P0**   | OutputFormat (Downsample+Cadence)            | New       | Era-correct native size & frame cadence              |
| **P0**   | CodecArtifacts                               | New       | Chroma bleed, block/ringing, mosquito                |
| **P1**   | Interlacing + HeadSwitch                     | New       | Camcorder giveaway artifacts                         |
| **P1**   | RollingShutter + SharpenHalo                 | New       | Early iPhone signature                               |
| **P1**   | CCD Vertical Smear + Anamorphic Bloom        | Extend    | CCD highlight streaks; anamorphic flavor             |
| **P1**   | SparseDefects + LightLeaks                   | New       | Film defects used sparingly                          |
| **P1**   | OSD/DateStamp                                | New       | Disposable/point-and-shoot era stamp                 |
| **P2**   | InstantFilm (chemical/paper/frame)           | New       | Polaroid development & paper texture                 |
| **P2**   | AE/AWB Hunt (temporal controller)            | New (CPU) | Auto exposure/WB oscillation                         |
| **P2**   | Negative → Print pipeline                    | New       | Orange mask & print LUT staging                      |

---

## 4) Detailed Specifications

### 4.1 FilmicResponseModule (rewrite of Tone)

**Objective:** Replace artistic curve set with a parametric *H-curve* that matches film/stock response, including optional color crossover.

**Inputs**

* `uTex` (RGB in **linear**)
* Uniforms: `uToe`, `uMid`, `uShoulder`, `uContrastTrim`, `uCrossoverRGB` (vec3 small deltas), `uEnableCrossover` (bool)
* Optional: `uLut1D` (256×1 or 1024×1 RGB) **or** computed curve function on GPU

**Algorithm**

* CPU: generate 1D LUT(s) in linear light:

  * Toe (logistic), straight-line mid, shoulder (soft knee).
  * Ensure **monotonic** curve; preserve neutral mid-gray (0.18) mapping via constraint.
  * If `enableCrossover`, apply mild channel-dependent shoulder softening.
* GPU: single texture lookup per channel.

**Outputs**

* RGB in **linear** for subsequent optics.

**Parameters**

* `toe` [0..0.4], `mid` [0.2..0.8], `shoulder` [0..0.5], `contrastTrim` [-0.2..0.2], `crossoverRGB` ~ ±0.02

**Acceptance**

* Step wedge test produces film-like roll-off; R/G/B track closely with slight divergence in highlights when crossover > 0.

---

### 4.2 LensOpticsModule (MTF & Falloff)

**Objective:** Simulate lens resolving power and field behavior.

**Inputs**

* `uTex` (linear), `uPx` (1/width, 1/height)
* Uniforms: `uSigma` (base blur), `uEdgeFalloff`, `uRinging`, `uBarrel`, `uFieldCurvature`

**Algorithm (MVV)**

1. **Base MTF rolloff:** separable Gaussian (5–7 taps) with σ = `uSigma`.
2. **Edge falloff:** multiplicative radial mask `mask = mix(1, 1 - smoothstep(r0,r1,r^2), uEdgeFalloff)`.
3. **Optional barrel distortion:** warp UV `uv' = uv + k*(uv-0.5)*|uv-0.5|^2`.
4. **Optional ringing:** light unsharp masking with **non-negative clamp** to avoid dark halos.

**Outputs**

* RGB linear

**Parameters**

* `mtfSigma` [0..1.5], `edgeFalloff` [0..1], `ringing` [0..0.5], `barrel` [0..0.03], `fieldCurvature` [0..0.02]

**Acceptance**

* Slanted-edge MTF chart shows softening & slight corner drop; ringing only when enabled and small.

---

### 4.3 TemporalInstability (CPU controller)

**Objective:** Subtle, slow changes over time: luminance flicker, white-balance drift, gate weave.

**State**

* `evBias`, `wbGains` (vec3 around 1.0), `weaveOffset` (x,y), `weaveRot` (radians), each as bounded random walks seeded by `seed + moduleOffset`.

**Algorithm**

* Each frame `t`:

  * `evBias ← clamp(evBias + N(0, σ_ev), [-0.01, 0.01])`
  * `wbGains.c ← clamp(wbGains.c + N(0, σ_wb), [0.985, 1.015])`
  * `weaveOffset ← weaveOffset + N2(0, σ_xy)`, clamp to ±0.3 px; `weaveRot ← clamp(weaveRot + N(0,σ_rot), ±0.06°)`
* Provide uniforms to:

  * ExposureFlash (add EV bias; multiply WB gains post-filmic if desired).
  * A lightweight **WeavePass**: transform quad vertices by `(translate, rotate)` before sampling the current texture.

**Parameters**

* `flicker` [0..0.01], `wbDrift` [0..0.01], `weave` [0..0.005]

**Acceptance**

* With handheld OFF, stepping frames shows tiny float without judder; luma varies <0.5% RMS over 2–3 s windows.

---

### 4.4 OutputFormat (Downsample + Cadence)

**Objective:** Era-correct native size/framerate and a “Native Output Preview.”

**Inputs**

* `targetRes`: presets (`480p_720x480`, `960x540`, `720p`, custom WxH)
* `targetFPS`: {24, 25, 29.97, 30} (extendable)
* `previewNative`: bool

**Downsample**

* Option A (fast): pre-blur σ≈0.6 then bilinear to target.
* Option B (better): single-pass bicubic/Mitchell-Netravali kernel.

**Cadence**

* Render/export clock runs at targetFPS; for preview, when app < native FPS, do nearest or 2-tap frame blend `c = (1-α)*prev + α*curr` to soften judder.

**Acceptance**

* Pixel-exact equality between Native Preview and Export at same settings; cadence toggling changes motion feel immediately.

---

### 4.5 CodecArtifacts

**Objective:** Recreate key digital/video artifacts.

**Inputs**

* RGB (sRGB for final composite is fine)

**Pipeline (MVV)**

1. **YCbCr convert.**
2. **Chroma subsampling:** downsample Cb/Cr to half res (or 1/4 for 4:1:1), upsample with nearest or linear → **bleed**.
3. **Block/Ringing mask:** build 8×8 energy by sampling local gradient; near strong edges, apply tiny overshoot kernel.
4. **Mosquito noise:** add small, edge-proximate high-freq “buzz” masked by gradient magnitude.

**Parameters**

* `subsampleMode` {4:2:0, 4:1:1, off}, `chromaBleed` [0..1], `ringing` [0..0.5], `mosquito` [0..0.5]

**Acceptance**

* Fine colored edges show characteristic color spread; thin text exhibits faint halo/mosquito that disappears when disabled.

---

### 4.6 Interlacing + HeadSwitch (camcorder)

**Objective:** Field-based rendering and head-switch noise strip.

**Algorithm**

* **Interlace synth:** Render full frame, then compose two fields: odd/even lines from different timestamps (for preview, allow same frame). Option to add 0.5-line vertical offset to one field.
* **Head switch:** bottom N lines add noise/phase shift and minor horizontal jitter.

**Parameters**

* `interlace` bool, `deintSoftness` [0..1], `headSwitch` [0..1], `headSwitchHeightPx` default 6–12 px

**Acceptance**

* Stepping frames shows classic combing on motion; bottom band visible at non-zero `headSwitch`.

---

### 4.7 RollingShutter + SharpenHalo (early iPhone)

**Objective:** CMOS scan skew and aggressive in-camera sharpening.

**Algorithm**

* **Rolling shutter:** for each fragment `y`, offset UV by `rsAmount * (y * pxY) * motionProxy`, where motionProxy derives from handheld parameters or recent frame difference energy.
* **Sharpen halo:** unsharp mask with overshoot clamp slightly above 1.0 (e.g., 1.04) to create bright halos.

**Parameters**

* `rsAmount` [0..1], `haloStrength` [0..1], `haloRadius` [0.5..2.0]

**Acceptance**

* Horizontal pans show vertical lines leaning; halos visible on high-contrast edges at modest strengths.

---

### 4.8 CCD Vertical Smear + Anamorphic Bloom

**Objective:** CCD highlight streaks and anamorphic flavor.

**Algorithm**

* **Smear:** bright threshold → 1D vertical blur with exponential falloff; additively composited.
* **Anamorphic bloom:** reuse bloom but stretch blur kernel in X; adjustable aspect.

**Parameters**

* `ccdSmear` [0..1], `smearDecay` [0.2..2.0], `bloomAnamorph` [1.0..4.0]

**Acceptance**

* Point highlights produce vertical streaks; bloom stretches horizontally as ratio rises.

---

### 4.9 SparseDefects + LightLeaks

**Objective:** Rare, tasteful defects.

**Algorithm**

* **Dust/Specks:** per-minute Poisson process; small white/black dots with soft edges.
* **Scratches:** thin vertical lines with intermittent gaps; drift slowly.
* **Light leaks:** edge-anchored color gradients, temporally gated on/off.

**Parameters**

* `defectRate` [0..1], `scratchProb` [0..1], `leakStrength` [0..1], `leakHue` [0..1]

**Acceptance**

* At default values, defects appear infrequently; turning rates up makes effect obvious for QA.

---

### 4.10 OSD / DateStamp

**Objective:** Period-correct on-frame text.

**Algorithm**

* Raster a 7-segment font into a small atlas; draw with slight blur, subpixel offset jitter, and faint glow/bleed.
* Support `YYYY.MM.DD`, `MM.DD.YY`, time, “ISO 400/800” badges.

**Parameters**

* `dateOn` bool, `dateFormat` enum, `osdAging` [0..1], `osdPosition` (corner presets)

**Acceptance**

* Crisp but slightly bloomed digits; subtle frame-to-frame subpixel jitter when enabled.

---

### 4.11 InstantFilm (Polaroid)

**Objective:** Chemical spread, developer bloom, paper & frame.

**Algorithm (staged)**

1. **Developer bloom:** high-luma near borders gets soft additive glow.
2. **Uneven chemical spread:** low-freq multiplicative mask varying across frame.
3. **Paper texture:** normal-mapped paper grain; lit with tiny fake oblique light to reveal tooth.
4. **Frame composite:** scan-like border with drop shadow option.

**Parameters**

* `devBloom` [0..1], `chemStreak` [0..1], `paperTexture` enum, `frameStyle` enum

**Acceptance**

* Whites near edges look “milky”; paper grain visible at angle; frame looks photographic, not vector-clean.

---

### 4.12 AE/AWB Hunt (CPU)

**Objective:** Simulate consumer device auto-exposure and WB hunting.

**Algorithm**

* Frame histogram → target exposure; apply PID-like controller with intentional overshoot and slow settle.
* WB target from gray world or highlights; add latency and noise.

**Parameters**

* `aeSensitivity` [0..1], `awbSensitivity` [0..1], `huntOvershoot` [0..0.2]

**Acceptance**

* Cuts cause brief over/under-shoot; color temp drifts before settling.

---

### 4.13 Negative → Print pipeline (advanced)

**Objective:** Proper color negative modeling.

**Stages**

* Linear scene → **Camera Neg Log** (with orange mask) → **Print LUT** → sRGB.
* Optional: place **Grain** before scan stage for “in-negative” feel.

**Parameters**

* `negMode` bool, `orangeMask` strength, `printContrast`, LUT selector

**Acceptance**

* Accurate neutralization of orange mask; pleasing filmic colors without heavy secondary grading.

---

## 5) API & Wiring (app structure)

### 5.1 Module interface (JS)

```js
class ModuleX {
  constructor(gl, quad) { /* compile, uniforms */ }
  apply(inputTex, outputFB, params, ctx) {
    // ctx: { pxX, pxY, frame, seed, canvasW, canvasH, colorSpaceFlags, ... }
  }
  // optional: prepass/postpass or resize handlers
}
```

### 5.2 UI contract

* **PARAMS maps**: `min/max/step/default/label/special` per module.
* **TAB_CONFIG**: group new modules under **Response**, **Optics**, **Temporal**, **Output**, **Artifacts**, **Medium**.
* **Preset Manager**: load/save JSON (schema below), hot-swap values → mark `needsRender`.

### 5.3 Preset schema (JSON)

```json
{
  "name": "MiniDV 2004",
  "native": { "width": 720, "height": 480, "fps": 29.97, "interlace": true },
  "seed": 1337,
  "params": {
    "ExposureFlash": { "ev": -0.10, "flashStrength": 0.0 },
    "FilmicResponse": { "toe": 0.12, "mid": 0.50, "shoulder": 0.34, "crossoverRGB": [0.01, 0.0, -0.01] },
    "LensOptics": { "mtfSigma": 0.9, "edgeFalloff": 0.25, "barrel": 0.01, "ringing": 0.05 },
    "TemporalInstability": { "flicker": 0.004, "wbDrift": 0.003, "weave": 0.002 },
    "Bloom": { "intensity": 0.15, "warm": 0.1, "anamorph": 1.0, "ccdSmear": 0.25 },
    "RollingShutter": { "rsAmount": 0.0 },
    "MotionBlur": { "shutterUI": 0.12, "shake": 0.2, "motionAngle": 0.0 },
    "Grain": { "filmSpeed": 400, "grainCharacter": 0.55, "grainChroma": 0.30, "placement": "pre_resize" },
    "OutputFormat": { "targetRes": "720x480", "targetFPS": 29.97, "previewNative": true },
    "Interlace": { "enabled": true, "headSwitch": 0.2, "deintSoft": 0.15 },
    "CodecArtifacts": { "subsampleMode": "4:1:1", "chromaBleed": 0.7, "ringing": 0.25, "mosquito": 0.15 },
    "OSD": { "dateOn": true, "dateFormat": "MM.DD.YY" }
  }
}
```

---

## 6) Implementation Notes (per module)

* **Shaders:** stay WebGL2-friendly; provide WebGL1 fallback when cheap (no integer samplers).
* **Framebuffers:** reuse existing ping-pong `rtA/rtB` plus half/quarter/eighth levels for bloom; add half-res attachments for chroma passes.
* **WeavePass:** tiny transform on fullscreen quad; ensure it composes with Handheld (apply weave *before* handheld or vice versa, but keep stable).
* **Rolling shutter motion proxy:** If no optical flow, approximate with recent camera transform deltas (handheld) or mean frame diff magnitude.
* **Performance budget:** aim <2 ms per added pass at 1080p on mid GPU. Make heavier passes scale with preview resolution.
* **Non-negativity:** replicate clarity’s “no negative lobes” rule in any sharpen/ringing stage.

---

## 7) QA / Bench Tests

### 7.1 Unit-style visual tests

* **FilmicResponse:** gray ramp → verify monotonic mapping and channel crossover in highlights only when enabled.
* **MTF:** slanted-edge chart → extract MTF50; assert reduction matches `mtfSigma`.
* **Temporal:** log EV/WB/Weave over 10 s → RMS within target.
* **OutputFormat:** downsample→export→compare pixel-wise equality with preview.
* **Codec:** colored Siemens star → verify chroma bleed; text halo thresholds.
* **Interlace:** moving bar pattern → combing visible on odd frames.

### 7.2 Golden presets

* Create “golden” renders for each preset using fixed seed and short test clips; diffs must be < ε between runs.

---

## 8) Developer Tasks & Milestones

### Milestone A (P0 foundation)

1. **FilmicResponseModule** (1D LUT) + UI parameters + preset scaffold.
2. **LensOptics/MTF** (separable + edge falloff + optional barrel).
3. **TemporalInstability** (CPU controller + WeavePass).
4. **OutputFormat** (downsample + cadence + Native Preview).
5. **CodecArtifacts** (YCbCr subsample + light ringing/mosquito).
   **Deliverables:** 3 “era” presets (35 mm consumer, MiniDV 2004, Early iPhone 2010) with A/B tests.

### Milestone B (P1 medium tells)

6. **Interlacing + HeadSwitch** path.
7. **RollingShutter + SharpenHalo**.
8. **CCD Vertical Smear + Anamorphic Bloom** (flag inside Bloom module).
9. **SparseDefects + LightLeaks** (global sparse controller).
10. **OSD/DateStamp** overlay.
    **Deliverables:** 5 polished presets (add Polaroid-ish still & Hi8) + sample exports.

### Milestone C (P2 mastery)

11. **InstantFilm** (chem/paper/frame) with asset pipeline.
12. **AE/AWB Hunt** controller.
13. **Negative→Print** experimental path (behind feature flag).
    **Deliverables:** “Instant” and “Lab Scan” presets, documentation.

---

## 9) Developer Ergonomics

* **Preset Manager UI:** import/export JSON, duplicate, quick-compare (A/B hotkey).
* **Seed Discipline:** `globalSeed` + per-module offsets (`seed ^ 0x9E3779B9 * moduleIndex`).
* **Profile overlay:** on-screen ms per pass; warn when any pass >3 ms at 1080p.
* **Error Bars:** clamp parameters in UI; show tooltips with realism guidance.
* **Native Preview Toggle:** icon with the target resolution & FPS label.

---

## 10) Security & Export Parity

* **Electron**: context isolation on; minimal `electronAPI` surface (export start/progress/finish).
* **Parity checks**: auto-run a short export pipeline test at build time that compares headless export to on-screen Native Preview for a fixed seed/clip.

---

## 11) File/Code Skeletons (drop-in)

**`web/modules/filmic-response.js`**

```js
export const FILMIC_PARAMS = {
  toe:{min:0,max:0.4,step:0.005,default:0.10,label:'Toe'},
  mid:{min:0.2,max:0.8,step:0.01,default:0.5,label:'Mid Gray'},
  shoulder:{min:0,max:0.5,step:0.01,default:0.30,label:'Shoulder'},
  contrastTrim:{min:-0.2,max:0.2,step:0.005,default:0.0,label:'Contrast Trim'},
  crossoverR:{min:-0.03,max:0.03,step:0.001,default:0.0,label:'R Shoulder Δ'},
  crossoverG:{min:-0.03,max:0.03,step:0.001,default:0.0,label:'G Shoulder Δ'},
  crossoverB:{min:-0.03,max:0.03,step:0.001,default:0.0,label:'B Shoulder Δ'},
  enableCrossover:{min:0,max:1,step:1,default:0,label:'Enable Crossover'}
};
// class FilmicResponseModule { constructor(gl,quad){...} apply(inputTex, outputFB, p, ctx){...} }
```

**`web/modules/lens-optics.js`**

```js
export const LENS_OPTICS_PARAMS = {
  mtfSigma:{min:0,max:1.5,step:0.05,default:0.6,label:'MTF Blur'},
  edgeFalloff:{min:0,max:1,step:0.01,default:0.2,label:'Edge Falloff'},
  ringing:{min:0,max:0.5,step:0.01,default:0.0,label:'Ringing'},
  barrel:{min:0,max:0.03,step:0.001,default:0.0,label:'Barrel Distortion'}
};
```

**`web/controllers/temporal-instability.js`**

```js
export const TEMPORAL_PARAMS = {
  flicker:{min:0,max:0.01,step:0.0001,default:0.003,label:'Luma Flicker'},
  wbDrift:{min:0,max:0.01,step:0.0001,default:0.003,label:'WB Drift'},
  weave:{min:0,max:0.005,step:0.0001,default:0.0015,label:'Gate Weave'}
};
// tick(ctx): mutates ctx.evBias, ctx.wb, ctx.weaveTransform
```

**`web/modules/output-format.js`**

```js
export const OUTPUT_PARAMS = {
  targetRes:{min:0,max:0,step:0,default:'960x540',label:'Target Resolution'},
  targetFPS:{min:0,max:0,step:0,default:29.97,label:'Target FPS'},
  previewNative:{min:0,max:1,step:1,default:1,label:'Native Output Preview'}
};
```

**`web/modules/codec-artifacts.js`**

```js
export const CODEC_PARAMS = {
  subsampleMode:{min:0,max:2,step:1,default:1,label:'Chroma Mode (0=off,1=420,2=411)'},
  chromaBleed:{min:0,max:1,step:0.01,default:0.6,label:'Chroma Bleed'},
  ringing:{min:0,max:0.5,step:0.01,default:0.2,label:'Ringing'},
  mosquito:{min:0,max:0.5,step:0.01,default:0.1,label:'Mosquito'}
};
```

(Other skeletons analogous; keep class pattern consistent with existing modules.)

---

## 12) Risks & Mitigations

* **Performance regressions:** Keep passes separable where possible; expose “Preview Quality” that lowers taps at edit time and restores full taps on export.
* **Order coupling:** Encode pipeline order centrally; add a unit test that asserts relative stage ordering.
* **Parameter explosion:** Provide preset-first UX; hide advanced controls behind “expert” toggles.
* **Export mismatch:** Automated parity test with fixed seed, clip, and preset on CI.

---

## 13) Documentation & Onboarding

* Update the Developer Guide with: pipeline diagram, module list & order, parameter glossary, color-space rules, preset schema, and profiling tips.
* Add “How to create a new medium preset” doc (copy a base preset, tweak 6–8 key parameters, capture golden frames).
* Provide a small *test footage pack* (pan, tilt, fine patterns, highlights, faces, night city) for QA.

---

### Final Note

Ship **P0** first (FilmicResponse, LensOptics/MTF, TemporalInstability, OutputFormat, CodecArtifacts). The moment those land with a couple of tuned presets, your footage will begin to pass the “did this come from a real device?” sniff test. P1 mediums then add the unmistakable tells; P2 is the polish that makes colorists and editors happy.