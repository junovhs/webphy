# Disposable Night — Architecture & Developer Guide
created 10/3/2025 - verify this is up to date before trusting. 

**Goal.** Disposable Night is a GPU‑accelerated film‑emulation application targeting images and videos. It reproduces disposable‑camera aesthetics via modular WebGL effects and supports native‑resolution video export through an Electron + FFmpeg pipeline. The design emphasizes realism (physics‑informed effects), creative controls, and a strict separation between *rendering*, *UI*, and *export* concerns. 

## Table of Contents

1. [System Overview](#system-overview)
2. [Build, Run & Project Layout](#build-run--project-layout)
3. [Rendering Pipeline](#rendering-pipeline)
4. [Effect Modules (GPU)](#effect-modules-gpu)
5. [WebGL Context & Render Targets](#webgl-context--render-targets)
6. [UI Contract & Pure UI](#ui-contract--pure-ui)
7. [Media Ingest & Playback](#media-ingest--playback)
8. [Export Pipelines](#export-pipelines)
9. [Color, Luminance & Numerical Stability](#color-luminance--numerical-stability)
10. [Performance Characteristics](#performance-characteristics)
11. [Security & Electron Preload](#security--electron-preload)
12. [How to Add a New Effect Module](#how-to-add-a-new-effect-module)
13. [Parameter Reference](#parameter-reference)
14. [Known Behaviors & Gotchas](#known-behaviors--gotchas)

---

## System Overview

Disposable Night runs in two modes:

* **Browser runtime** for interactive editing, with GPU processing in a single WebGL canvas. The main entry is `web/index.html` which loads `app.js`. 
* **Electron runtime** for high‑quality *native‑resolution* export. The main UI window loads the same web app; a hidden *headless renderer* window (`export.html`) performs frame‑accurate GPU processing while FFmpeg handles decode/encode. 

**High‑level architecture (logical):**

```
Main UI (index.html + app.js)
  ├─ WebGL Effects (modules/*)  ← GPU shaders & apply()
  ├─ UI Contract (ui-api.js)    ← marshals params/state for UI, media, export
  ├─ Pure UI (ui.js + styles.css)
  ├─ Media controls (media.js)
  └─ Export controller (export.js)

Electron (main.js + preload.js)
  ├─ FFmpeg decoder → raw RGBA frames
  ├─ Headless Renderer (export.html + renderer-export.js)
  └─ FFmpeg encoder (H.264 yuv420p) → MP4
```

(Main/UI & export windows are bridged with IPC; see §[Export Pipelines](#export-pipelines).) 

---

## Build, Run & Project Layout

### Prerequisites

* Node.js (LTS recommended) and npm.
* For Electron export: the app bundles **ffmpeg-static** (so no system FFmpeg required). 

### Install & start (dev)

```bash
npm install
# Web+Electron app
npx electron .
```

*(If a `start` script is present in `package.json`, `npm start` is equivalent.)* The Electron app loads `web/index.html` in the main window. 

### Layout (selected)

* `web/index.html`, `web/styles.css` — shell and layout.
* `web/app.js` — wires GL, modules, UI, media, export; owns the on‑screen render loop. 
* `web/gl-context.js` — context creation, capability probing, shader compile, FBO helpers. 
* `web/modules/*.js` — effect modules; each exports parameters + shader program + `apply(...)`.
  (Exposure/Flash, Tone, Split Cast, Bloom/Vignette/Optics, Motion Blur, Handheld Camera, Film Grain.)
* `web/ui-api.js` — *only* bridge that knows about app internals and the pure UI. 
* `web/ui.js` — pure, framework‑free UI generation + controls. 
* `web/media.js` — file open, play/pause, original toggle, view mode, reset. 
* `web/export.js` — Export button, chooses Electron/native or web fallback. 
* `web/export.html`, `web/renderer-export.js` — headless renderer window. 
* `main.js`, `preload.js` — Electron main process + context‑isolated preload. 
* `web/export-images.js`, `web/export-video.js`, `web/frame-encoder.worker.js` — frame‑sequence exports & worker encoding utilities (used in web fallback or legacy paths).
* `web/readme.md` — design intent & philosophy. 

---

## Rendering Pipeline

The on‑screen pipeline (simplified) runs once per needed frame and uses ping‑pong framebuffers at multiple scales:

1. **Exposure** (linear) → **Handheld shake** (video only) → **Motion blur** (if shutter > 0) → **Flash** →
2. **Bloom chain**: bright extract → downsample/blur (H/Q/E) → upsample & add →
3. **Tone curve** → **Split toning** → **Color cast** → **Vignette** → **Bloom+Halation composite** →
4. **Clarity** (if > 0) → **Chromatic aberration** → **Film grain** to default framebuffer.

This order matches `app.js` and the headless renderer’s `renderFrame()` in `renderer-export.js`.

**Ping‑pong render targets.** Full‑res double buffers `rtA/rtB`; half (`rtH_*`), quarter (`rtQ_*`), eighth (`rtE_*`) for bloom; `rtBloom` holds the assembled bloom texture. Ensured on every layout/resize. 

---

## Effect Modules (GPU)

Each effect lives in `web/modules/<name>.js` with:

* exported **PARAMS** map (min/max/step/default/label, and optional `special` formatters),
* GLSL vertex/fragment shader sources,
* a class with `createProgram()` and `apply(...)`.

The UI auto‑builds sliders from PARAMS; see §[UI Contract](#ui-contract--pure-ui).

### Exposure & Flash

* **Exposure** converts to **linear**, applies EV via `exp2(uEV)`, outputs *linear* color—intended to feed subsequent stages. **Flash** is an inverse‑square‑like gain around a center with adjustable strength and falloff (aspect‑corrected radius). Params: `ev`, `flashStrength`, `flashFalloff`. 

### Tone Curve

Four controls: `scurve`, `blacks` (crush), `blackLift` (lifted blacks), and `knee` (highlight rolloff). Implemented with smooth S‑curve, crush, lift, and shoulder functions. 

### Split Toning & Color Cast

Two passes:

* Split toning (`shadowCool`, `highlightWarm`) applies weighted color multipliers by luma.
* Color cast (`greenShadows`, `magentaMids`) applies targeted multipliers, emphasizing shadows and midtones. 

### Bloom, Vignette, Optics

* **Bright extract** uses threshold & simple bloom warm curve; multi‑level downsample/blur and upsample/add;
* **Composite** blends (screen) the bloom back and adds halation tint;
* **Vignette** is radial with adjustable power;
* **Clarity** applies unsharp‑mask‑style detail (with non‑negative clamp);
* **Chromatic aberration** offsets R/B radially with safe direction at center.

### Motion Blur (Shutter Simulation)

24‑tap directional blur with jitter to emulate shake patterns. UI slider maps logarithmically to shutter time (1/250→0.5s), then converted to pixel extent. Params: `shutterUI`, `shake`, `motionAngle`. Utilities: `sliderToShutterSeconds`, `formatShutter`, `shutterToPixels`. 

### Handheld Camera

Multi‑octave Perlin noise creates drift + tremor. The shader composes rotation and translation; CPU builds offsets and scale to keep sampling in‑bounds. Params: `shakeHandheld`, `shakeStyle`, `shakeWobble`, `shakeJitter`. 

### Film Grain (AV1‑inspired)

Physically‑motivated grain synthesized per frame in **linear** space, then converted back to sRGB at output.
Features:

* Resolution‑normalized scale (relative to 1080p),
* ISO‑dependent intensity curve (piece‑wise linear LUT per luma),
* Autoregressive + gradient noise layers, optional chroma grain, Worley clumps in shadows,
* Dithering prior to write. Params: `filmSpeed`, `grainCharacter`, `grainChroma`.

---

## WebGL Context & Render Targets

* Context initialization requests WebGL2 with `preserveDrawingBuffer: true` (needed for `toBlob` snapshots) and falls back to WebGL1. Capabilities: float/half‑float render targets, linear filtering, and extensions are probed to determine internal formats. 
* `gl-context.js` centralizes `compileShader`, `bindProgram`, and FBO helpers (`createFramebuffer`, `ensureFramebuffer`). The `bindProgram` helper always injects `uRes` (canvas size) when present, so shaders can compute aspect‑aware transforms. 

---

## UI Contract & Pure UI

**Contract (`ui-api.js`).** This is the *only* file that knows both sides: application state & pure UI. It:

* Aggregates all module PARAMS into `ALL_PARAMS` and exposes `TAB_CONFIG` to the UI,
* Formats special values (e.g., shutter into `1/xxx s`),
* Owns **state getters/setters**, marking `needsRender` on change,
* Provides media loaders (`loadImage`, `loadVideo`), GL accessor, time‑based rendering helpers, and full‑resolution helpers for export. 

**Pure UI (`ui.js`).** Builds tabs and sliders from the API data, with:

* **File** tab (Open file, Play/Pause, Original toggle, View mode, Reset, Export),
* **Flash pad** to set a 2D flash center; UI reverses X to match the design.
* Pointer tracking supports drag‑to‑pan in 1:1 mode and interactive flash setting.

`TAB_CONFIG` groups effects into Exposure, Tone, Color, Bloom, Optics, Motion, Handheld, Grain, and File. Adding a module typically requires extending `ALL_PARAMS` and `TAB_CONFIG` here. 

---

## Media Ingest & Playback

`ui-api.loadImage` and `loadVideo` create/update the GL texture from the HTML image/video element and flip Y as needed (`UNPACK_FLIP_Y_WEBGL`). If `requestVideoFrameCallback` is available, it drives uploads on cadence; otherwise a `requestAnimationFrame` pump is used. Each upload increments `frameSeed` for grain. 

Controls (play/pause/original/view mode/reset) are pure UI, wired in `media.js`. Notably, on Electron, we persist the **source video filesystem path** (via `File.path`) for native export. 

---

## Export Pipelines

### A) Electron “native‑res” pipeline (recommended for video)

**User flow:** The main window calls `exportVideoStart(...)` via the preload‑exposed `electronAPI`. `main.js` opens a Save dialog and, if confirmed, sets up:

1. **Decoder** — FFmpeg spawns to read the source video and output raw RGBA frames at a sanitized even resolution `safeWidth×safeHeight` (H.264 friendly). Frames stream over `stdout`. 
2. **Headless renderer window** — hidden `export.html` with `renderer-export.js` initializes a GL pipeline identical to on‑screen, receives raw frames, runs the GPU stack, reads back processed pixels, and sends them back via IPC (transferable buffers). 
3. **Encoder** — FFmpeg spawns to accept RGBA rawvideo on `stdin` and encode `libx264`/`yuv420p` MP4 with `-preset medium -crf 18`. Progress is relayed to the main window UI. 

Key implementation details:

* **Even dimensions** are enforced for YUV 4:2:0 (`safeWidth/Height = floor(n/2)*2`). 
* Transfer of frames between processes uses transferable ArrayBuffers to avoid copies; preload exposes typed IPC channels for both UI and renderer windows. 
* The headless pipeline sets the correct viewport and reads pixels from the **default framebuffer** after film grain, ensuring the final sRGB result. 

### B) Web fallbacks

* **Single frame**: `canvas.toDataURL('image/webp')` (or `toBlob`) after forcing a *temporary* full‑resolution layout; then download. 
* **Frame sequence**: TAR of per‑frame WebP images assembled incrementally in `export-images.js` using `requestVideoFrameCallback`. The exporter yields to the event loop periodically to keep the page responsive and cancels if the tab backgrounds. 
* A worker‑based encoder (`frame-encoder.worker.js`) illustrates off‑main‑thread WebP encoding (also flips the image vertically prior to packing). 

---

## Color, Luminance & Numerical Stability

* **Linear vs sRGB.** Exposure is applied in linear color (`toLin` → EV → (still linear out of that stage)), while several modules work in texture (nominally sRGB) space. The **Film Grain** module explicitly converts to linear for luma and **converts back to sRGB** before writing to the default framebuffer, guaranteeing a visually consistent final output. When adding new modules, be explicit about color space and whether your stage expects/produces linear values.
* **Clamping and non‑negativity.** Bloom composite and clarity explicitly clamp to non‑negative values to avoid banding and invalid colors. Preserve these guards when modifying optics/clarity stages. 

---

## Performance Characteristics

* **GPU residency.** All heavy image ops are on GPU. The only GPU→CPU copy is during export (readPixels) or when making image files in web fallback. Bloom uses multi‑scale blurs with small kernels to balance cost. 
* **Backpressure & encoding.** In web frame‑sequence export, a rolling average and “frames in flight” gate reduce memory pressure; Electron’s native pipeline avoids WebP encoding entirely by piping raw frames to FFmpeg.
* **PreserveDrawingBuffer.** Enabled to support snapshotting (frame exports) reliably. 

---

## Security & Electron Preload

* **Context isolation** is enabled; `preload.js` exposes a minimal `electronAPI` surface for the main UI or the headless window, keeping IPC channels explicit and narrow. **Node integration is disabled** in windows. 

---

## How to Add a New Effect Module

1. **Create module:** `web/modules/my-effect.js`. Export:

   * `export const MY_EFFECT_PARAMS = { ... }` (min/max/step/default/label[, special]).
   * shaders + `export class MyEffectModule { createProgram(); apply(inputTex, outputFB, params, ...) }`.
2. **Integrate in app:** Import & instantiate in `app.js`. Insert it at the right place in the pipeline, using the `rtA/rtB` ping‑pong pattern and pass pixel sizes (`pxX = 1/W`, `pxY = 1/H`) as needed. 
3. **Expose to UI:** Add `MY_EFFECT_PARAMS` into `ALL_PARAMS` and put the param keys into an appropriate `TAB_CONFIG` entry in `ui-api.js`. The pure UI will auto‑render sliders for you. Optionally define formatter via `special`. 
4. **Headless export:** Import the module and place it in the same relative order inside `web/renderer-export.js`. Keep parity with the on‑screen pipeline so exports match previews. 
5. **Color space:** If the stage must operate in linear, convert in‑shader (`toLinear`/`toSRGB`) or ensure the upstream stage provides the expected space. See Film Grain for a complete pattern. 
6. **Stability:** Follow the optics/clarity examples for non‑negative clamping and avoid out‑of‑gamut excursions. 

---

## Parameter Reference

> **Note:** All defaults and ranges come from the exported `PARAMS` objects. Use `ui-api.js` to place them in tabs. 

### Exposure & Flash

| Key             | Default | Range     | Meaning                                           |   |
| --------------- | ------: | --------- | ------------------------------------------------- | - |
| `ev`            |   -0.04 | [-1, 0.5] | Exposure (EV), applied in linear.                 |   |
| `flashStrength` |    0.28 | [0, 2.0]  | Flash gain at center.                             |   |
| `flashFalloff`  |    6.72 | [0.5, 10] | Falloff exponent scale (inverse‑square behavior). |   |

### Tone

| Key         | Default | Range     | Meaning             |   |
| ----------- | ------: | --------- | ------------------- | - |
| `scurve`    |    0.00 | [0, 1]    | S‑curve strength.   |   |
| `blacks`    |   0.011 | [0, 0.15] | Black crush.        |   |
| `blackLift` |   0.048 | [0, 0.15] | Lifted blacks.      |   |
| `knee`      |   0.082 | [0, 0.25] | Highlight shoulder. |   |

### Split Toning & Cast

| Key             | Default | Range  | Meaning              |   |
| --------------- | ------: | ------ | -------------------- | - |
| `shadowCool`    |    0.00 | [0, 1] | Cool shadows.        |   |
| `highlightWarm` |    0.00 | [0, 1] | Warm highlights.     |   |
| `greenShadows`  |    0.16 | [0, 1] | Green in shadows.    |   |
| `magentaMids`   |    0.13 | [0, 1] | Magenta in midtones. |   |

### Bloom / Vignette / Optics

| Key              | Default | Range  | Meaning                           |   |
| ---------------- | ------: | ------ | --------------------------------- | - |
| `bloomThreshold` |   0.358 | [0, 1] | Bright extract threshold.         |   |
| `bloomRadius`    |    11.2 | > 0    | Blur radius scaler.               |   |
| `bloomIntensity` |    0.45 | [0, 1] | Bloom re‑add intensity.           |   |
| `bloomWarm`      |    0.00 | [0, 1] | Warmer bloom tone.                |   |
| `halation`       |    0.60 | [0, 1] | Red‑weighted glow add.            |   |
| `vignette`       |    0.00 | [0, 1] | Vignette strength.                |   |
| `vignettePower`  |    1.00 | ≥ 0    | Vignette curve power.             |   |
| `ca`             |    0.27 | [0, 1] | Chromatic aberration amount.      |   |
| `clarity`        |    0.00 | ≥ 0    | Unsharp‑mask strength with clamp. |   |

### Motion Blur

| Key                                                                  | Default | Range    | Meaning                        |
| -------------------------------------------------------------------- | ------: | -------- | ------------------------------ |
| `shutterUI`                                                          |    0.15 | [0, 1]   | Log‑mapped to shutter seconds. |
| `shake`                                                              |    0.50 | [0, 1]   | Jitter magnitude in blur taps. |
| `motionAngle`                                                        |      0° | [0, 180] | Blur direction.                |
| Utilities: slider↔seconds, display formatter, and pixel conversion.  |         |          |                                |

### Handheld Camera

| Key             | Default | Range  | Meaning                         |   |
| --------------- | ------: | ------ | ------------------------------- | - |
| `shakeHandheld` |    0.50 | [0, 1] | Overall intensity.              |   |
| `shakeStyle`    |    0.30 | [0, 1] | 0=calm/locked, 1=energetic/doc. |   |
| `shakeWobble`   |    0.60 | [0, 1] | Low‑freq drift.                 |   |
| `shakeJitter`   |    0.40 | [0, 1] | High‑freq tremor.               |   |

### Film Grain

| Key              | Default | Range       | Meaning                         |   |
| ---------------- | ------: | ----------- | ------------------------------- | - |
| `filmSpeed`      |     800 | [100, 3200] | ISO; sets intensity LUT.        |   |
| `grainCharacter` |    0.62 | [0, 1]      | AR vs gradient blend; clumping. |   |
| `grainChroma`    |    0.72 | [0, 1]      | Chroma grain mix.               |   |

---

## Known Behaviors & Gotchas

* **Flash center UI coordinate** flips X when mapping to shader space; see `setupFlashPad()`. If you set `flashCenterX/Y` programmatically, ensure the intended mapping. 
* **Background tab exports** (web fallback) can be cancelled to avoid long stalls when the page is hidden. 
* **H.264 even dimensions** are enforced in Electron export—do not remove, or encoding will fail for odd sizes. 

---

## Appendix: Render Loop (on‑screen)

Pseudocode adapted from `app.js`:

```js
exposureFlash.applyExposure(tex, rtA, ev);
let current = rtA.tex;

if (isVideo && shakeHandheld > eps) {
  handheld.apply(current, rtB, state, frameSeed);
  current = (current === rtA.tex) ? rtB.tex : rtA.tex;
}

const sh = sliderToShutterSeconds(shutterUI);
const motionAmt = shutterToPixels(sh, shake);
if (motionAmt > 0.05) {
  motionBlur.apply(current, nextRT, { amount: motionAmt, angle: motionAngle, shake }, pxX, pxY);
  current = nextRT.tex;
}

exposureFlash.applyFlash(current, nextRT, { centerX, centerY, strength, falloff });
current = nextRT.tex;

// Bloom chain
bloom.extract(current, brightRT, threshold, radius, warm);
downsample/blur: H → Q → E;
upsampleAdd: E→Q→H→bright→rtBloom;

// Tone & color
tone.apply(current, nextRT, { scurve, blacks, knee, blackLift });
split.applySplit(...); split.applyCast(...);

// Optics & finish
vignette.apply(...);
compositeBloom(base, rtBloom.tex, ...);
clarity.apply if needed;
chromaticAberration.apply(...);

// Final write
filmGrain.apply(/* writes to default framebuffer */);
```



---

## Appendix: Electron Export Sequence

1. `export.js` calls `electronAPI.exportVideoStart({inputPath, width, height, fps, duration, params})`.
2. `main.js` opens Save dialog, sanitizes dimensions to even, spawns **decoder** and **encoder**, and launches hidden `export.html`.
3. When `renderer-export.js` is ready (`export-renderer-ready`), the main process streams frames: decoder `stdout.read(...)` → `export-frame-data` → renderer → GPU pipeline → `gl.readPixels` → `export-frame-result` → encoder `stdin.write(...)`.
4. On completion, close encoder `stdin`, resolve; emit progress events during the process. 

---

## Closing Notes

The codebase is intentionally small, explicit, and modular. New contributors should start with:

1. Reading `web/readme.md` for intent,
2. Skimming `app.js` to see pipeline ordering,
3. Mapping UI controls in `ui-api.js` to their modules,
4. Running Electron export once to observe the headless pipeline.

If you keep **color space**, **ping‑pong discipline**, and **Electron IPC boundaries** in mind, extending or refactoring Disposable Night is straightforward.

---

**References (in‑repo code):**

* Overall philosophy & goals: `web/readme.md`. 
* Web shell: `web/index.html`, `web/styles.css`.
* GL setup & helpers: `web/gl-context.js`. 
* Main app loop: `web/app.js`. 
* Modules: Exposure/Flash, Tone, Split Cast, Bloom/Vignette/Optics, Motion Blur, Handheld Camera, Film Grain.
* UI contract: `web/ui-api.js` (tabs, params, loaders, helpers). 
* Pure UI: `web/ui.js`. 
* Media controls: `web/media.js`. 
* Export controller: `web/export.js`. 
* Electron preload and main: `preload.js`, `main.js`. 
* Headless renderer: `web/export.html`, `web/renderer-export.js`. 
* Web fallbacks & worker: `web/export-images.js`, `web/export-video.js`, `web/frame-encoder.worker.js`.

---

*End of document.*