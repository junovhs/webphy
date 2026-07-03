# Nitrate refactor notes

## What changed

- Added `web/render-pipeline.js` as the shared preview/export render path. The on-screen renderer and the hidden export renderer now use the same effect ordering and the same bypass logic.
- Added `web/params.js` as the single parameter registry for defaults, tab grouping, and option formatting.
- Reworked `web/modules/film-grain.js` into a grain-studio module with a true `grainAmount` bypass and flexible grain controls:
  - Grain Amount
  - Texture ISO
  - Grain Size
  - Prickliness
  - Organic Texture
  - Color Grain
  - Shadow Bias
  - Highlight Protect
  - Noise Recipe: Organic, Fine Gaussian, Clumped, Prickly
  - Animate Stills
  - Grain FPS
- Added select controls to the generated UI for enumerated parameters.
- Made reset/default settings visually neutral. When no real effect amount is active, the render pipeline copies the source texture directly instead of doing an sRGB -> linear -> sRGB round trip.
- Optimized disabled effects by skipping entire passes such as bloom, flash, chromatic aberration, clarity, motion blur, handheld shake, and grain when their amount controls are zero.
- Fixed render-target viewport handling in `bindProgram()` and bloom pyramid passes, which is important for correct downsample/blur work.
- Restored functional single-frame and web fallback exports through the UI API.

## Neutral baseline contract

The default/reset state is clean. Grain is not keyed off ISO alone anymore; `grainAmount` is the master enable. Other grain controls can be adjusted freely without changing the image until `grainAmount` is above zero.

Some non-strength controls still have nonzero defaults because they only shape an enabled effect:

- `filmSpeed`
- `grainSize`
- `grainPrickliness`
- `grainCharacter`
- `grainShadowBias`
- `grainHighlightProtect`
- `grainFps`
- `bloomThreshold`
- `bloomRadius`
- `flashFalloff`
- `vignettePower`

## Still-image animated grain preview

For still images, `Animate Stills` plus `Grain Amount > 0` advances the grain seed at `Grain FPS`. This previews the same kind of temporal grain behavior you would see on video without requiring a video source.

For video export, the seed advances per exported frame for deterministic frame-to-frame animated grain.
