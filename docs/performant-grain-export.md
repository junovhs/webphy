# Performant Grain Export

Nitrate now has two grain modes in the Grain Studio tab.

## Baked Grain

Baked Grain renders grain into the video pixels. It is portable to every normal video player, but it can make exports much larger because the encoder has to preserve random high-frequency detail.

## Performant Grain

Performant Grain previews a low-cost overlay. During video export, Nitrate exports the graded/tonal video without this overlay grain, then writes a small drop-in kit beside the MP4:

- `*.grain-texture.png` - a transparent signed black/white grain tile
- `*.grain.css` - CSS for the overlay animation
- `*.grain.dioxus.rs` - a Dioxus example component
- `*.grain.json` - the exported grain settings

The CSS uses ordinary alpha compositing, not WebGL/canvas and not blend modes. The PNG contains transparent black and white speckles, so the overlay can lighten and darken locally without pushing the whole hero toward flat gray.

## Intended use

Use the exported MP4 as the hero video source in your app. Copy the generated CSS and PNG into your asset bundle. Wrap the video in a relative container and put the overlay div above it:

```html
<div class="nitrate-grain-host">
  <video class="nitrate-grain-video" autoplay muted loop playsinline src="hero.mp4"></video>
  <div class="nitrate-grain-overlay" aria-hidden="true"></div>
</div>
```

The exported Dioxus file contains the same structure in Rust component form.

## Controls

- Overlay Amount: master strength. Zero is a true bypass.
- Texture Scale: larger values make coarser visible grain.
- Texture Contrast: makes individual grain flecks stronger.
- Prickliness: makes the texture sharper, saltier, and more point-like.
- Softness: reduces harsh one-pixel sparkle.
- Motion Jitter: controls how far the repeated texture hops each animation step.
- Animation FPS: controls the CSS stepped animation cadence.
- Texture Resolution: chooses the generated PNG tile size.
