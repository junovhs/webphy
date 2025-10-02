# Disposable Night: A Cinematic Film Emulation Tool

You're building a web-based video/image processor that authentically replicates the aesthetic of **disposable camera photography and handheld cinematography** - specifically targeting that gritty, nostalgic, "shot on a drugstore camera in the 90s/2000s" look.

## Core Philosophy

This isn't just another Instagram filter app. You're going deep on the **actual physics and optics** of how cheap film cameras worked:

- **Film grain** modeled as an autoregressive process with luminance-dependent density modulation (not just overlaying static noise)
- **Handheld shake** using multi-frequency Perlin noise layers mimicking real human hand tremor, breathing, and drift (not sine wave garbage)
- **Optical aberrations** like chromatic aberration, vignetting, bloom, and halation that come from plastic lenses and chemical film processes
- **Flash falloff** with proper inverse-square law physics
- **Color shifts** (green shadows, magenta mids) that happen from expired/cheap film stock

## Design Principles

**Modular architecture**: Each effect lives in its own self-contained module (`/modules/*.js`) with:
- WebGL shaders for GPU-accelerated processing
- Parameter definitions that auto-generate UI sliders
- No hardcoding in app.js - modules plug in automatically

**High-level creative controls**: Users shouldn't need to understand AR coefficients or frequency bands. Instead of 12 technical sliders, you want 3-4 **macro controls** that intelligently manage the complexity underneath. Think "Character" instead of "AR lag parameter".

**Scientifically accurate but artistically useful**: The grain synthesis uses research from Netflix/Google's AV1 codec development. The handheld motion follows cinematography best practices. But it's tuned for creative work, not academic correctness - if something looks better slightly wrong, that wins.

## The End Goal

Someone uploads a crisp digital video and it comes out looking like it was **actually shot on a disposable camera** - the kind you'd buy at CVS for $12, with a little cardboard wheel you advance manually. Grainy, slightly blown out from the harsh flash, wobbling from handheld shooting, with that characteristic greenish-magenta color cast of cheap film.

The result should be so convincing that **nobody questions it** - it just looks like authentic vintage footage, not a digital effect applied to clean video. That's the bar: indistinguishable from the real thing.