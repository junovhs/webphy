# ⚡ CURRENT FOCUS: SPIKE 1 (Native Host)

**Objective:** Get a window open, create a Vulkan device natively, wrap it in wgpu, and clear the screen.

- [ ] **Step 0: Project Scaffold**
    - [ ] Initialize workspace `Cargo.toml`
    - [ ] Create `crates/nitrate-pal`
    - [ ] Create `crates/nitrate-app`
    - [ ] Add dependencies (`ash`, `wgpu`, `winit`, `raw-window-handle`)

- [ ] **Step 1: Native Vulkan Device**
    - [ ] Implement `nitrate-pal/src/vulkan/device.rs` -> `create_vulkan_device()`
    - [ ] Ensure required extensions (`VK_KHR_external_memory_fd`, `VK_KHR_timeline_semaphore`) are enabled.

- [ ] **Step 2: The WGPU Wrapper (The "Unsafe" Bridge)**
    - [ ] Implement `nitrate-pal/src/vulkan/bridge.rs`
    - [ ] Function `unsafe fn create_wgpu_device(ash_instance, ash_device) -> wgpu::Device`
    - [ ] Use `wgpu::hal::api::Vulkan` to wrap the raw handles.

- [ ] **Step 3: The Swapchain**
    - [ ] Implement `nitrate-pal/src/vulkan/swapchain.rs` using `ash-window`.
    - [ ] Needs `acquire_next_image` and `present` methods.

- [ ] **Step 4: The Binary (`spike1.rs`)**
    - [ ] Wire it all together: Window -> Device -> Bridge -> Swapchain -> Wgpu Clear Pass -> Present.

## Phase 1: Prove the Bridge

**Spike 1: Native Host**
- [ ] `swapchain.rs` — native ash swapchain creation, image acquisition, present
- [ ] `spike1.rs` — binary that uses VulkanDevice + WgpuBridge + native swapchain
- [ ] validate — run with VK_LAYER_KHRONOS_validation, fix all errors

**Spike 2: DMA-BUF Roundtrip**
- [ ] `export.rs` — allocate VkImage with exportable memory, return DMA-BUF fd
- [ ] `import.rs` — import fd into wgpu as texture, create sampler
- [ ] `spike2.rs` — render test pattern to exported texture, sample in wgpu shader

**Spike 3: Command Stealing**
- [ ] `submit.rs` — extract VkCommandBuffer from wgpu encoder via HAL
- [ ] `spike3.rs` — record wgpu pass, steal cmd, submit via vkQueueSubmit with semaphores

**Spike 4: Timeline Sync**
- [ ] `timeline.rs` — create/signal/wait timeline semaphores via ash
- [ ] `spike4.rs` — producer signals N, consumer waits N, verify zero CPU blocking

---

## Phase 2: Video Pipeline

- [ ] VA-API decoder — wrap libva, decode H.264/HEVC to DMA-BUF surfaces
- [ ] frame pool — fixed 8-slot ring with atomic fence tracking, backpressure
- [ ] demuxer — basic mp4/mkv container parsing, feed NAL units to decoder
- [ ] playback loop — decode → import → composite → present at correct PTS

---

## Phase 3: Color Pipeline

- [ ] `compose.wgsl` — uber-shader: YUV→RGB, EOTF, tonemap, blend, OETF
- [ ] color uniforms — GPU buffer with matrix, transfer fn, tonemap params
- [ ] HDR support — PQ/HLG decode, BT.2390 tone mapping to SDR

---

## Phase 4: UI System

- [ ] Vello integration — render scene to wgpu texture
- [ ] layout engine — Taffy for flexbox, style structs from reference CSS
- [ ] widgets — sliders, buttons, transport controls
- [ ] sidebar + viewport — match `ui-design.css` aesthetic

---

## Phase 5: Film Simulation

- [ ] halation — bloom around highlights, color fringing
- [ ] grain — temporal + spatial noise, film stock profiles
- [ ] color response — per-stock curves (Portra, Ektar, Cinestill)
- [ ] gate weave — optional subtle position jitter for vintage look

---

## Phase 6: Polish & Ship

- [ ] 8K validation — 60fps sustained, <100MB CPU memory
- [ ] Windows port — Media Foundation decode, D3D12 sync
- [ ] macOS port — VideoToolbox decode, Metal shared events
- [ ] packaging — installers, error recovery, user docs
