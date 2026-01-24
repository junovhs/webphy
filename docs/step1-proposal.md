# Project NITRATE: Architectural Blueprint

## Executive Summary

This document presents the complete systems architecture for NITRATE, a cross-platform video engine designed for 8K/60fps playback with a vector-based UI. The architecture is organized around a single principle: **data should never cross the CPU-GPU boundary unless absolutely necessary**.

The design achieves the stated constraints through:

1. **Zero-Copy Memory Plane**: A unified GPU memory region shared between decoder and renderer
2. **Compiled Styling Pipeline**: CSS parsed once, converted to GPU-uploadable render commands
3. **Timeline-Based Synchronization**: GPU-to-GPU signaling with no CPU blocking
4. **Pressure-Aware Resource Management**: Proactive eviction before OOM conditions

**Key Metrics Target:**
- **Memory**: <100MB CPU RAM (GPU VRAM budget: ~500MB for 8K triple-buffered + UI)
- **Latency**: <200ms cold boot, <16ms frame time
- **Throughput**: ~1.5GB/s video decode bandwidth handled entirely in GPU memory

---

## 1. Module Hierarchy

```
nitrate/
├── nitrate-core/                 # Shared types, error handling, logging
│   ├── lib.rs
│   ├── types.rs                  # FrameId, TimelineValue, Rect, Color
│   ├── error.rs                  # Unified error enum
│   └── telemetry.rs              # Performance counters (no allocation)
│
├── nitrate-pal/                  # Platform Abstraction Layer
│   ├── lib.rs                    # Trait definitions
│   ├── handle.rs                 # ExternalHandle enum (unified)
│   ├── sync.rs                   # TimelineSemaphore trait
│   ├── vulkan/
│   │   ├── mod.rs
│   │   ├── dma_buf.rs            # VK_EXT_external_memory_dma_buf
│   │   ├── timeline.rs           # VK_KHR_timeline_semaphore
│   │   └── device.rs             # Vulkan device with extensions
│   ├── dx12/
│   │   ├── mod.rs
│   │   ├── shared_handle.rs      # DXGI_SHARED_HANDLE wrapping
│   │   ├── fence.rs              # ID3D12Fence as timeline
│   │   └── device.rs             # D3D12 device creation
│   └── metal/
│       ├── mod.rs
│       ├── io_surface.rs         # IOSurface wrapping
│       ├── shared_event.rs       # MTLSharedEvent
│       └── device.rs             # Metal device creation
│
├── nitrate-decode/               # Hardware video decoding
│   ├── lib.rs
│   ├── context.rs                # HWAccelContext trait
│   ├── frame.rs                  # DecodedFrame (handle + metadata)
│   ├── timeline.rs               # Frame timeline tracking
│   ├── ffmpeg/
│   │   ├── mod.rs
│   │   ├── vaapi.rs              # Linux VA-API context
│   │   ├── dxva2.rs              # Windows DXVA2/D3D12VA
│   │   └── videotoolbox.rs       # macOS VideoToolbox
│   └── pool.rs                   # Frame buffer pool
│
├── nitrate-style/                # CSS parsing and compilation
│   ├── lib.rs
│   ├── parser.rs                 # CSS text → AST
│   ├── compiler.rs               # AST → CompiledStyleSheet
│   ├── matcher.rs                # Element → ResolvedStyle
│   ├── cascade.rs                # Specificity + inheritance
│   ├── properties.rs             # Property ID enums + value types
│   └── compiled.rs               # Binary style sheet format
│
├── nitrate-layout/               # CSS layout engine
│   ├── lib.rs
│   ├── tree.rs                   # SlotMap-based node storage
│   ├── cache.rs                  # Red-Green incremental cache
│   ├── solver.rs                 # Taffy wrapper with caching
│   ├── flatten.rs                # Tree → linear GPU buffer
│   └── dirty.rs                  # Dirty flag propagation
│
├── nitrate-render/               # GPU rendering
│   ├── lib.rs
│   ├── scene.rs                  # Vello scene building
│   ├── atlas.rs                  # Glyph + image atlas
│   ├── pipeline.rs               # Render pipeline management
│   ├── uber_shader.rs            # Video + UI composition shader
│   └── cache.rs                  # Pipeline cache persistence
│
├── nitrate-compositor/           # Final composition
│   ├── lib.rs
│   ├── frame_graph.rs            # Render graph scheduling
│   ├── swapchain.rs              # Swapchain management
│   ├── present.rs                # VSync + frame pacing
│   └── overlay.rs                # Hardware overlay detection
│
└── nitrate-app/                  # Application framework
    ├── lib.rs
    ├── event_loop.rs             # winit integration
    ├── scheduler.rs              # Thread pool + work stealing
    └── app.rs                    # Application lifecycle
```

---

## 2. Data Flow Architecture

The architecture is organized around a **Frame Graph** that explicitly tracks data dependencies and enables maximum parallelism.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    FRAME N PIPELINE                                      │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  ┌─────────────────┐                                                                    │
│  │  VIDEO BITSTREAM │ (Network/File)                                                    │
│  │  ~100 Mbps       │                                                                    │
│  └────────┬─────────┘                                                                    │
│           │ CPU: Demux + Parse NAL units (~1MB/s)                                       │
│           ▼                                                                              │
│  ┌─────────────────────────────────────────┐                                            │
│  │         HARDWARE DECODE UNIT            │                                            │
│  │  ┌─────────────────────────────────┐   │                                            │
│  │  │ VA-API / DXVA2 / VideoToolbox   │   │                                            │
│  │  │                                 │   │                                            │
│  │  │  Input: Compressed NAL units    │   │                                            │
│  │  │  Output: NV12/P010 in VRAM      │   │◄── GPU Memory (Zero-Copy)                  │
│  │  │                                 │   │                                            │
│  │  │  Signal: Timeline Semaphore N   │   │                                            │
│  │  └─────────────────────────────────┘   │                                            │
│  └─────────────────┬───────────────────────┘                                            │
│                    │                                                                     │
│                    │ GPU-to-GPU: Timeline Semaphore Wait                                │
│                    ▼                                                                     │
│  ┌─────────────────────────────────────────┐     ┌─────────────────────────────────┐   │
│  │         RENDER ENGINE                   │     │       LAYOUT ENGINE             │   │
│  │  ┌─────────────────────────────────┐   │     │  ┌─────────────────────────┐    │   │
│  │  │ Wait(TimelineSema, N)           │   │     │  │ Taffy + Incremental     │    │   │
│  │  │                                 │   │     │  │ Cache                    │    │   │
│  │  │ Import Y_Plane as R8/R16        │   │     │  │                         │    │   │
│  │  │ Import UV_Plane as RG8/RG16     │   │     │  │ Output: Rect Buffer     │────┼───┤
│  │  │                                 │   │     │  └─────────────────────────┘    │   │
│  │  │ ┌─────────────────────────────┐ │   │     └─────────────────────────────────┘   │
│  │  │ │ UBER SHADER                 │ │   │                    │                       │
│  │  │ │                             │ │   │                    │                       │
│  │  │ │ Sample Y + UV               │ │   │◄───────────────────┘                       │
│  │  │ │ YUV → RGB (BT.2020)         │ │   │     GPU Upload: ~10KB/frame                │
│  │  │ │ HDR Tone Map (ACES/PQ)      │ │   │                                            │
│  │  │ │ Vello UI Composite          │ │   │                                            │
│  │  │ │ Alpha Blend                 │ │   │                                            │
│  │  │ └─────────────────────────────┘ │   │                                            │
│  │  │                                 │   │                                            │
│  │  │ Output: Swapchain Image         │   │                                            │
│  │  │ Signal: Timeline Semaphore N+1  │   │                                            │
│  │  └─────────────────────────────────┘   │                                            │
│  └─────────────────┬───────────────────────┘                                            │
│                    │                                                                     │
│                    ▼                                                                     │
│  ┌─────────────────────────────────────────┐                                            │
│  │              PRESENT                    │                                            │
│  │  Wait(TimelineSema, N+1)               │                                            │
│  │  vkQueuePresentKHR / IDXGISwapChain    │                                            │
│  └─────────────────────────────────────────┘                                            │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### The Zero-Copy Guarantee

The critical insight is that video frames **never exist in CPU-addressable memory**. The data flow is:

```
Network Buffer (CPU) → Demuxer (CPU: parse headers only) → 
    Hardware Decoder (writes to VRAM) → 
        Shared Texture Handle (GPU memory) → 
            Sampler in Fragment Shader (GPU) → 
                Swapchain (GPU → Display Controller)
```

The only CPU-side data movement is the compressed bitstream (~100 Mbps for 8K HEVC), which is 1/120th the bandwidth of uncompressed frames.

---

## 3. Thread Model

NITRATE uses a **heterogeneous thread pool** with dedicated threads for latency-critical paths and a work-stealing pool for parallel tasks.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                THREAD ARCHITECTURE                                       │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐   │
│  │                              MAIN THREAD (Priority: High)                         │   │
│  │  ┌────────────────────────────────────────────────────────────────────────────┐  │   │
│  │  │ winit EventLoop                                                             │  │   │
│  │  │  • Window Events (Resize, Close, Focus)                                     │  │   │
│  │  │  • Input Events (Mouse, Keyboard, Touch)                                    │  │   │
│  │  │  • VSync Signal (RedrawRequested)                                           │  │   │
│  │  │                                                                             │  │   │
│  │  │ Responsibilities:                                                           │  │   │
│  │  │  • Dispatch input to Layout thread via lock-free channel                    │  │   │
│  │  │  • Trigger frame composition on VSync                                       │  │   │
│  │  │  • NO BLOCKING OPERATIONS                                                   │  │   │
│  │  └────────────────────────────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────────────────────┘   │
│                                         │                                                │
│                    ┌────────────────────┼────────────────────┐                          │
│                    │                    │                    │                          │
│                    ▼                    ▼                    ▼                          │
│  ┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐               │
│  │   DECODE THREAD     │ │   LAYOUT THREAD     │ │   RENDER THREAD     │               │
│  │   (Priority: High)  │ │   (Priority: Normal)│ │   (Priority: High)  │               │
│  ├─────────────────────┤ ├─────────────────────┤ ├─────────────────────┤               │
│  │ • FFmpeg demux      │ │ • Taffy solve       │ │ • wgpu Queue submit │               │
│  │ • HW decode submit  │ │ • Style matching    │ │ • Pipeline binding  │               │
│  │ • Frame pool mgmt   │ │ • Dirty tracking    │ │ • Swapchain present │               │
│  │ • Timeline signal   │ │ • GPU buffer update │ │ • Fence management  │               │
│  │                     │ │                     │ │                     │               │
│  │ Affinity: Core 0    │ │ Affinity: Core 1    │ │ Affinity: Core 2    │               │
│  └──────────┬──────────┘ └──────────┬──────────┘ └──────────┬──────────┘               │
│             │                       │                       │                           │
│             │ ┌─────────────────────┴───────────────────────┤                           │
│             │ │                                             │                           │
│             ▼ ▼                                             ▼                           │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐ │
│  │                         SHARED STATE (Lock-Free)                                   │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                    │ │
│  │  │ FrameQueue      │  │ LayoutCache     │  │ CommandRing    │                    │ │
│  │  │ (SPSC Ring)     │  │ (Arc<AtomicU64>)│  │ (Triple Buffer)│                    │ │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘                    │ │
│  └───────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                          │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐ │
│  │                     WORK-STEALING POOL (4-8 threads)                              │ │
│  │  • Vello scene encoding (parallel path segments)                                  │ │
│  │  • Image decoding (JPEG/PNG for UI assets)                                        │ │
│  │  • Style compilation (parallel rule processing)                                   │ │
│  │  • Shader compilation (parallel pipeline creation)                                │ │
│  └───────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Inter-Thread Communication

All communication uses **lock-free primitives** to avoid priority inversion:

```rust
// nitrate-core/src/channels.rs

use crossbeam::queue::ArrayQueue;
use std::sync::atomic::{AtomicU64, Ordering};

/// Single-Producer Single-Consumer ring for decoded frames
pub struct FrameChannel {
    queue: ArrayQueue<FrameHandle>,
    /// Monotonic frame counter (never wraps in practice)
    head: AtomicU64,
    tail: AtomicU64,
}

impl FrameChannel {
    pub const CAPACITY: usize = 4; // 4 frames in flight max
    
    pub fn new() -> Self {
        Self {
            queue: ArrayQueue::new(Self::CAPACITY),
            head: AtomicU64::new(0),
            tail: AtomicU64::new(0),
        }
    }
    
    /// Called by Decode thread. Returns Err if queue is full (backpressure).
    pub fn push(&self, frame: FrameHandle) -> Result<(), FrameHandle> {
        self.queue.push(frame)?;
        self.head.fetch_add(1, Ordering::Release);
        Ok(())
    }
    
    /// Called by Render thread. Non-blocking.
    pub fn pop(&self) -> Option<FrameHandle> {
        let frame = self.queue.pop()?;
        self.tail.fetch_add(1, Ordering::Release);
        Some(frame)
    }
    
    /// Check if producer should stall (backpressure signal)
    pub fn is_full(&self) -> bool {
        let head = self.head.load(Ordering::Acquire);
        let tail = self.tail.load(Ordering::Acquire);
        (head - tail) as usize >= Self::CAPACITY
    }
}
```

### The "No GC" Guarantee

Rust's ownership model eliminates garbage collection, but careless allocation patterns can cause similar stalls. NITRATE enforces:

1. **Pre-allocated pools**: All frame buffers allocated at startup
2. **Arena allocation for layout**: Layout tree uses bump allocator, reset per frame
3. **Recycling over dropping**: Textures return to pool, never freed during playback

---

## 4. Memory Architecture

### Memory Zones and Budgets

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              MEMORY BUDGET ALLOCATION                                    │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  CPU RAM BUDGET: 100 MB                                                                 │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│  │ Component                          │ Allocation    │ Strategy                      │ │
│  ├────────────────────────────────────┼───────────────┼───────────────────────────────┤ │
│  │ Rust Runtime + Stack               │ ~5 MB         │ Fixed (Rust defaults)         │ │
│  │ Layout Tree (10,000 nodes max)     │ ~10 MB        │ SlotMap, pre-allocated        │ │
│  │ Style Cache (compiled)             │ ~5 MB         │ Mmap'd from disk (COW)        │ │
│  │ Vello Scene Buffer                 │ ~20 MB        │ Ring buffer, recycled         │ │
│  │ Command Encoder Ring               │ ~5 MB         │ Triple buffer                 │ │
│  │ Demuxer Packet Buffer              │ ~10 MB        │ Ring buffer, backpressure     │ │
│  │ Font Shaping Cache (HarfBuzz)      │ ~10 MB        │ LRU, bounded                  │ │
│  │ Image Decode Scratch               │ ~15 MB        │ Temp, freed after upload      │ │
│  │ Miscellaneous (logging, etc.)      │ ~10 MB        │ Best-effort                   │ │
│  │ HEADROOM                           │ ~10 MB        │ Safety margin                 │ │
│  ├────────────────────────────────────┼───────────────┼───────────────────────────────┤ │
│  │ TOTAL                              │ ~100 MB       │                               │ │
│  └────────────────────────────────────┴───────────────┴───────────────────────────────┘ │
│                                                                                          │
│  GPU VRAM BUDGET: ~600 MB (8K workload)                                                 │
│  ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│  │ Component                          │ Allocation    │ Format                        │ │
│  ├────────────────────────────────────┼───────────────┼───────────────────────────────┤ │
│  │ Video Frame Ring (4 frames)        │ ~200 MB       │ NV12: Y (R8) + UV (RG8)       │ │
│  │   └─ Per frame: 7680×4320×1.5      │ ~50 MB each   │ P010 for HDR: ~66 MB each     │ │
│  │ Swapchain (3 images)               │ ~380 MB       │ BGRA8: 7680×4320×4×3          │ │
│  │ Vello Tile Atlas                   │ ~16 MB        │ RGBA8, 4096×4096              │ │
│  │ Glyph Atlas                        │ ~4 MB         │ R8, 2048×2048                 │ │
│  │ TOTAL                              │ ~600 MB       │                               │ │
│  └────────────────────────────────────┴───────────────┴───────────────────────────────┘ │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### The 8K Memory Crisis and Solution

An 8K RGBA frame is **127 MB**. Even a 3-frame decode ring would consume **381 MB CPU RAM** if copied. The solution is to **never allocate frame memory on the CPU side**.

```rust
// nitrate-decode/src/pool.rs

use crate::pal::{ExternalHandle, TimelineSemaphore};
use std::sync::Arc;
use crossbeam::queue::ArrayQueue;

/// A frame that lives entirely in GPU memory
pub struct GpuFrame {
    /// Platform-specific handle (DMA-BUF fd, DXGI handle, IOSurface)
    pub handle: ExternalHandle,
    /// Y plane view (R8 or R16 for 10-bit)
    pub y_plane: TextureView,
    /// UV plane view (RG8 or RG16 for 10-bit)
    pub uv_plane: TextureView,
    /// Frame metadata (PTS, duration, color space)
    pub metadata: FrameMetadata,
    /// Timeline value when this frame will be ready
    pub ready_value: u64,
    /// Pool reference for recycling
    pool: Arc<FramePool>,
}

impl Drop for GpuFrame {
    fn drop(&mut self) {
        // Return to pool instead of freeing
        self.pool.return_frame(self.handle.clone());
    }
}

pub struct FramePool {
    available: ArrayQueue<ExternalHandle>,
    timeline: Arc<TimelineSemaphore>,
    fence_values: DashMap<HandleId, u64>,
    device: Arc<GpuDevice>,
    
    // Memory pressure monitoring
    budget: VramBudget,
}

impl FramePool {
    /// Pre-allocate the frame ring at startup
    pub fn new(device: Arc<GpuDevice>, frame_count: usize) -> Result<Arc<Self>, Error> {
        let pool = Arc::new(Self {
            available: ArrayQueue::new(frame_count),
            timeline: TimelineSemaphore::new(&device)?,
            fence_values: DashMap::new(),
            device: device.clone(),
            budget: VramBudget::new(&device),
        });
        
        // Pre-allocate all frames
        for _ in 0..frame_count {
            let handle = device.allocate_external_texture(
                7680, 4320,
                TextureFormat::Nv12, // Or P010 for HDR
                TextureUsage::DECODE_TARGET | TextureUsage::SAMPLED,
            )?;
            pool.available.push(handle).unwrap();
        }
        
        Ok(pool)
    }
    
    /// Acquire a frame for decoding. May return None under memory pressure.
    pub fn acquire(&self) -> Option<FrameSlot> {
        // Check memory pressure first
        if self.budget.pressure() > 0.9 {
            log::warn!("VRAM pressure > 90%, dropping frame");
            return None;
        }
        
        // Try to get from pool
        let handle = self.available.pop()?;
        
        // Ensure GPU is done with this frame
        let fence_value = *self.fence_values.get(&handle.id())?;
        if !self.timeline.is_complete(fence_value) {
            // Frame still in use, put it back
            self.available.push(handle).ok();
            return None;
        }
        
        let slot_value = self.timeline.next_value();
        Some(FrameSlot {
            handle,
            timeline_value: slot_value,
            pool: self.clone(),
        })
    }
}
```

---

## 5. Synchronization Strategy

### The Timeline Semaphore Paradigm

Traditional binary semaphores require one semaphore per synchronization point. For 60fps video, this means creating/destroying 60 semaphores per second. **Timeline Semaphores** solve this by using a single semaphore with a monotonically increasing counter.

```
Timeline Semaphore: "VideoDecodeComplete"
─────────────────────────────────────────────────────────────────────────────►
                                                                          Time
     ┌─────┐     ┌─────┐     ┌─────┐     ┌─────┐     ┌─────┐
     │ F0  │     │ F1  │     │ F2  │     │ F3  │     │ F4  │
     │     │     │     │     │     │     │     │     │     │
     └──┬──┘     └──┬──┘     └──┬──┘     └──┬──┘     └──┬──┘
        │           │           │           │           │
    Signal(1)   Signal(2)   Signal(3)   Signal(4)   Signal(5)
        │           │           │           │           │
        ▼           ▼           ▼           ▼           ▼
   ┌────────────────────────────────────────────────────────────┐
   │                    RENDER THREAD                           │
   │  Wait(1) → Render F0                                       │
   │            Wait(2) → Render F1                             │
   │                      Wait(3) → Render F2                   │
   │                                Wait(4) → Render F3         │
   └────────────────────────────────────────────────────────────┘
```

### Platform Abstraction

```rust
// nitrate-pal/src/sync.rs

/// Unified timeline semaphore trait
pub trait TimelineSemaphore: Send + Sync {
    /// Create a new semaphore with initial value 0
    fn new(device: &impl GpuDevice) -> Result<Self, Error> where Self: Sized;
    
    /// Get the next value to signal
    fn next_value(&self) -> u64;
    
    /// Signal this value (called by decoder)
    fn signal(&self, value: u64) -> Result<(), Error>;
    
    /// Wait for this value (GPU-side, non-blocking to CPU)
    fn gpu_wait(&self, value: u64, queue: &impl GpuQueue) -> Result<(), Error>;
    
    /// Check if value is complete (CPU-side query)
    fn is_complete(&self, value: u64) -> bool;
    
    /// Export for external sharing (FFmpeg interop)
    fn export(&self) -> Result<ExternalSemaphoreHandle, Error>;
}

// nitrate-pal/src/vulkan/timeline.rs

use ash::vk;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct VulkanTimelineSemaphore {
    device: Arc<ash::Device>,
    semaphore: vk::Semaphore,
    counter: AtomicU64,
}

impl TimelineSemaphore for VulkanTimelineSemaphore {
    fn new(device: &VulkanDevice) -> Result<Self, Error> {
        let timeline_info = vk::SemaphoreTypeCreateInfo::builder()
            .semaphore_type(vk::SemaphoreType::TIMELINE)
            .initial_value(0);
        
        let create_info = vk::SemaphoreCreateInfo::builder()
            .push_next(&mut timeline_info.build());
        
        let semaphore = unsafe {
            device.inner.create_semaphore(&create_info, None)?
        };
        
        Ok(Self {
            device: device.inner.clone(),
            semaphore,
            counter: AtomicU64::new(0),
        })
    }
    
    fn next_value(&self) -> u64 {
        self.counter.fetch_add(1, Ordering::SeqCst) + 1
    }
    
    fn gpu_wait(&self, value: u64, queue: &VulkanQueue) -> Result<(), Error> {
        // This injects a wait into the command stream, NOT a CPU block
        let wait_info = vk::SemaphoreSubmitInfo::builder()
            .semaphore(self.semaphore)
            .value(value)
            .stage_mask(vk::PipelineStageFlags2::FRAGMENT_SHADER);
        
        let submit_info = vk::SubmitInfo2::builder()
            .wait_semaphore_infos(std::slice::from_ref(&wait_info));
        
        unsafe {
            self.device.queue_submit2(
                queue.handle, 
                std::slice::from_ref(&submit_info), 
                vk::Fence::null()
            )?;
        }
        Ok(())
    }
    
    fn export(&self) -> Result<ExternalSemaphoreHandle, Error> {
        let export_info = vk::SemaphoreGetFdInfoKHR::builder()
            .semaphore(self.semaphore)
            .handle_type(vk::ExternalSemaphoreHandleTypeFlags::OPAQUE_FD);
        
        let fd = unsafe {
            self.device.get_semaphore_fd_khr(&export_info)?
        };
        
        Ok(ExternalSemaphoreHandle::Fd(fd))
    }
}
```

### Synchronization Flow

```rust
// nitrate-compositor/src/frame_graph.rs

pub struct FrameGraph {
    decode_semaphore: Arc<dyn TimelineSemaphore>,
    render_semaphore: Arc<dyn TimelineSemaphore>,
}

impl FrameGraph {
    /// Execute one frame's worth of work
    pub fn execute_frame(
        &self,
        frame_id: u64,
        video_frame: Option<&GpuFrame>,
        ui_scene: &VelloScene,
        swapchain: &mut Swapchain,
    ) -> Result<(), Error> {
        // 1. Acquire swapchain image (might block on present)
        let target = swapchain.acquire_next_image()?;
        
        // 2. Build command buffer
        let mut encoder = self.device.create_command_encoder();
        
        // 3. If we have video, inject a wait for decode completion
        if let Some(video) = video_frame {
            // GPU-side wait: does NOT block CPU
            self.decode_semaphore.gpu_wait(video.ready_value, &self.queue)?;
            
            // Bind video textures
            encoder.set_bind_group(0, &video.bind_group);
        }
        
        // 4. Bind UI scene (Vello output or rects buffer)
        encoder.set_bind_group(1, &ui_scene.bind_group);
        
        // 5. Run uber-shader
        encoder.begin_render_pass(&target.view);
        encoder.set_pipeline(&self.composition_pipeline);
        encoder.draw(0..3, 0..1); // Fullscreen triangle
        encoder.end_render_pass();
        
        // 6. Submit with render completion signal
        let render_value = self.render_semaphore.next_value();
        self.queue.submit(
            encoder.finish(),
            &[SignalOp {
                semaphore: &self.render_semaphore,
                value: render_value,
            }],
        )?;
        
        // 7. Present (waits internally for render to complete)
        swapchain.present(&target, render_value)?;
        
        Ok(())
    }
}
```

---

## 6. The Styling Pipeline: CSS to GPU

This is the critical innovation for bridging HTML/CSS design workflows to native rendering.

### Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                              STYLING PIPELINE                                             │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                           │
│  DESIGN TIME (Developer's Machine)                                                       │
│  ┌─────────────────┐                                                                     │
│  │  HTML + CSS     │ ← Designer creates mockup in browser                               │
│  │  (Reference)    │                                                                     │
│  └────────┬────────┘                                                                     │
│           │ Parse                                                                        │
│           ▼                                                                              │
│  ┌─────────────────┐                                                                     │
│  │  CSS AST        │ ← Parsed with `cssparser` crate                                    │
│  │  (In-Memory)    │                                                                     │
│  └────────┬────────┘                                                                     │
│           │ Compile                                                                      │
│           ▼                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐│
│  │                     COMPILED STYLE SHEET (Binary Format)                            ││
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       ││
│  │  │ Property Pool │  │ Selector Hash │  │ Rule Bytecode │  │ Bloom Filter  │       ││
│  │  │ (Interned)    │  │ (Pre-sorted)  │  │ (Compact)     │  │ (Fast reject) │       ││
│  │  └───────────────┘  └───────────────┘  └───────────────┘  └───────────────┘       ││
│  └────────────────────────────────────────────────────────┬────────────────────────────┘│
│                                                           │                              │
│  ════════════════════════════════════════════════════════│══════════════════════════════│
│                                                           │                              │
│  RUNTIME (User's Machine)                                 │                              │
│                                                           ▼                              │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐│
│  │                           STYLE MATCHER                                             ││
│  │                                                                                     ││
│  │  1. Element Hash ──► Bloom Filter ──► 99% rejection (O(1))                         ││
│  │  2. Candidate Rules ──► Binary Search ──► O(log n) matching                        ││
│  │  3. Matched Rules ──► Cascade by Specificity ──► ResolvedStyle                     ││
│  │                                                                                     ││
│  └────────────────────────────────────────────────────────┬────────────────────────────┘│
│                                                           │                              │
│                                                           ▼                              │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐│
│  │                           RESOLVED STYLE                                            ││
│  │  ┌─────────────────────────────────────────────────────────────────────────────┐   ││
│  │  │  display: Flex, flex_direction: Row, width: Length(100, Px),               │   ││
│  │  │  background_color: Idx(42), // Index into color pool                        │   ││
│  │  │  border_radius: [Idx(7), Idx(7), Idx(7), Idx(7)],                          │   ││
│  │  │  ...                                                                        │   ││
│  │  └─────────────────────────────────────────────────────────────────────────────┘   ││
│  └────────────────────────────────────────────────────────┬────────────────────────────┘│
│                                                           │                              │
│                    ┌──────────────────────────────────────┴─────────────────────────┐   │
│                    │                                                                 │   │
│                    ▼                                                                 ▼   │
│  ┌──────────────────────────────────┐              ┌──────────────────────────────────┐ │
│  │          LAYOUT (Taffy)          │              │        RENDER (Vello/GPU)        │ │
│  │  ResolvedStyle → LayoutRect      │              │  ResolvedStyle → DrawCommands    │ │
│  └──────────────────────────────────┘              └──────────────────────────────────┘ │
│                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### Compiled Style Sheet Format

```rust
// nitrate-style/src/compiled.rs

use zerocopy::{AsBytes, FromBytes};

/// Binary format for compiled stylesheets (memory-mappable)
#[repr(C)]
#[derive(AsBytes, FromBytes)]
pub struct CompiledStyleSheet {
    /// Magic number for validation: "NCSS"
    pub magic: [u8; 4],
    /// Version for forward compatibility
    pub version: u32,
    
    /// Offsets to sections (relative to start of file)
    pub color_pool_offset: u32,
    pub color_pool_count: u32,
    pub length_pool_offset: u32,
    pub length_pool_count: u32,
    pub rule_offset: u32,
    pub rule_count: u32,
    pub bloom_offset: u32,
    pub bloom_size: u32,
    
    // Followed by: color pool, length pool, rules, bloom filter
}

/// A compiled CSS rule
#[repr(C)]
#[derive(AsBytes, FromBytes, Clone, Copy)]
pub struct CompiledRule {
    /// Hash of the selector (for fast comparison)
    pub selector_hash: u64,
    /// Specificity (for cascade ordering)
    pub specificity: u32,
    /// Number of properties
    pub property_count: u16,
    /// Offset to properties array
    pub properties_offset: u16,
}

/// A compiled property assignment
#[repr(C)]
#[derive(AsBytes, FromBytes, Clone, Copy)]
pub struct CompiledProperty {
    /// Property ID (enum discriminant)
    pub id: u16,
    /// Index into appropriate pool (colors, lengths, etc.)
    pub value_index: u16,
}

/// Color stored in pool (sRGB, premultiplied alpha)
#[repr(C)]
#[derive(AsBytes, FromBytes, Clone, Copy)]
pub struct PooledColor {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}
```

### Style Matching Algorithm

```rust
// nitrate-style/src/matcher.rs

use std::collections::BinaryHeap;

pub struct StyleMatcher<'a> {
    stylesheet: &'a CompiledStyleSheet,
    bloom: BloomFilter,
}

impl<'a> StyleMatcher<'a> {
    /// Match an element against all rules, returning resolved style
    pub fn match_element(&self, element: &Element) -> ResolvedStyle {
        // 1. Compute element's selector signature
        let elem_hash = element.selector_hash();
        
        // 2. Bloom filter fast-path rejection
        // This rejects 99%+ of rules without detailed matching
        if !self.bloom.might_contain(elem_hash) {
            // No rules match this element type at all
            return ResolvedStyle::default();
        }
        
        // 3. Find candidate rules using binary search
        let candidates = self.find_candidate_rules(elem_hash);
        
        // 4. Detailed matching and cascade
        let mut matched: BinaryHeap<(Specificity, &CompiledRule)> = BinaryHeap::new();
        
        for rule in candidates {
            if self.selector_matches(rule, element) {
                matched.push((rule.specificity.into(), rule));
            }
        }
        
        // 5. Apply rules in specificity order (highest first)
        let mut resolved = ResolvedStyle::inherit_from(element.parent_style());
        
        while let Some((_, rule)) = matched.pop() {
            self.apply_rule(&mut resolved, rule);
        }
        
        resolved
    }
    
    /// Apply a rule's properties to the resolved style
    fn apply_rule(&self, style: &mut ResolvedStyle, rule: &CompiledRule) {
        let props = self.stylesheet.get_properties(rule);
        
        for prop in props {
            match PropertyId::from_u16(prop.id) {
                PropertyId::Display => {
                    style.display = Display::from_index(prop.value_index);
                }
                PropertyId::Width => {
                    let length = self.stylesheet.length_pool[prop.value_index as usize];
                    style.width = Dimension::Length(length);
                }
                PropertyId::BackgroundColor => {
                    // Store index, not color - color pool lives on GPU
                    style.background_color_idx = prop.value_index;
                }
                // ... 100+ properties
                _ => {}
            }
        }
    }
}
```

### Bridging to Taffy

```rust
// nitrate-layout/src/bridge.rs

impl From<&ResolvedStyle> for taffy::Style {
    fn from(style: &ResolvedStyle) -> Self {
        taffy::Style {
            display: match style.display {
                Display::Flex => taffy::Display::Flex,
                Display::Grid => taffy::Display::Grid,
                Display::Block => taffy::Display::Block,
                Display::None => taffy::Display::None,
            },
            size: taffy::Size {
                width: style.width.to_taffy(),
                height: style.height.to_taffy(),
            },
            flex_direction: style.flex_direction.to_taffy(),
            flex_wrap: style.flex_wrap.to_taffy(),
            flex_grow: style.flex_grow,
            flex_shrink: style.flex_shrink,
            // ... continue for all layout properties
            ..Default::default()
        }
    }
}
```

---

## 7. Layout Caching: The Red-Green Algorithm

### Incremental Layout Strategy

```rust
// nitrate-layout/src/cache.rs

use slotmap::{SlotMap, new_key_type};
use taffy::prelude::*;

new_key_type! { pub struct NodeId; }

bitflags::bitflags! {
    pub struct DirtyFlags: u8 {
        const STYLE = 0b0001;       // Style properties changed
        const CHILDREN = 0b0010;    // Children added/removed
        const MEASURE = 0b0100;     // Intrinsic size changed (text, image)
        const PARENT = 0b1000;      // Parent layout may have changed
    }
}

#[repr(C)]
pub struct LayoutNode {
    // === Input State ===
    /// Resolved style (from StyleMatcher)
    style: ResolvedStyle,
    /// Child node IDs (inline for small branching factor)
    children: SmallVec<[NodeId; 4]>,
    /// Parent node (for walking up during dirty propagation)
    parent: Option<NodeId>,
    
    // === Dirty Tracking ===
    /// Which aspects need recomputation
    dirty: DirtyFlags,
    /// Constraints from parent when layout was last computed
    last_constraints: Size<AvailableSpace>,
    
    // === Cached Output ===
    /// Computed layout rectangle (relative to parent)
    layout: Layout,
    /// Absolute position (computed during flatten pass)
    absolute_pos: Point<f32>,
    
    // === GPU Sync ===
    /// Index in GPU buffer (stable across frames)
    gpu_index: u32,
}

pub struct LayoutCache {
    nodes: SlotMap<NodeId, LayoutNode>,
    root: Option<NodeId>,
    
    // GPU buffer management
    gpu_buffer: wgpu::Buffer,
    dirty_ranges: Vec<Range<u32>>,
    
    // Taffy tree (for actual solve)
    taffy: TaffyTree<NodeId>,
}

impl LayoutCache {
    /// Mark a node as needing style recomputation
    pub fn mark_dirty(&mut self, node_id: NodeId, flags: DirtyFlags) {
        if let Some(node) = self.nodes.get_mut(node_id) {
            node.dirty |= flags;
            
            // Propagate PARENT flag up the tree
            if flags.intersects(DirtyFlags::STYLE | DirtyFlags::CHILDREN | DirtyFlags::MEASURE) {
                self.propagate_dirty_up(node.parent);
            }
        }
    }
    
    fn propagate_dirty_up(&mut self, parent: Option<NodeId>) {
        let mut current = parent;
        while let Some(id) = current {
            let node = &mut self.nodes[id];
            if node.dirty.contains(DirtyFlags::PARENT) {
                // Already propagated, stop
                break;
            }
            node.dirty |= DirtyFlags::PARENT;
            current = node.parent;
        }
    }
    
    /// Compute layout with caching
    pub fn compute(&mut self, viewport: Size<f32>) -> &[Range<u32>] {
        self.dirty_ranges.clear();
        
        let root = match self.root {
            Some(r) => r,
            None => return &self.dirty_ranges,
        };
        
        let constraints = Size {
            width: AvailableSpace::Definite(viewport.width),
            height: AvailableSpace::Definite(viewport.height),
        };
        
        self.solve_recursive(root, constraints, Point::ZERO);
        
        &self.dirty_ranges
    }
    
    fn solve_recursive(
        &mut self,
        node_id: NodeId,
        constraints: Size<AvailableSpace>,
        parent_abs_pos: Point<f32>,
    ) {
        let node = &self.nodes[node_id];
        
        // ═══════════════════════════════════════════════════════════════════
        // GREEN CHECK: Skip if nothing changed
        // ═══════════════════════════════════════════════════════════════════
        if node.dirty.is_empty() && node.last_constraints == constraints {
            // Subtree is completely clean AND constraints match
            // Only need to update absolute position if parent moved
            let new_abs = parent_abs_pos + node.layout.location.into();
            
            if node.absolute_pos != new_abs {
                self.update_absolute_positions_only(node_id, new_abs);
            }
            return;
        }
        
        // ═══════════════════════════════════════════════════════════════════
        // PARTIAL CHECK: Only absolute positions might need update
        // ═══════════════════════════════════════════════════════════════════
        if !node.dirty.intersects(DirtyFlags::STYLE | DirtyFlags::CHILDREN | DirtyFlags::MEASURE) 
            && node.last_constraints == constraints 
        {
            // Only PARENT flag is set, layout result is same, just positions shifted
            let new_abs = parent_abs_pos + node.layout.location.into();
            self.update_absolute_positions_only(node_id, new_abs);
            return;
        }
        
        // ═══════════════════════════════════════════════════════════════════
        // RED: Must recompute
        // ═══════════════════════════════════════════════════════════════════
        
        // Sync style to Taffy
        let taffy_node = self.taffy.get_or_create(node_id);
        self.taffy.set_style(taffy_node, (&node.style).into());
        
        // Compute layout (Taffy handles children internally)
        self.taffy.compute_layout(taffy_node, constraints).unwrap();
        
        // Extract result
        let layout = *self.taffy.layout(taffy_node).unwrap();
        
        // Update cached state
        let node = &mut self.nodes[node_id];
        node.layout = layout;
        node.last_constraints = constraints;
        node.absolute_pos = parent_abs_pos + Point::from(layout.location);
        node.dirty = DirtyFlags::empty();
        
        // ═══════════════════════════════════════════════════════════════════
        // GPU BUFFER UPDATE (Zero-Copy)
        // ═══════════════════════════════════════════════════════════════════
        self.write_to_gpu_buffer(node_id, &node.absolute_pos, &node.style);
        
        // Track dirty range for partial upload
        let gpu_idx = node.gpu_index;
        self.dirty_ranges.push(gpu_idx..gpu_idx + 1);
        
        // Recurse into children
        let children: SmallVec<[NodeId; 4]> = node.children.clone();
        let child_abs_pos = node.absolute_pos;
        for child_id in children {
            let child_constraints = self.get_child_constraints(node_id, child_id);
            self.solve_recursive(child_id, child_constraints, child_abs_pos);
        }
    }
}
```

### GPU Buffer Format

```rust
// nitrate-layout/src/flatten.rs

/// GPU-side representation of a UI node
/// Matches WGSL struct exactly
#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct GpuNode {
    /// Absolute screen rect (x, y, width, height)
    pub rect: [f32; 4],
    /// Background color index (into color pool)
    pub bg_color_idx: u32,
    /// Border color index
    pub border_color_idx: u32,
    /// Border widths (top, right, bottom, left) packed
    pub border_widths: [f32; 4],
    /// Border radii (top-left, top-right, bottom-right, bottom-left)
    pub border_radii: [f32; 4],
    /// Clipping rect (for overflow: hidden)
    pub clip_rect: [f32; 4],
    /// Flags (visibility, etc.)
    pub flags: u32,
    /// Padding for alignment
    pub _pad: [u32; 3],
}

// Size: 80 bytes per node
// 10,000 nodes = 800 KB GPU buffer
```

---

## 8. The Uber-Shader: Single-Pass Composition

### Shader Architecture

```wgsl
// nitrate-render/shaders/uber_shader.wgsl

// ═══════════════════════════════════════════════════════════════════════════════════════
// BIND GROUPS
// ═══════════════════════════════════════════════════════════════════════════════════════

// Group 0: Frame-level uniforms
struct FrameUniforms {
    viewport_size: vec2<f32>,
    time: f32,
    video_present: u32,
    hdr_max_luminance: f32,
    tone_map_mode: u32,  // 0 = passthrough, 1 = ACES, 2 = Reinhard
    _pad: vec2<f32>,
}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;

// Group 1: Video planes (zero-copy imported)
@group(1) @binding(0) var y_plane: texture_2d<f32>;
@group(1) @binding(1) var uv_plane: texture_2d<f32>;
@group(1) @binding(2) var video_sampler: sampler;

// Group 2: UI data
@group(2) @binding(0) var<storage, read> ui_nodes: array<GpuNode>;
@group(2) @binding(1) var<storage, read> color_pool: array<vec4<f32>>;
@group(2) @binding(2) var ui_atlas: texture_2d<f32>;
@group(2) @binding(3) var ui_sampler: sampler;

// ═══════════════════════════════════════════════════════════════════════════════════════
// STRUCTS
// ═══════════════════════════════════════════════════════════════════════════════════════

struct GpuNode {
    rect: vec4<f32>,           // x, y, width, height
    bg_color_idx: u32,
    border_color_idx: u32,
    border_widths: vec4<f32>,  // top, right, bottom, left
    border_radii: vec4<f32>,   // tl, tr, br, bl
    clip_rect: vec4<f32>,
    flags: u32,
    _pad: vec3<u32>,
}

struct VertexOutput {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) screen_pos: vec2<f32>,
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// VERTEX SHADER (Fullscreen Triangle)
// ═══════════════════════════════════════════════════════════════════════════════════════

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
    // Generate fullscreen triangle (no vertex buffer needed)
    var positions = array<vec2<f32>, 3>(
        vec2(-1.0, -1.0),
        vec2(3.0, -1.0),
        vec2(-1.0, 3.0)
    );
    
    let pos = positions[idx];
    var out: VertexOutput;
    out.clip_pos = vec4(pos, 0.0, 1.0);
    out.screen_pos = (pos * 0.5 + 0.5) * frame.viewport_size;
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// COLOR CONVERSION (BT.2020 for HDR content)
// ═══════════════════════════════════════════════════════════════════════════════════════

const BT2020_MATRIX = mat3x3<f32>(
    vec3(1.16438, 1.16438, 1.16438),
    vec3(0.00000, -0.18733, 2.14177),
    vec3(1.67867, -0.65042, 0.00000)
);

const YUV_OFFSET = vec3<f32>(0.06275, 0.50196, 0.50196);

fn yuv_to_rgb(y: f32, uv: vec2<f32>) -> vec3<f32> {
    let yuv = vec3(y, uv.x, uv.y) - YUV_OFFSET;
    return BT2020_MATRIX * yuv;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// HDR PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════════════

// PQ EOTF (ST.2084) - converts PQ signal to linear light
fn pq_eotf(val: vec3<f32>) -> vec3<f32> {
    let m1 = 0.1593017578125;
    let m2 = 78.84375;
    let c1 = 0.8359375;
    let c2 = 18.8515625;
    let c3 = 18.6875;
    
    let p = pow(max(val, vec3(0.0)), vec3(1.0 / m2));
    let num = max(p - c1, vec3(0.0));
    let den = c2 - c3 * p;
    return pow(num / den, vec3(1.0 / m1)) * 10000.0;
}

// ACES Filmic Tone Mapping
fn aces_tonemap(x: vec3<f32>) -> vec3<f32> {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return saturate((x * (a * x + b)) / (x * (c * x + d) + e));
}

fn process_hdr(linear: vec3<f32>) -> vec3<f32> {
    switch frame.tone_map_mode {
        case 0u: { // Passthrough (HDR display)
            return linear;
        }
        case 1u: { // ACES
            return aces_tonemap(linear / frame.hdr_max_luminance);
        }
        default: { // Reinhard
            return linear / (linear + vec3(1.0));
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// UI RENDERING (SDF-based for crisp 8K)
// ═══════════════════════════════════════════════════════════════════════════════════════

// Signed distance to rounded rectangle
fn sdf_rounded_rect(p: vec2<f32>, size: vec2<f32>, radii: vec4<f32>) -> f32 {
    // Select radius based on quadrant
    var r = radii.x;  // top-left
    if p.x > 0.0 && p.y < 0.0 { r = radii.y; }  // top-right
    else if p.x > 0.0 && p.y > 0.0 { r = radii.z; }  // bottom-right
    else if p.x < 0.0 && p.y > 0.0 { r = radii.w; }  // bottom-left
    
    let q = abs(p) - size + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}

fn render_node(node: GpuNode, screen_pos: vec2<f32>) -> vec4<f32> {
    // Transform to node-local coordinates
    let local_pos = screen_pos - node.rect.xy - node.rect.zw * 0.5;
    let half_size = node.rect.zw * 0.5;
    
    // Clipping
    if screen_pos.x < node.clip_rect.x || screen_pos.x > node.clip_rect.x + node.clip_rect.z ||
       screen_pos.y < node.clip_rect.y || screen_pos.y > node.clip_rect.y + node.clip_rect.w {
        return vec4(0.0);
    }
    
    // SDF for fill
    let d_fill = sdf_rounded_rect(local_pos, half_size, node.border_radii);
    
    // SDF for border (inset)
    let border_inset = min(node.border_widths.x, min(node.border_widths.y, 
                           min(node.border_widths.z, node.border_widths.w)));
    let d_border = sdf_rounded_rect(local_pos, half_size - border_inset, 
                                     max(node.border_radii - border_inset, vec4(0.0)));
    
    // Anti-aliased coverage
    let aa_width = fwidth(d_fill);
    let fill_coverage = 1.0 - smoothstep(-aa_width, aa_width, d_fill);
    let border_coverage = 1.0 - smoothstep(-aa_width, aa_width, d_border);
    
    // Fetch colors from pool
    let bg_color = color_pool[node.bg_color_idx];
    let border_color = color_pool[node.border_color_idx];
    
    // Composite: border over fill
    var color = bg_color * fill_coverage;
    let border_mask = fill_coverage - border_coverage;
    color = mix(color, border_color, border_mask * border_color.a);
    
    return color;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// FRAGMENT SHADER (Main composition)
// ═══════════════════════════════════════════════════════════════════════════════════════

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    var color: vec4<f32>;
    
    // ─────────────────────────────────────────────────────────────────────
    // 1. VIDEO LAYER (Background)
    // ─────────────────────────────────────────────────────────────────────
    if frame.video_present == 1u {
        let uv = in.screen_pos / frame.viewport_size;
        
        // Sample YUV planes
        let y = textureSample(y_plane, video_sampler, uv).r;
        let uv_sample = textureSample(uv_plane, video_sampler, uv).rg;
        
        // Convert to linear RGB
        var rgb = yuv_to_rgb(y, uv_sample);
        
        // Apply EOTF (PQ for HDR)
        rgb = pq_eotf(rgb);
        
        // Tone mapping
        rgb = process_hdr(rgb);
        
        // Gamma correction for SDR output
        rgb = pow(rgb, vec3(1.0 / 2.2));
        
        color = vec4(rgb, 1.0);
    } else {
        color = vec4(0.0, 0.0, 0.0, 1.0);
    }
    
    // ─────────────────────────────────────────────────────────────────────
    // 2. UI LAYERS (Front-to-back for early-out, then composite back-to-front)
    // ─────────────────────────────────────────────────────────────────────
    // Note: In practice, you'd use a tile-based approach (Vello) for complex UI.
    // This simplified version demonstrates the concept.
    
    let node_count = arrayLength(&ui_nodes);
    for (var i = 0u; i < node_count; i++) {
        let node = ui_nodes[i];
        
        // Skip invisible nodes
        if (node.flags & 1u) == 0u { continue; }
        
        // Quick AABB rejection
        if in.screen_pos.x < node.rect.x || in.screen_pos.x > node.rect.x + node.rect.z ||
           in.screen_pos.y < node.rect.y || in.screen_pos.y > node.rect.y + node.rect.w {
            continue;
        }
        
        let node_color = render_node(node, in.screen_pos);
        
        // Premultiplied alpha compositing
        color = node_color + color * (1.0 - node_color.a);
    }
    
    return color;
}
```

---

## 9. Cold Boot Optimization (<200ms)

### Startup Sequence

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                            COLD BOOT TIMELINE (Target: <200ms)                           │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  T=0ms        T=20ms       T=50ms       T=100ms      T=150ms      T=200ms              │
│    │            │            │            │            │            │                   │
│    ▼            ▼            ▼            ▼            ▼            ▼                   │
│  ┌────┐      ┌────┐      ┌────┐      ┌────┐      ┌────┐      ┌────┐                   │
│  │ A  │──────│ B  │──────│ C  │──────│ D  │──────│ E  │──────│ F  │                   │
│  └────┘      └────┘      └────┘      └────┘      └────┘      └────┘                   │
│                                                                                          │
│  A: Process Start + Rust Runtime Init (5ms)                                             │
│  B: Window Creation + GPU Device Request (15ms)                                         │
│  C: Pipeline Cache Load + Shader Module Creation (30ms)                                 │
│     └─ CRITICAL: Load cached PSO blobs from disk                                        │
│  D: Style Sheet Mmap + Layout Tree Init (20ms)                                          │
│     └─ CRITICAL: Zero-copy mmap of compiled CSS                                         │
│  E: Swapchain Creation + First Layout Solve (30ms)                                      │
│  F: First Frame Render + Present (50ms)                                                 │
│     └─ TARGET: First photon emitted                                                     │
│                                                                                          │
│  TOTAL: 150ms typical, 200ms worst-case                                                 │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Pipeline Cache Implementation

```rust
// nitrate-render/src/cache.rs

use std::path::PathBuf;
use std::fs;
use directories::ProjectDirs;

pub struct PipelineCacheManager {
    cache_path: PathBuf,
    cache: Option<wgpu::PipelineCache>,
}

impl PipelineCacheManager {
    pub fn new() -> Self {
        let cache_path = ProjectDirs::from("com", "nitrate", "nitrate")
            .map(|dirs| dirs.cache_dir().join("pipeline_cache.bin"))
            .unwrap_or_else(|| PathBuf::from("pipeline_cache.bin"));
        
        Self {
            cache_path,
            cache: None,
        }
    }
    
    /// Load cache from disk (called before pipeline creation)
    pub fn load(&mut self, device: &wgpu::Device) {
        let data = fs::read(&self.cache_path).ok();
        
        let descriptor = wgpu::PipelineCacheDescriptor {
            label: Some("NITRATE Pipeline Cache"),
            data: data.as_deref(),
            fallback: true, // Fall back to compilation if cache invalid
        };
        
        // SAFETY: Pipeline cache creation is safe, data format is validated by driver
        self.cache = Some(unsafe { device.create_pipeline_cache(&descriptor) });
    }
    
    /// Save cache to disk (called on graceful shutdown)
    pub fn save(&self) {
        if let Some(cache) = &self.cache {
            if let Some(data) = cache.get_data() {
                let _ = fs::create_dir_all(self.cache_path.parent().unwrap());
                let _ = fs::write(&self.cache_path, data);
            }
        }
    }
    
    /// Get cache for pipeline creation
    pub fn cache(&self) -> Option<&wgpu::PipelineCache> {
        self.cache.as_ref()
    }
}

// Usage in pipeline creation
impl RenderEngine {
    fn create_pipelines(&mut self) {
        self.cache_manager.load(&self.device);
        
        // Create shader modules from embedded SPIR-V (zero-copy)
        let shader = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Uber Shader"),
            source: wgpu::ShaderSource::SpirV(
                // Embedded at compile time, zero-copy reference
                std::borrow::Cow::Borrowed(include_spirv!("shaders/uber_shader.spv"))
            ),
        });
        
        // Create pipeline WITH cache
        self.composition_pipeline = self.device.create_render_pipeline(
            &wgpu::RenderPipelineDescriptor {
                label: Some("Composition Pipeline"),
                cache: self.cache_manager.cache(), // <-- CRITICAL
                // ... rest of descriptor
            }
        );
    }
}
```

### Lazy Initialization Strategy

```rust
// nitrate-app/src/app.rs

pub struct NitrateApp {
    // Initialized immediately
    window: winit::window::Window,
    device: wgpu::Device,
    queue: wgpu::Queue,
    
    // Lazily initialized (after first frame)
    decode_context: OnceCell<DecodeContext>,
    font_system: OnceCell<FontSystem>,
    
    // Pre-warmed but not blocking
    pipeline_warm_task: Option<JoinHandle<()>>,
}

impl NitrateApp {
    pub fn new(event_loop: &EventLoop<()>) -> Self {
        // Phase 1: Critical path (must complete before first frame)
        let window = create_window(event_loop);
        let (device, queue) = create_device(&window);
        
        // Phase 2: Kick off background tasks
        let pipeline_warm_task = Some(std::thread::spawn({
            let device = device.clone();
            move || {
                // Pre-compile secondary pipelines that aren't needed for first frame
                create_blur_pipeline(&device);
                create_shadow_pipeline(&device);
                // etc.
            }
        }));
        
        Self {
            window,
            device,
            queue,
            decode_context: OnceCell::new(),
            font_system: OnceCell::new(),
            pipeline_warm_task,
        }
    }
    
    pub fn handle_event(&mut self, event: Event<()>) {
        match event {
            Event::RedrawRequested(_) => {
                // First redraw: complete lazy init
                self.decode_context.get_or_init(|| DecodeContext::new(&self.device));
                self.font_system.get_or_init(|| FontSystem::new());
                
                self.render_frame();
            }
            // ...
        }
    }
}
```

---

## 10. Platform-Specific Implementation Details

### Linux (Vulkan + VA-API)

```rust
// nitrate-pal/src/vulkan/dma_buf.rs

use ash::vk;
use std::os::unix::io::RawFd;

/// Import a DMA-BUF as a Vulkan image
pub fn import_dma_buf(
    device: &ash::Device,
    fd: RawFd,
    width: u32,
    height: u32,
    format: vk::Format,
    modifier: u64,
) -> Result<(vk::Image, vk::DeviceMemory), Error> {
    // 1. Create image with external memory info
    let mut external_memory_info = vk::ExternalMemoryImageCreateInfo::builder()
        .handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
    
    let mut drm_format_modifier_info = vk::ImageDrmFormatModifierExplicitCreateInfoEXT::builder()
        .drm_format_modifier(modifier)
        .plane_layouts(&[vk::SubresourceLayout {
            offset: 0,
            size: 0, // Derived from dimensions
            row_pitch: 0, // Derived
            array_pitch: 0,
            depth_pitch: 0,
        }]);
    
    let image_info = vk::ImageCreateInfo::builder()
        .image_type(vk::ImageType::TYPE_2D)
        .format(format)
        .extent(vk::Extent3D { width, height, depth: 1 })
        .mip_levels(1)
        .array_layers(1)
        .samples(vk::SampleCountFlags::TYPE_1)
        .tiling(vk::ImageTiling::DRM_FORMAT_MODIFIER_EXT)
        .usage(vk::ImageUsageFlags::SAMPLED)
        .sharing_mode(vk::SharingMode::EXCLUSIVE)
        .push_next(&mut external_memory_info)
        .push_next(&mut drm_format_modifier_info);
    
    let image = unsafe { device.create_image(&image_info, None)? };
    
    // 2. Allocate memory from the DMA-BUF fd
    let mem_requirements = unsafe { device.get_image_memory_requirements(image) };
    
    let mut import_fd_info = vk::ImportMemoryFdInfoKHR::builder()
        .handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT)
        .fd(fd);
    
    let alloc_info = vk::MemoryAllocateInfo::builder()
        .allocation_size(mem_requirements.size)
        .memory_type_index(find_memory_type(device, mem_requirements.memory_type_bits)?)
        .push_next(&mut import_fd_info);
    
    let memory = unsafe { device.allocate_memory(&alloc_info, None)? };
    
    // 3. Bind memory to image
    unsafe { device.bind_image_memory(image, memory, 0)? };
    
    Ok((image, memory))
}
```

### Windows (DX12 + DXVA2)

```rust
// nitrate-pal/src/dx12/shared_handle.rs

use windows::Win32::Graphics::Direct3D12::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::core::*;

/// Import a shared DXGI handle as a D3D12 resource
pub fn import_shared_handle(
    device: &ID3D12Device,
    handle: HANDLE,
) -> Result<ID3D12Resource, Error> {
    let mut resource: Option<ID3D12Resource> = None;
    
    unsafe {
        device.OpenSharedHandle(handle, &mut resource)?;
    }
    
    resource.ok_or(Error::from("Failed to open shared handle"))
}

/// Create a shared fence for timeline synchronization
pub fn create_shared_fence(
    device: &ID3D12Device,
    initial_value: u64,
) -> Result<(ID3D12Fence, HANDLE), Error> {
    let fence: ID3D12Fence = unsafe {
        device.CreateFence(initial_value, D3D12_FENCE_FLAG_SHARED)?
    };
    
    let handle = unsafe {
        device.CreateSharedHandle(&fence, None, GENERIC_ALL, None)?
    };
    
    Ok((fence, handle))
}
```

### macOS (Metal + VideoToolbox)

```rust
// nitrate-pal/src/metal/io_surface.rs

use metal::{Device, Texture, TextureDescriptor};
use core_video_sys::*;
use std::ffi::c_void;

/// Import an IOSurface (from VideoToolbox) as a Metal texture
pub fn import_io_surface(
    device: &Device,
    io_surface: IOSurfaceRef,
    plane: usize,
) -> Result<Texture, Error> {
    unsafe {
        let width = IOSurfaceGetWidthOfPlane(io_surface, plane);
        let height = IOSurfaceGetHeightOfPlane(io_surface, plane);
        let format = match plane {
            0 => MTLPixelFormat::R8Unorm,  // Y plane
            1 => MTLPixelFormat::RG8Unorm, // UV plane
            _ => return Err(Error::InvalidPlane),
        };
        
        let descriptor = TextureDescriptor::new();
        descriptor.set_width(width as u64);
        descriptor.set_height(height as u64);
        descriptor.set_pixel_format(format);
        descriptor.set_storage_mode(MTLStorageMode::Shared);
        descriptor.set_usage(MTLTextureUsage::ShaderRead);
        
        let texture = device.new_texture_from_iosurface(
            io_surface as *mut c_void,
            &descriptor,
        );
        
        Ok(texture)
    }
}
```

---

## 11. Summary: Critical Path Decisions

| Decision Point | Choice | Rationale |
|---------------|--------|-----------|
| **GPU API** | wgpu (Vulkan/Metal/DX12) | Cross-platform, modern, zero-copy capable |
| **Decode API** | Platform-native (VA-API/DXVA2/VT) | Only way to get DMA-BUF/shared handles |
| **Layout Engine** | Taffy + custom cache | Flex/Grid support, Red-Green incremental update |
| **Vector Rendering** | Vello (compute) | Resolution-independent, bandwidth efficient |
| **Synchronization** | Timeline Semaphores | GPU-to-GPU sync without CPU stalls |
| **Style System** | Compiled CSS binary | O(1) matching, mmap'd at startup |
| **Memory Strategy** | Pre-allocated pools | No runtime allocation, fence-tracked reuse |
| **Threading** | Dedicated + work-stealing | Latency-sensitive ops isolated |

### The "Zero-Copy" Invariant

The architecture maintains one inviolable rule: **video pixel data never touches CPU-addressable memory after demuxing**. This is achieved by:

1. Hardware decoder writes directly to GPU-backed surfaces
2. Surfaces are shared via platform handles (not copied)
3. Render shader samples directly from decoded planes
4. Swapchain is presented without readback

This design enables 8K/60fps playback on hardware that would otherwise struggle with the ~1.5GB/s bandwidth requirement.

---

## Appendix: Crate Dependency Graph

```
nitrate-app
    ├── nitrate-compositor
    │   ├── nitrate-render
    │   │   ├── nitrate-layout
    │   │   │   ├── nitrate-style
    │   │   │   │   └── nitrate-core
    │   │   │   └── taffy
    │   │   ├── vello
    │   │   └── wgpu
    │   └── nitrate-decode
    │       ├── ffmpeg-next
    │       └── nitrate-pal
    │           ├── ash (Vulkan)
    │           ├── windows (DX12)
    │           └── metal-rs (Metal)
    └── winit
```
