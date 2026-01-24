# NITRATE - Spike 1: Native Host

## Overview

This implements the "Native Owns, wgpu Borrows" architecture for Phase 1.

## Structure

```
nitrate/
├── Cargo.toml                 # Workspace config
└── crates/
    ├── nitrate-pal/           # Platform Abstraction Layer
    │   ├── src/
    │   │   ├── lib.rs         # Main exports
    │   │   ├── error.rs       # Error types
    │   │   ├── sync.rs        # Sync tiers (A/B/C)
    │   │   ├── surface.rs     # Video surface types
    │   │   └── vulkan/
    │   │       ├── mod.rs
    │   │       ├── instance.rs   # VkInstance + validation
    │   │       ├── device.rs     # VkDevice + queue selection
    │   │       ├── swapchain.rs  # Native swapchain
    │   │       ├── bridge.rs     # wgpu HAL wrapper
    │   │       ├── extensions.rs # Extension helpers
    │   │       └── queues.rs     # Queue family selection
    │   └── tests/
    │       └── vulkan_tests.rs
    │
    └── nitrate-app/
        ├── src/
        │   ├── main.rs        # Placeholder main
        │   └── bin/
        │       └── spike1.rs  # Spike 1 test binary
        └── Cargo.toml
```

## Running

```bash
# Build and run spike1
cargo run --bin spike1

# With validation layers
RUST_LOG=spike1=debug,nitrate_pal=debug,vulkan=debug cargo run --bin spike1

# Run tests
cargo test --package nitrate-pal
```

## Pass Criteria

1. ✅ Orange screen (#e07030) appears
2. ✅ Zero Vulkan validation errors
3. ✅ wgpu device created from native handles
4. ✅ Sync tier detected (TierA if timeline semaphores available)

## Architecture Validated

- Native ash::Instance created with validation layers
- Native ash::Device with required extensions:
  - VK_KHR_swapchain
  - VK_KHR_timeline_semaphore (optional, enables TierA)
  - VK_KHR_external_memory_fd (optional, enables TierB)
- wgpu Device/Queue wrapped via HAL from existing handles
- Native swapchain with proper synchronization
- Frame sync: semaphores + fences per frame-in-flight

## Key Files

| File | Purpose | Tokens |
|------|---------|--------|
| `vulkan/instance.rs` | VkInstance + debug callback | ~400 |
| `vulkan/device.rs` | Physical device selection + logical device | ~450 |
| `vulkan/swapchain.rs` | Native swapchain management | ~500 |
| `vulkan/bridge.rs` | wgpu HAL wrapping | ~300 |
| `spike1.rs` | Test harness | ~450 |

All files stay under the 2000 token limit.

## Next Steps

After spike1 passes:
1. **Spike 2**: DMA-BUF roundtrip (export VkImage → import wgpu)
2. **Spike 3**: Command stealing (extract VkCommandBuffer from wgpu)
3. **Spike 4**: Timeline sync validation
