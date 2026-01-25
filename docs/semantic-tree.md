# Semantic Tree — NITRATE

**Usage:** This document maps the file structure to architectural intent. Use it to locate specific logic, structs, or configurations without traversing the entire codebase.

├─ Cargo.toml
│  Defines the workspace hierarchy and shared dependency versions (wgpu, ash, tokio).
│  Controls build profiles (LTO, codegen-units) for release performance. Modify this
│  file to add new workspace members or update critical graphics dependencies across
│  all crates simultaneously.
│
├─ slopchop.toml
│  Strict quality control configuration. Enforces limits on cyclomatic complexity, function
│  length, and token counts. Defines the "safety comment" requirement for unsafe blocks.
│  Consult this configuration before generating code to ensure compliance with the project's
│  static analysis gates and linter rules.
│
├─ README.md
│  Project entry point. Contains CLI commands for running spikes (`cargo run --bin spike1`),
│  enabling validation layers, and running tests. Lists pass criteria for the current phase
│  and provides a high-level token count overview of key files to track complexity.
│
├─ crates/
│  ├─ nitrate-app/
│  │  ├─ Cargo.toml
│  │  │  Manifest for the application layer. Dependencies include the internal `nitrate-pal`
│  │  │  and external windowing/graphics crates (`winit`, `wgpu`, `ash`). Defines the binaries
│  │  │  `nitrate` (main app) and `spike1` (architecture validation harness).
│  │  │
│  │  └─ src/
│  │     ├─ app.rs
│  │     │  Encapsulates the Winit application lifecycle. Manages the `AppSession`, window
│  │     │  creation via `ActiveEventLoop`, and event handling (resize, redraw). acts as the
│  │     │  bridge between the operating system's window manager and the internal GPU state.
│  │     │
│  │     ├─ bin/
│  │     │  └─ spike1.rs
│  │     │     **Critical Validation Harness.** The executable for Spike 1. Implements the
│  │     │     full "Native Host" flow: creates `VulkanDevice`, bridges to `WgpuBridge`,
│  │     │     acquires native swapchain images, performs a WGPU clear pass, and submits
│  │     │     via native queues.
│  │     │
│  │     ├─ gpu.rs
│  │     │  Standard WGPU initialization helper. Used by the generic `app.rs` for default
│  │     │  setup. Creates `Surface`, `Adapter`, and `Device` using pure WGPU APIs. Note:
│  │     │  This is distinct from the hybrid bridge used in the spikes; use this for reference.
│  │     │
│  │     └─ main.rs
│  │        Placeholder entry point. Currently directs the developer to run `spike1` for
│  │        architecture validation. Will eventually bootstrap the full `NitrateApp` defined
│  │        in `app.rs` once Phase 1 spikes are complete.
│  │
│  ├─ nitrate-color/
│  │  ├─ Cargo.toml
│  │  │  Dependencies for color science. minimal, relying primarily on `nitrate-core` and
│  │  │  `bytemuck` for uniform buffer data casting.
│  │  │
│  │  └─ src/
│  │     └─ lib.rs
│  │        Color mathematics and GPU uniforms. Defines `YuvMatrix` constants (BT.709, BT.2020),
│  │        `TransferFunctionId` (PQ, HLG), and the `ColorUniforms` struct layout (std140).
│  │        Essential for correctly mapping video YUV and linear UI into the display color space.
│  │
│  ├─ nitrate-compositor/
│  │  ├─ Cargo.toml
│  │  │  Manifest for the composition engine. Links `nitrate-color`, `nitrate-pal`, and `wgpu`.
│  │  │
│  │  └─ src/
│  │     └─ lib.rs
│  │        Stub for the final render pipeline. Defines `ComposePipeline` (shader loading,
│  │        binding generation) and `FramePacer` (software CPU wait). Will eventually coordinate
│  │        the blending of decoded video surfaces with the Vello UI texture in linear light.
│  │
│  ├─ nitrate-core/
│  │  ├─ Cargo.toml
│  │  │  Base dependencies (`thiserror`, `arrayvec`, `bitflags`).
│  │  │
│  │  └─ src/
│  │     └─ lib.rs
│  │        Foundational types used globally. Defines `FrameId` (monotonic tracking), `Extent2D`
│  │        (geometry), `PixelFormat` (NV12, P010 plane counts), and `Error` types. All
│  │        subsystems rely on these primitives to ensure type safety across crate boundaries.
│  │
│  ├─ nitrate-decode/
│  │  ├─ Cargo.toml
│  │  │  Manifest for hardware decoding. Will eventually include `ffmpeg-next` or VA-API bindings.
│  │  │
│  │  └─ src/
│  │     └─ lib.rs
│  │        Interfaces for video decoding. Defines the `Decoder` trait, `DecodedFrame` struct
│  │        (timestamp, duration, surface), and a placeholder `FramePool`. This layer handles
│  │        the abstraction over OS-specific decoders (VA-API, MediaFoundation, VideoToolbox).
│  │
│  ├─ nitrate-pal/
│  │  ├─ Cargo.toml
│  │  │  Platform Abstraction Layer dependencies. Heavy usage of `ash` (Vulkan), `wgpu` (HAL),
│  │  │  and `raw-window-handle`. Defines features like "vulkan" to conditionally compile backends.
│  │  │
│  │  ├─ src/
│  │  │  ├─ error.rs
│  │  │  │  Centralized error handling. Defines `PalError` (Platform Abstraction Layer) and
│  │  │  │  `VulkanError`. Maps raw `ash::vk::Result` codes to semantic application errors
│  │  │  │  (e.g., `DeviceCreation`, `Swapchain`).
│  │  │  │
│  │  │  ├─ lib.rs
│  │  │  │  Crate root. Re-exports the primary public API: `VulkanDevice`, `PresentationEngine`,
│  │  │  │  `ImportedSurface`, and `SyncTier`. Configures module visibility based on active
│  │  │  │  features (e.g., exposing `vulkan` module).
│  │  │  │
│  │  │  ├─ surface.rs
│  │  │  │  Data structures for video interop. Defines `ImportedSurface`, `PlaneDescriptor`,
│  │  │  │  and `ColorMetadata`. Contains the `SurfaceHandle` enum (DMA-BUF, SharedHandle) used
│  │  │  │  to pass memory pointers from the decoder to the renderer zero-copy.
│  │  │  │
│  │  │  ├─ sync.rs
│  │  │  │  Defines synchronization strategies. `SyncTier` enum (A=Timeline, B=Resource, C=CPU)
│  │  │  │  and `SyncHandle` allow the engine to adapt its synchronization logic based on driver
│  │  │  │  capabilities detected at runtime.
│  │  │  │
│  │  │  └─ vulkan/
│  │  │     ├─ bridge.rs
│  │  │     │  **Core Architecture Component.** The "Unsafe" Bridge. Implements the logic to
│  │  │     │  wrap raw `ash::Instance` and `ash::Device` handles into `wgpu::Instance` and
│  │  │     │  `wgpu::Device` via `wgpu::hal::api::Vulkan`. This enables the "Native Owns,
│  │  │     │  WGPU Borrows" model.
│  │  │     │
│  │  │     ├─ capabilities.rs
│  │  │     │  Runtime feature detection. Checks available extensions (e.g., `timeline_semaphore`,
│  │  │     │  `external_memory_fd`) against required lists. Determines the active `SyncTier`
│  │  │     │  and populates the `DeviceCapabilities` struct.
│  │  │     │
│  │  │     ├─ device.rs
│  │  │     │  Logical device creation. Selects the physical device, creates the `ash::Device`,
│  │  │     │  and initializes `DeviceQueues`. Orchestrates the connection between the Instance,
│  │  │     │  Surface, and the creation of the WGPU bridge.
│  │  │     │
│  │  │     ├─ extensions.rs
│  │  │     │  Utilities for string manipulation and extension filtering. Helper functions like
│  │  │     │  `filter_supported` and `check_required` handle the C-String interoperability
│  │  │     │  required by the Vulkan API.
│  │  │     │
│  │  │     ├─ helpers.rs
│  │  │     │  Legacy/internal helpers for instance and device creation. Contains boilerplate
│  │  │     │  for physical device selection and queue family searching. mostly superseded by
│  │  │     │  specific modules but kept for internal utility.
│  │  │     │
│  │  │     ├─ instance.rs
│  │  │     │  Vulkan Instance lifecycle. Manages `ash::Entry` loading, instance creation,
│  │  │     │  application info, and critically, the `DebugUtilsMessenger` for validation layer
│  │  │     │  callbacks during development.
│  │  │     │
│  │  │     ├─ mod.rs
│  │  │     │  Vulkan module root. Exports `VulkanDevice`, `VulkanInstance`, `WgpuBridge`
│  │  │     │  and the `PresentationEngine`. Defines constants for required/optional extensions.
│  │  │     │
│  │  │     ├─ presentation/
│  │  │     │  ├─ engine.rs
│  │  │     │  │  **Primary Rendering Controller.** Replaces legacy swapchain. Orchestrates
│  │  │     │  │  `SwapchainHandle`, `ImageChain`, and `FramePacer`. Exposes the high-level
│  │  │     │  │  `acquire()` and `present()` API used by the application loop.
│  │  │     │  │
│  │  │     │  ├─ handle.rs
│  │  │     │  │  Low-level `SwapchainKHR` wrapper. Handles surface capability queries, format
│  │  │     │  │  selection (forcing SRGB/B8G8R8A8), extent clamping, and the actual creation
│  │  │     │  │  of the swapchain object via the KHR extension.
│  │  │     │  │
│  │  │     │  ├─ images.rs
│  │  │     │  │  Swapchain image management. Retrieves `vk::Image` handles from the swapchain
│  │  │     │  │  and creates corresponding `vk::ImageView` objects. Manages the lifecycle and
│  │  │     │  │  cleanup of these views.
│  │  │     │  │
│  │  │     │  ├─ mod.rs
│  │  │     │  │  Presentation module facade. Re-exports `PresentationEngine`, `AcquiredFrame`,
│  │  │     │  │  and `PresentationConfig`. Serves as the public interface for this subsystem.
│  │  │     │  │
│  │  │     │  ├─ sync.rs
│  │  │     │  │  Frame pacing logic (Triple Buffering). Creates and recycles `SyncFrame` structs,
│  │  │     │  │  which contain the `Ready`/`Done` semaphores and the `InFlight` fence. Ensures
│  │  │     │  │  CPU doesn't overrun the GPU.
│  │  │     │  │
│  │  │     │  └─ types.rs
│  │  │     │     Data structures for presentation. Defines `PresentationConfig` (creation params)
│  │  │     │     and `AcquiredFrame` (the bundle of image + sync primitives returned to the app).
│  │  │     │
│  │  │     └─ queues.rs
│  │  │        Queue family logic. Implements `find_queue_families` to locate Graphics and Present
│  │  │        queues. Handles logic for both unified (shared) and distinct queue families.
│  │  │
│  │  └─ tests/
│  │     └─ vulkan_tests.rs
│  │        Integration tests for PAL. Verifies sync tier descriptions, color metadata defaults,
│  │        and checks simple assertions about backend capability logic.
│  │
│  └─ nitrate-ui/
│     ├─ Cargo.toml
│     │  Manifest for the UI crate. Dependencies include `vello` (for 2D rendering) and `wgpu`.
│     │
│     └─ src/
│        └─ lib.rs
│           Placeholder for Vello integration. Will handle the construction of the scene graph
│           and the rasterization of the UI into a texture that the compositor can ingest.
│
├─ docs/
│  ├─ SPECIFICATION.md
│  │  **Architectural Source of Truth.** Defines the ownership hierarchy ("Native Owns"), the
│  │  Synchronziation Tiers (A/B/C), and the data flow for the composition pipeline. Consult
│  │  this for authoritative answers on design constraints.
│  │
│  ├─ mutants-results.md
│  │  Audit log of mutation testing. Highlights code paths (especially in `queues.rs` and `sync.rs`)
│  │  where tests failed to catch logic inversions or off-by-one errors. Use to guide test improvements.
│  │
│  ├─ roadmap.md
│  │  Strategic timeline. Details the Six Phases of development and the granular tasks for
│  │  Spikes 1-4. Defines exit criteria for Phase 1 (The Bridge).
│  │
│  └─ todo.md
│     Task tracker. Currently focused on executing Spike 2 (DMA-BUF Roundtrip) and validating
│     Spike 1. Use this to find the next immediate coding task.
│
└─ reference/
   └─ ui-design.css
      Visual style guide. CSS reference for the "Volatile Memory" aesthetic. Defines color
      palettes (`#e07030`), fonts, and layout rules for the eventual Vello implementation.
