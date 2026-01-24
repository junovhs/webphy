# NITRATE — Volatile Memory

Physics-based film simulation engine with native GPU rendering.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    NATIVE LAYER (owns resources)            │
│  • Video decoder surfaces (VA-API / MF / VideoToolbox)      │
│  • UI render target (exportable to wgpu)                    │
│  • Timeline semaphores for GPU-GPU sync                     │
└─────────────────────────────────────────────────────────────┘
                             │
                   Import handles + sync
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    WGPU LAYER (borrows)                     │
│  • Vello renders UI to imported render target               │
│  • Composition shader samples video + UI                    │
└─────────────────────────────────────────────────────────────┘
```

## Crates

| Crate | Purpose |
|-------|---------|
| `nitrate-core` | Shared types, error handling |
| `nitrate-pal` | Platform abstraction (Vulkan/D3D12/Metal) |
| `nitrate-color` | Color space transforms, tone mapping |
| `nitrate-decode` | Hardware video decoding |
| `nitrate-ui` | Vello-based UI rendering |
| `nitrate-compositor` | Video + UI composition |
| `nitrate-app` | Application framework |

## Sync Tiers

Not all platforms support the same level of GPU-GPU synchronization:

- **Tier A**: Timeline semaphores (Vulkan 1.2, D3D12 fences, Metal shared events)
- **Tier B**: Binary sync with explicit sync_file import  
- **Tier C**: CPU coordination (fallback)

## Building

```bash
cargo build --release
```

## Running

```bash
cargo run -p nitrate-app
```

## Reference

The `reference/` directory contains the UI design to be recreated in Vello:
- `ui-design.css` - Original CSS from Dioxus mockup

## Performance Targets

- 4K 24fps playback minimum
- 8K with buffering acceptable
- Zero-copy decode → render pipeline
- Linear-space HDR compositing

## Platforms

| Platform | Decode | Sync | Status |
|----------|--------|------|--------|
| Linux | VA-API | Timeline Semaphores | In Progress |
| Windows | Media Foundation | D3D12 Fences | Planned |
| macOS | VideoToolbox | MTLSharedEvent | Planned |
