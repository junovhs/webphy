# NITRATE — Volatile Memory

Physics-based film simulation engine.

## Philosophy

We don't just overlay filters. We simulate:
- Random distribution of silver halide crystals in emulsion
- Light bouncing off the pressure plate (halation)
- Proper colorimetric transforms in linear space

## Stack

- **UI**: Dioxus (Rust → HTML/CSS in webview)
- **GPU**: WebGPU via wgpu (coming Phase 2)
- **Platform**: Desktop-first, web demo later

## Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable)

## Run

```bash
cargo run
```

Release build:
```bash
cargo run --release
```

## Project Structure

```
src/
├── main.rs         # Entry, Dioxus launch + config
└── ui/
    ├── mod.rs      # UI module exports
    ├── sidebar.rs  # Controls panel
    └── viewport.rs # Image canvas area

assets/
└── css/
    └── main.css    # Dark film aesthetic
```

## Development Phases

- [x] Phase 1: Proof of Life (Dioxus shell + layout)
- [ ] Phase 2: Engine Core (WebGPU canvas, texture loading)
- [ ] Phase 3: Shader Laboratory (WGSL ports)
- [ ] Phase 4: Filter Chain (full pipeline)
- [ ] Phase 5: UI Integration (signals → uniforms)
- [ ] Phase 6: File I/O (import/export)
- [ ] Phase 7: Polish
