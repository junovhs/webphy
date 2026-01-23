# NITRATE — Volatile Memory

Physics-based film simulation engine.

## Philosophy

We don't just overlay filters. We simulate:
- Random distribution of silver halide crystals in emulsion
- Light bouncing off the pressure plate (halation)
- Proper colorimetric transforms in linear space

## Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable)
- GPU with Vulkan, Metal, or DX12 support

## Run

```bash
cargo run
```

For release build (optimized):
```bash
cargo run --release
```

## Project Structure

```
src/
├── main.rs          # Entry point
├── engine/          # WGPU rendering core
│   ├── mod.rs       # Window + event loop
│   ├── context.rs   # GPU device, queue, surface
│   └── render.rs    # Frame drawing
├── passes/          # Filter pipeline stages (Phase 3-4)
├── shaders/         # WGSL shader sources (Phase 3)
└── ui/              # Dioxus interface (Phase 5)
```

## Development Phases

- [x] Phase 1: Proof of Life (window + WGPU clear)
- [ ] Phase 2: Engine Core (texture loading, passthrough)
- [ ] Phase 3: Shader Laboratory (WGSL ports)
- [ ] Phase 4: Filter Chain (full pipeline)
- [ ] Phase 5: UI Integration (Dioxus controls)
- [ ] Phase 6: File I/O (import/export)
- [ ] Phase 7: Polish
- [ ] Phase 8: Web Demo (optional)

## License

Proprietary. All rights reserved.
