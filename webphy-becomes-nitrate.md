# Project Migration Plan: Webphy → NITRATE

**Status:** Architecture Pivot & Rebrand
**Date:** 1/23/2026
**Source:** `disposable-night` (Electron/WebGL/JS)
**Target:** `nitrate` (Rust/Dioxus/WGPU)
**Identity:** Scientific, volatile, high-fidelity film simulation.
**Tagline:** *"Volatile Memory."*

---

## 1. The Philosophy
We are moving from a "filter app" to a **Physics Simulation Engine**.
*   **Scientific Rigor:** We do not just overlay noise. We simulate the random distribution of silver halide crystals in an emulsion layer.
*   **Physical Light:** We model halation as light bouncing off the pressure plate back into the red channel.
*   **Dual Nature:**
    *   **Web (WASM):** A high-performance, sandboxed demo. Running at 60FPS in the browser to show off the engine.
    *   **Desktop (Native):** The "Pro" tool. Unshackled access to the file system and system-level FFmpeg for rendering ProRes/DNxHR.

---

## 2. The Stack

*   **Language:** Rust (for safety and math performance).
*   **UI Framework:** Dioxus (React-like UI logic, renders to DOM/WebView).
*   **Graphics Backend:** `wgpu` (Cross-platform graphics: Vulkan/Metal/DX12/WebGL2).
*   **Shading Language:** WGSL (WebGPU Shading Language).
*   **Math:** `glam` (Standard graphic vector math).

---

## 3. Dependency Specification (`Cargo.toml`)

Update the template `Cargo.toml` to include the physics and graphics engine components.

```toml
[package]
name = "nitrate"
version = "0.1.0"
edition = "2021"

[dependencies]
# UI & Async Runtime
dioxus = { version = "0.6", features = ["desktop", "web", "router"] }
tokio = { version = "1", features = ["full"] }
tracing = "0.1"
tracing-wasm = "0.2"

# The Engine (Graphics & Math)
wgpu = "0.19"
bytemuck = { version = "1.14", features = ["derive"] } # Memory mapping
glam = "0.25" # Vec2, Vec3, Mat4
image = "0.24" # CPU-side image processing

# Utilities
anyhow = "1.0"
serde = { version = "1.0", features = ["derive"] }
rand = "0.8" # For seeding grain generators

# Desktop-Only Dependencies (The "Pro" Features)
[target.'cfg(not(target_arch = "wasm32"))'.dependencies]
rfd = "0.12" # Native File Dialogs
```

---

## 4. Architecture Map

We are converting loose JS modules into strict Rust structs.

| Webphy (JS) | Nitrate (Rust) | Responsibility |
| :--- | :--- | :--- |
| `app.js` (Loop) | `impl ApplicationHandler for NitrateApp` | Manages the window and render loop. |
| `gl-context.js` | `struct Engine` | Holds the WGPU Device, Queue, and Surface. |
| `web/modules/*.js` | `struct FilterPass` | Represents one stage of the pipeline (e.g., Bloom). |
| Uniforms (`uTime`) | `struct GlobalUniforms` | Data sent to shaders (requires 16-byte alignment). |
| `ui-api.js` | `struct AppState` | Dioxus Global Signal holding all parameters. |

---

## 5. Implementation Phases for the AI

### Phase 1: The Engine Foundation (`src/engine/`)
**Objective:** Get a blank window rendering a color with WGPU.

1.  **`mod.rs`:** Initialize `wgpu::Instance`, `Adapter`, `Device`, and `Queue`.
2.  **`texture.rs`:** Create a helper to load `image::DynamicImage` and upload it to a `wgpu::Texture`.
3.  **`state.rs`:** Define the `NitrateState` struct that holds the current image texture and simulation parameters (exposure, grain_size, etc.).

### Phase 2: The Shader Laboratory (`assets/shaders/`)
**Objective:** Port the "Scientific" algorithms from GLSL to WGSL.

*   *Constraint:* WGSL is strict. Structs passed to shaders must be `#[repr(C)]` and aligned.
*   **`common.wgsl`:** Shared functions (linear-to-log conversions, luminance).
*   **`film_stock.wgsl`:**
    *   **Exposure:** Calculate in Linear Space.
    *   **Halation:** Red-channel scatter.
    *   **Grain:** Procedural noise based on ISO density curves.

### Phase 3: The Filter Pipeline
**Objective:** Build the render graph.

1.  Create a `FilterChain` struct.
2.  Implement **Ping-Pong Rendering**:
    *   Create two textures: `Ping` and `Pong`.
    *   Pass 1 (Exposure) reads `Source` -> writes `Ping`.
    *   Pass 2 (Bloom) reads `Ping` -> writes `Pong`.
    *   Pass 3 (Grain) reads `Pong` -> writes `Screen`.

### Phase 4: The UI Integration (`src/ui/`)
**Objective:** Connect Dioxus sliders to the Rust engine.

1.  **`Sidebar.rs`:** A component containing the sliders (Exposure, ISO, Halation).
2.  **`Viewport.rs`:** The canvas element. It initializes the `Engine` and listens for `AppState` changes.
3.  **Reactivity:** When a slider moves:
    *   Update `AppState` signal.
    *   Call `engine.update_uniforms()`.
    *   Trigger `window.request_redraw()`.

### Phase 5: The Export Fork (Web vs. Desktop)
**Objective:** Implement the "Pro" feature gate.

Create `src/io/export.rs`:

**A. Desktop Implementation (`cfg(not(target_arch="wasm32"))`)**
1.  Open `rfd::FileDialog` to save `.mp4`.
2.  Spawn `std::process::Command::new("ffmpeg")`.
3.  Configure FFmpeg to read raw RGBA from `stdin`.
4.  In the render loop: `device.poll()` -> map the output buffer -> write bytes to FFmpeg's `stdin`.

**B. Web Implementation (`cfg(target_arch="wasm32")`)**
1.  Define a dummy `export_video` function.
2.  Body: `web_sys::window().alert("For high-fidelity video export, please use the Nitrate Desktop Application.");`

---

## 6. Technical Specifics (Crucial for AI)

**Uniform Buffer Alignment:**
The AI **must** use padding for uniforms in Rust to match WGSL expectations (std140 layout).

```rust
#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct SimulationParams {
    exposure: f32,
    grain_strength: f32,
    halation_threshold: f32,
    // WGSL structs need 16-byte alignment. 3 floats = 12 bytes.
    // We need 4 bytes of padding to reach 16.
    _padding: f32, 
}
```

**Texture View Formats:**
*   Use `Rgba16Float` for internal processing (high dynamic range for light simulation).
*   Use `Bgra8Unorm` only for the final presentation to the screen.

---

## 7. Definition of Done

1.  **Visual Parity:** The "Nitrate" look (grain + halation) matches the original Webphy aesthetic.
2.  **Performance:** The WGPU engine runs smooth 60FPS on the web demo.
3.  **Pro Workflow:** Running the app locally allows opening a video file and exporting a processed version using the system's FFmpeg.
