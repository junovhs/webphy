
claude-opus-4-5-20251101-thinking-32k

Thought for 1 minute and 3 seconds

Project NITRATE: Architectural Blueprint
Executive Summary
This document presents the complete systems architecture for NITRATE, a cross-platform video engine designed for 8K/60fps playback with a vector-based UI. The architecture is organized around a single principle: data should never cross the CPU-GPU boundary unless absolutely necessary.

The design achieves the stated constraints through:

Zero-Copy Memory Plane: A unified GPU memory region shared between decoder and renderer
Compiled Styling Pipeline: CSS parsed once, converted to GPU-uploadable render commands
Timeline-Based Synchronization: GPU-to-GPU signaling with no CPU blocking
Pressure-Aware Resource Management: Proactive eviction before OOM conditions
Key Metrics Target:

Memory: <100MB CPU RAM (GPU VRAM budget: ~500MB for 8K triple-buffered + UI)
Latency: <200ms cold boot, <16ms frame time
Throughput: ~1.5GB/s video decode bandwidth handled entirely in GPU memory
1. Module Hierarchy
text

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
2. Data Flow Architecture
The architecture is organized around a Frame Graph that explicitly tracks data dependencies and enables maximum parallelism.

text

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
The Zero-Copy Guarantee
The critical insight is that video frames never exist in CPU-addressable memory. The data flow is:

text

Network Buffer (CPU) → Demuxer (CPU: parse headers only) → 
    Hardware Decoder (writes to VRAM) → 
        Shared Texture Handle (GPU memory) → 
            Sampler in Fragment Shader (GPU) → 
                Swapchain (GPU → Display Controller)
The only CPU-side data movement is the compressed bitstream (~100 Mbps for 8K HEVC), which is 1/120th the bandwidth of uncompressed frames.

3. Thread Model
NITRATE uses a heterogeneous thread pool with dedicated threads for latency-critical paths and a work-stealing pool for parallel tasks.

text

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
Inter-Thread Communication
All communication uses lock-free primitives to avoid priority inversion:

Rust

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
The "No GC" Guarantee
Rust's ownership model eliminates garbage collection, but careless allocation patterns can cause similar stalls. NITRATE enforces:

Pre-allocated pools: All frame buffers allocated at startup
Arena allocation for layout: Layout tree uses bump allocator, reset per frame
Recycling over dropping: Textures return to pool, never freed during playback
4. Memory Architecture
Memory Zones and Budgets
text

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
The 8K Memory Crisis and Solution
An 8K RGBA frame is 127 MB. Even a 3-frame decode ring would consume 381 MB CPU RAM if copied. The solution is to never allocate frame memory on the CPU side.

Rust

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
5. Synchronization Strategy
The Timeline Semaphore Paradigm
Traditional binary semaphores require one semaphore per synchronization point. For 60fps video, this means creating/destroying 60 semaphores per second. Timeline Semaphores solve this by using a single semaphore with a monotonically increasing counter.

text

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
Platform Abstraction
Rust

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
Synchronization Flow
Rust

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
6. The Styling Pipeline: CSS to GPU
This is the critical innovation for bridging HTML/CSS design workflows to native rendering.

Architecture Overview
text

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
Compiled Style Sheet Format
Rust

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
Style Matching Algorithm
Rust

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
Bridging to Taffy
Rust

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
7. Layout Caching: The Red-Green Algorithm
Incremental Layout Strategy
Rust

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
GPU Buffer Format
Rust

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
8. The Uber-Shader: Single-Pass Composition
Shader Architecture
wgsl

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
9. Cold Boot Optimization (<200ms)
Startup Sequence
text

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
Pipeline Cache Implementation
Rust

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
Lazy Initialization Strategy
Rust

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
10. Platform-Specific Implementation Details
Linux (Vulkan + VA-API)
Rust

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
Windows (DX12 + DXVA2)
Rust

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
macOS (Metal + VideoToolbox)
Rust

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
11. Summary: Critical Path Decisions
Decision Point	Choice	Rationale
GPU API	wgpu (Vulkan/Metal/DX12)	Cross-platform, modern, zero-copy capable
Decode API	Platform-native (VA-API/DXVA2/VT)	Only way to get DMA-BUF/shared handles
Layout Engine	Taffy + custom cache	Flex/Grid support, Red-Green incremental update
Vector Rendering	Vello (compute)	Resolution-independent, bandwidth efficient
Synchronization	Timeline Semaphores	GPU-to-GPU sync without CPU stalls
Style System	Compiled CSS binary	O(1) matching, mmap'd at startup
Memory Strategy	Pre-allocated pools	No runtime allocation, fence-tracked reuse
Threading	Dedicated + work-stealing	Latency-sensitive ops isolated
The "Zero-Copy" Invariant
The architecture maintains one inviolable rule: video pixel data never touches CPU-addressable memory after demuxing. This is achieved by:

Hardware decoder writes directly to GPU-backed surfaces
Surfaces are shared via platform handles (not copied)
Render shader samples directly from decoded planes
Swapchain is presented without readback
This design enables 8K/60fps playback on hardware that would otherwise struggle with the ~1.5GB/s bandwidth requirement.

Appendix: Crate Dependency Graph
text

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





The Research Inquiry: The "NITRATE" Problem Space
"I am architecting a 'Greenfield' Rust-based video engine (Project NITRATE) designed for 8K video playback and a vector-based UI, with a requirement of zero-copy data paths and a sub-100MB memory footprint. Please provide SOTA research and technical implementation details for the following 8 questions:"
Hardware-to-Graphics Interop: What are the precise low-level mechanisms for mapping AV_PIX_FMT_DRM_PRIME (Linux) and DXGI_SHARED_HANDLE (Windows) memory regions into a wgpu-hal raw texture object without incurring a CPU-side memcpy or a GPU-side Buffer-to-Image copy?
Cross-Context Synchronization: In a multi-threaded architecture where a dedicated FFmpeg thread decodes to a hardware context and a WGPU thread renders to the swapchain, what are the SOTA strategies for using Timeline Semaphores (Vulkan) and Keyed Mutexes (DX12) to ensure frame-perfect synchronization without CPU-thread blocking?
Compute-Centric Rasterization vs. Tessellation: For a UI requiring 8K-resolution crispness and CSS-like styling, how does a compute-shader-based rasterizer (e.g., Vello/Vulkan-subgroups) compare to traditional CPU-side tessellation (e.g., Lyon) in terms of VRAM bandwidth usage and frame-time variance?
Retained-Mode Layout Caching: Given that CSS layout (via Taffy) is a constraint-solving problem, how can a 'Layout Cache' be implemented to allow for partial tree re-evaluation (Partial Evaluation), effectively turning static CSS subtrees into fixed-position GPU constants while maintaining dynamic responsiveness for only modified nodes?
Multi-Planar YUV-to-RGB Pipelines: 8K video is natively multi-planar (P010/NV12). What is the optimal WGSL implementation for an 'Uber-Shader' that performs YUV-to-RGB conversion, 10-bit-to-8-bit tone mapping (or HDR-to-HDR pass-through), and UI alpha-blending in a single GPU pipeline stage?
VRAM Pool Management: To maintain a sub-100MB RAM footprint while handling 8K textures (where a single uncompressed frame can exceed 33MB), what are the best practices for GPU Buffer Pooling and 'Pressure-Aware' frame recycling to prevent the OS from killing the process during high-bandwidth streaming?
Sub-200ms Cold Boot Optimization: For a native Rust binary, what are the trade-offs between AOT (Ahead-of-Time) shader compilation to SPIR-V/DXIL versus JIT compilation during the WGPU initialization phase, and how does this impact the initial 'Time-to-First-Frame'?
Direct Composition and DWM Interop: On Windows, how does hosting the WebView2 (or similar) as a DirectComposition Visual compare to a pure winit windowed approach in terms of input-latency (photon-to-pixel) and the ability to overlay Rust-rendered GPU textures over a transparent UI layer?

To architect a "Greenfield" zero-copy video pipeline for Project NITRATE, you must bypass the safe wgpu surface APIs and drop down to the wgpu-hal (hardware abstraction layer) to wrap raw memory handles.

The following solution details the specific "unsafe" mechanisms required for Linux and Windows, based on State-of-the-Art (SOTA) engineering patterns from 2024-2025 (specifically the architecture used in the vk-video crate and smelter compositor).

1. SOTA Research: The "vk-video" Pattern
The current SOTA for Rust-based high-performance video is Vulkan Video integration, effectively solving the zero-copy problem by keeping the entire decode-to-render pipeline on the GPU.

Core Concept: Use ash (Rust Vulkan bindings) to drive the dedicated Video Decode Unit (VDU) on the GPU. The VDU writes directly into a VkImage backed by VK_EXT_external_memory_dma_buf (Linux) or VK_EXT_external_memory_win32 (Windows).
The Breakthrough: Instead of copying this image to a wgpu texture, you import the handle into wgpu's context. This allows wgpu render passes to sample directly from the decoder's output buffer as a TextureBinding.
2. Technical Implementation: The "Unsafe" Glue
The critical function that enables this interop is wgpu::Device::create_texture_from_hal. This function is unsafe and typically hidden in wgpu documentation because it requires wgpu_core internals, but it is the only zero-copy path.

A. Linux Implementation (AV_PIX_FMT_DRM_PRIME / DMA-BUF)
On Linux, you are mapping a file descriptor (DMA-BUF) representing GPU memory.

Requirements:

Vulkan Extensions: VK_EXT_external_memory_dma_buf, VK_EXT_image_drm_format_modifier.
Crates: ash, wgpu, wgpu-hal, drm-fourcc.
Mechanism:

Receive FD: Your decoder (FFmpeg/GStreamer/Vulkan Video) provides a dma_buf_fd and DRM modifiers.
Create Vulkan Image: Use ash to create a vk::Image with VkExternalMemoryImageCreateInfo pointing to the fd.
Wrap in HAL: Construct a wgpu_hal::vulkan::Texture.
Inject into wgpu: Use create_texture_from_hal.
Rust

use wgpu::unsafe::wgpu_core::id::DeviceId;
use wgpu_hal::vulkan::Api as VulkanApi;

// 1. Raw Vulkan Import (using ash)
// Assume 'device' is your underlying ash::Device and 'dma_buf_fd' is from the decoder
let image_create_info = vk::ImageCreateInfo::builder()
    .image_type(vk::ImageType::TYPE_2D)
    .format(vk::Format::R8G8B8A8_UNORM) // Must match video format (often NV12/YUV)
    .extent(vk::Extent3D { width: 7680, height: 4320, depth: 1 }) // 8K
    .usage(vk::ImageUsageFlags::SAMPLED) // Critical: Allows shader sampling
    .tiling(vk::ImageTiling::DRM_FORMAT_MODIFIER_EXT)
    .push_next(&mut external_memory_info) // VkExternalMemoryImageCreateInfo
    .push_next(&mut drm_modifier_info);   // VkImageDrmFormatModifierListCreateInfoEXT

let raw_vk_image = unsafe { device.create_image(&image_create_info, None)? };

// Bind memory (omitted for brevity: standard vkAllocateMemory with import fd)
// ...

// 2. Wrap in wgpu-hal
// You must construct the HAL texture manually.
let hal_texture = wgpu_hal::vulkan::Texture {
    inner: raw_vk_image,
    drop_guard: Some(Arc::new(MyDropGuard { ... })), // Handle cleanup
    copy_size: wgpu_hal::CopyExtent { width: 7680, height: 4320, depth: 1 },
    format: wgpu::TextureFormat::Rgba8Unorm,
    format_aspects: wgpu_hal::FormatAspects::COLOR,
    mip_level_count: 1,
    sample_count: 1,
    usage: wgpu_hal::TextureUses::RESOURCE, // equivalent to TEXTURE_BINDING
};

// 3. Inject into wgpu (Zero-Copy)
// This unsafe function lifts the HAL texture into a wgpu::Texture
let texture = unsafe {
    wgpu_device.as_hal::<VulkanApi, _, _>(|hal_device| {
        hal_device.create_texture_from_hal(
            hal_texture, 
            &wgpu::TextureDescriptor {
                label: Some("8K Video Surface"),
                size: wgpu::Extent3d { width: 7680, height: 4320, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            }
        )
    })
};
B. Windows Implementation (DXGI_SHARED_HANDLE)
On Windows, you are mapping a HANDLE (NT Handle) created by a DX12 decoder or D3D11-on-12 interop.

Requirements:

Vulkan Backend: Use VK_EXT_external_memory_win32.
DX12 Backend: Use ID3D12Device::OpenSharedHandle.
Mechanism (DX12 Backend Example):

Receive Handle: Decoder provides HANDLE (from ID3D12Device::CreateSharedHandle).
Open Resource: Use ID3D12Device::OpenSharedHandle to get an ID3D12Resource.
Wrap in HAL: Construct wgpu_hal::dx12::Texture.
Rust

use wgpu_hal::dx12::Api as Dx12Api;
use windows::Win32::Graphics::Direct3D12::{ID3D12Resource, ID3D12Device};

// 1. Open Shared Handle
// 'd3d12_device' is the raw device underlying wgpu
let mut resource: Option<ID3D12Resource> = None;
unsafe {
    d3d12_device.OpenSharedHandle(shared_handle, &ID3D12Resource::IID, &mut resource)?;
}
let raw_resource = resource.unwrap();

// 2. Wrap in wgpu-hal
let hal_texture = wgpu_hal::dx12::Texture {
    resource: raw_resource,
    format: wgpu::TextureFormat::Rgba8Unorm,
    dimension: wgpu::TextureDimension::D2,
    mip_level_count: 1,
    sample_count: 1,
    // Allocation info is often needed for DX12 memory tracking
    allocation: None, 
};

// 3. Inject into wgpu
let texture = unsafe {
    wgpu_device.as_hal::<Dx12Api, _, _>(|hal_device| {
        hal_device.create_texture_from_hal(
            hal_texture,
            &wgpu::TextureDescriptor { /* Same as Linux */ }
        )
    })
};
3. Critical Constraints for Project NITRATE
Synchronization (Fences): Zero-copy is dangerous without sync.
Linux: You must import the dma_fence (sync_file) associated with the buffer. Vulkan allows importing this via VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_SYNC_FD_BIT.
Windows: You must use ID3D12Fence (Shared Fence) to synchronize access between the video engine and the UI engine. wgpu does not automatically sync external resources; you must manually wait on the fence before submitting the wgpu render pass.
Memory Coherency: On integrated graphics (common in embedded 8K players), ensure the memory type chosen is HOST_COHERENT if the CPU needs to touch it (unlikely for pure playback) or ensure correct cache flushing if the GPU domains differ.
YUV Handling: The raw video is likely NV12 or P010 (10-bit). wgpu has strictly typed formats. You will likely need to import the luma (Y) and chroma (UV) planes as separate R8/RG8 textures (using the aspectMask in Vulkan image creation) and perform the YUV->RGB conversion in your UI shader. This is faster than relying on hardware samplers for conversion at 8K resolutions.
For a "Greenfield" high-performance 8K video engine in Rust, the state-of-the-art (SOTA) approach involves bypassing the CPU entirely for frame data and using explicit, fine-grained GPU synchronization.

Zero-copy is achieved by sharing GPU memory handles (DMA-BUFs on Linux, Shared Handles on Windows) between the decoder (FFmpeg) and the renderer (WGPU). Synchronization must be handled explicitly because these two contexts operate on different GPU queues (and potentially different logical devices).

1. Architectural Strategy: The "Zero-Copy" Data Path
To meet the sub-100MB requirement with 8K playback, you cannot afford a single CPU-side frame copy (an uncompressed 8K RGBA frame is ~132 MB). You must keep frames in VRAM/GTT.

Context Sharing: Instead of letting FFmpeg create its own device, you should create the GPU device context in your application (using ash for Vulkan or windows for DX12) and pass it to FFmpeg via AVHWDeviceContext. This ensures both the decoder and renderer live on the same physical device, enabling direct memory sharing.
Memory Import:
Vulkan: FFmpeg exports a VkImage backed by VK_KHR_external_memory_fd (Linux) or VK_KHR_external_memory_win32 (Windows).
DX12: FFmpeg (via D3D12VA or D3D11VA) exports a texture via ID3D12Resource shared handle.
WGPU Integration: You use wgpu::unsafe APIs (specifically wgpu_hal) to wrap these raw handles into a wgpu::Texture without allocation.
2. SOTA Synchronization Strategies
A. Vulkan: Timeline Semaphores (Linux/Cross-Platform)
Timeline Semaphores (VK_KHR_timeline_semaphore, core in Vulkan 1.2) are the superior primitive compared to binary semaphores because they allow a single primitive to track the progress of the entire decoding timeline (e.g., "Frame 100 is ready" vs. just "A frame is ready").

The Protocol:

Shared Timeline: Create a single VkSemaphore with VK_SEMAPHORE_TYPE_TIMELINE and export it (via VK_KHR_external_semaphore_fd).
FFmpeg Signaling: When configuring the AVVulkanFramesContext, you attach this semaphore. For every decoded frame, FFmpeg signals the semaphore with a monotonically increasing value (e.g., Frame ID).
Note: Standard FFmpeg CLI/wrappers often hide this. In Rust, you must manually configure the AVVulkanDeviceContext via ffmpeg-sys FFI to inject your external semaphore.
WGPU Waiting:
Import the semaphore into WGPU via wgpu_hal.
Before submitting the rendering command buffer for Frame N, inject a wait operation on the Timeline Semaphore for value N.
This blocks the GPU execution of the render pass until the decode is finished, but leaves the CPU free to build command buffers for future frames (e.g., Frame N+1, N+2).
B. DX12: Keyed Mutexes vs. Shared Fences
While you asked for Keyed Mutexes, the SOTA for a pure DX12 pipeline (using D3D12VA) is actually Shared Fences (ID3D12Fence), which behave identically to Vulkan Timeline Semaphores. Keyed Mutexes (IDXGIKeyedMutex) are primarily necessary if you are bridging D3D11 (FFmpeg legacy) to D3D12 (WGPU).

Strategy 1: Pure DX12 (SOTA)

Decode: Use FFmpeg with D3D12VA (requires recent FFmpeg builds).
Sync: Share an ID3D12Fence.
Flow: Decoder signals Fence value N. Renderer waits on Fence value N. This is identical to the Vulkan Timeline Semaphore path.
Strategy 2: D3D11 Interop (If D3D12VA is unstable/unavailable)

Decode: FFmpeg uses D3D11VA to decode into a D3D11 Texture.
Sync: The D3D11 texture is created with D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.
Flow:
FFmpeg: AcquireSync(0) -> Decode -> ReleaseSync(1).
WGPU (DX12): Open shared handle. Get ID3D12Resource.
WGPU Command Buffer: Record AcquireSync(1, ...) before rendering and ReleaseSync(0, ...) after rendering.
Critical: Keyed Mutex Acquire is a GPU-side wait, so it does not block the Rust CPU thread.
3. Technical Implementation Details (Rust)
You will need ffmpeg-next for high-level wrappers but must drop to ffmpeg-sys-next for the HW context setup.

Step 1: Initialize Vulkan with External Memory Support
Use ash to create an Instance/Device with these extensions:

Rust

let extensions = [
    b"VK_KHR_external_memory_fd\0", 
    b"VK_KHR_external_semaphore_fd\0",
    b"VK_KHR_timeline_semaphore\0",
    // plus standard validation/swapchain exts
];
// Enable timelineSemaphore feature in VkPhysicalDeviceVulkan12Features
Step 2: Configure FFmpeg HW Context
You must pass your ash::Device handle to FFmpeg so it doesn't create its own.

Rust

unsafe {
    let mut hw_device_ctx = av_hwdevice_ctx_alloc(AV_HWDEVICE_TYPE_VULKAN);
    let vulkan_device_ctx = (*hw_device_ctx).hwctx as *mut AVVulkanDeviceContext;
    
    // Inject your Ash handles
    (*vulkan_device_ctx).inst = my_ash_instance.handle();
    (*vulkan_device_ctx).act_dev = my_ash_device.handle();
    // ... configure queue families ...
    
    av_hwdevice_ctx_init(hw_device_ctx);
}
Step 3: Decoding & Zero-Copy Import
When you receive an AVFrame from the decoder, it contains the VkImage handle in data[0] or buf[0].

Rust

// 1. Extract raw handle (simplified)
let vk_image_handle = frame.data(0) as u64; // VkImage
let vk_format = frame.format(); // Need to map AV_PIX_FMT to VkFormat

// 2. Import into WGPU (using wgpu_hal/unsafe)
// You need to use the `wgpu::hal` crate to create a texture from a raw handle.
// This bypasses standard wgpu allocation.
let hal_texture = <wgpu_hal::vulkan::Api as Api>::Device::texture_from_raw(
    vk_image_handle, 
    &texture_desc, 
    Some(memory_handle) // You might need to export the memory handle from FFmpeg frame context too
);

// 3. Wrap in WGPU safe texture
let wgpu_texture = unsafe {
    device.create_texture_from_hal::<wgpu_hal::vulkan::Api>(
        hal_texture, 
        &texture_descriptor
    )
};
Step 4: Synchronization (The "Frame-Perfect" Part)
This is the most critical part for your "greenfield" engine.

Vulkan Timeline Semaphore approach:

Creation: Create a vk::Semaphore with SemaphoreType::TIMELINE.
Import to FFmpeg: When creating the AVHWFramesContext, you typically can't easily inject the semaphore into the decode call in standard FFmpeg API.
Workaround: Use av_vk_frame_alloc. Manually allocate the AVVkFrame structure, set its sem field to your imported timeline semaphore, and set the sem_value to the frame number. Pass this custom frame to the decoder as the output buffer.
WGPU Submission:
Rust

// In your render loop
let frame_idx = decoder.current_frame_index();

// WGPU doesn't natively expose Timeline Semaphore waits in `queue.submit`.
// You must implement a custom `wgpu_hal` call or use `ash` directly 
// to submit a "wait" operation on the generic queue before WGPU runs.

unsafe {
    // Ash submission
    device.queue_submit(
        graphics_queue,
        &[vk::SubmitInfo::builder()
            .wait_semaphores(&[timeline_semaphore])
            .wait_dst_stage_mask(&[vk::PipelineStageFlags::FRAGMENT_SHADER])
            .wait_semaphore_values(&[frame_idx])
            .build()],
        vk::Fence::null()
    )?;
}

// Then submit WGPU work
queue.submit(Some(encoder.finish()));
Summary Recommendation for Project NITRATE
For a "Greenfield" 8K engine:

Platform: Target Vulkan primarily. It offers the most robust explicit synchronization (Timeline Semaphores) and is the future of Linux/Android/Windows video (via Vulkan Video extensions).
Crate Stack: Use ash for device creation, ffmpeg-next (with unsafe sys access) for decoding, and wgpu (with hal access) for rendering.
Memory: Use NV12 (4:2:0) textures. Do not convert to RGBA in FFmpeg. Import the NV12 texture into WGPU as a R8Unorm (Y plane) and Rg8Unorm (UV plane) texture pair (multi-planar), and do the YUV->RGB conversion in your WGPU shader. This saves 50% bandwidth and memory compared to converting before import.
For Project NITRATE, the architectural choice between Compute-Centric Rasterization (Vello) and CPU-side Tessellation (Lyon) for an 8K UI is decisive.

Executive Summary:
For an 8K resolution interface with CSS-like styling and a strict memory budget, Compute-Centric Rasterization (Vello) is the superior technical approach, but it carries higher implementation risk.

Crispness: Compute shaders offer analytic anti-aliasing (exact coverage) which is resolution-independent. Tessellation struggles at 8K, requiring excessive triangle density to avoid micro-facets on curves.
Bandwidth: Compute approaches keep the "expansion" of shapes entirely in VRAM, saturating internal GPU bandwidth (which is high) while minimizing the precious CPU-to-GPU (PCIe) bandwidth.
Memory: The "sub-100MB" constraint is the critical bottleneck. A single 8K RGBA framebuffer is ~127 MB. To meet your requirement, you must use hardware overlay planes (rendering UI directly into a smaller swapchain or using damage regions) or a tile-streamed renderer. Vello’s tile-based nature aligns better with this than Lyon’s monolithic vertex buffers.
1. Compute-Centric Rasterization (Vello / Vulkan Subgroups)
Mechanism: Instead of drawing triangles, the engine uploads vector primitives (Bézier curves) directly to the GPU. A pipeline of compute shaders uses Vulkan Subgroups to sort these primitives into screen-space tiles (Binning) and then calculates pixel coverage per tile (Fine Rasterization).
VRAM Bandwidth: High Internal Bandwidth, Low External Bandwidth.
Why: You only upload lightweight control points. The GPU generates the "pixels" on the fly.
Subgroups: By using subgroup intrinsic functions (like subgroupAdd or subgroupExclusiveAdd), the engine performs prefix sums (scans) for sorting primitives entirely within the GPU registers/L1 cache, avoiding round-trips to VRAM. This drastically reduces the memory bandwidth pressure compared to older compute approaches.
Frame-Time Variance: Low (Predictable).
Because the work is uniform (sorting + executing coverage math), it scales linearly with scene complexity and resolution. There is no "spiky" CPU tessellation step that might stall the render thread.
8K Specifics:
Analytic AA: Calculates exact pixel coverage mathematically. Curves remain perfect at 8K without needing MSAA (which would explode memory usage).
Resolution Scaling: Scaling to 8K only increases the number of tiles/pixels to compute. It does not increase the memory footprint of the geometry itself.
2. CPU-Side Tessellation (Lyon)
Mechanism: The CPU calculates triangles that approximate curves and uploads them to a Vertex Buffer. The GPU renders them using the standard graphics pipeline.
VRAM Bandwidth: Moderate Internal, High External (PCIe).
Why: To maintain "crispness" at 8K, curves must be tessellated into thousands of tiny triangles. This geometric explosion saturates the PCIe bus when animating the UI.
Frame-Time Variance: High.
Complex scenes (e.g., a zoomed-in SVG) can cause a massive CPU spike to re-tessellate, leading to dropped frames even if the GPU is idle.
8K Specifics:
Micro-Polygon Problem: At 8K, to make a curve look smooth, you might generate triangles smaller than a pixel. GPUs are notoriously inefficient at rendering sub-pixel triangles (quad overdraw), causing performance to tank.
Technical Implementation for Project NITRATE
The Memory Bottleneck (Sub-100MB)
As noted, a raw 8K framebuffer (7680x4320 x 4 bytes) is ~127 MB. To achieve sub-100MB footprint, you cannot hold a full off-screen UI buffer.
Solution:

Hardware Compositing: Use the GPU's display controller (DC) to composite. Render the UI into a sparse set of tiles or a lower-resolution buffer (e.g., 4K upscaled) only where content exists.
Vello's Tile-Based Advantage: Vello naturally bins content into tiles (e.g., 16x16 or 32x32). You can architect the engine to only allocate memory for active tiles (sparse backing store), rendering directly to the swapchain image provided by the window system (Zero-Copy), ensuring you never allocate a full secondary framebuffer.
Comparison Matrix
Feature	Vello (Compute)	Lyon (Tessellation)	Winner for NITRATE
8K Quality	Analytic (Perfect curves)	Approximation (Faceting visible unless ultra-high poly)	Vello
Dynamic UI	Fast (Re-upload floats only)	Slow (Re-tessellate & Re-upload vertices)	Vello
Zero-Copy	True Zero-Copy (Direct primitive read)	False (CPU expansion -> Buffer Copy)	Vello
VRAM Bandwidth	High Internal (L2 Cache/VRAM)	High External (PCIe bottleneck)	Vello
Implementation Risk	High (Requires advanced Vulkan/WGPU)	Low (Standard Triangle pipeline)	Lyon
SOTA Recommendation
For a "Greenfield" 8K engine, adopt the Vello architecture but stripped down for your specific video needs.

Implementation Strategy:

Path Upload: Store UI layout as a flat buffer of Scene structs (floats). Map this buffer as storage for the GPU (Zero-copy from CPU perspective).
Pipeline:
Coarse Stage (Compute): Bin these paths into 16x16 pixel tiles. Use Subgroup intrinsics (GL_KHR_shader_subgroup_arithmetic) to compaction the bins efficiently.
Fine Stage (Compute): For each tile, launch a workgroup. Read the video frame (texture sampler), calculate the vector coverage (analytic), and blend. Write strictly to the swapchain image.
Memory Safety: By fusing the "UI Blend" and "Video Read" into one compute kernel, you avoid allocating an intermediate 127MB UI texture entirely. This is the only path to meeting your sub-100MB requirement at 8K.
This is a sophisticated systems engineering challenge that requires bridging incremental compilation theory (Rust compilers) with data-oriented rendering (Game engines).

To achieve Partial Tree Re-evaluation with a Zero-Copy path to the GPU, you cannot use Taffy "out of the box" in immediate mode. You must wrap it in a Red-Green Dependency Graph and implement a Linear Render Cache.

Below is the SOTA research synthesis and technical implementation architecture for Project NITRATE.

1. Theoretical Foundation: The Red-Green Algorithm
The "Layout Cache" should be implemented using the Red-Green Algorithm, formalized by the Rust compiler team (for rustc's incremental queries) and adapted for UI by projects like Xilem and Salsa.

Red Node (Dirty): A node whose local state (style, content) has changed. It must be re-evaluated.
Green Node (Clean): A node whose input dependencies are unchanged. Its output (layout geometry) is cached and valid.
Orange/Check Node: A node whose dependencies might have changed (e.g., a parent resizing), but whose local result might still be the same.
Key Insight: In CSS layout, a subtree is "static" (Green) only if:

Its internal style is unchanged.
Its incoming constraints (available width/height from parent) are identical to the last frame.
2. Implementation: The Layout Cache Architecture
Instead of re-running Taffy::compute_layout on the root every frame, you will implement a Retained State Graph that wraps Taffy nodes.

A. Data Structures
Use a SlotMap (or GenerationalArena) to store nodes contiguously in memory (Zero-Copy friendly) rather than heap-allocating pointer-chasing trees.

Rust

#[repr(C)]
struct LayoutNode {
    // Input State
    style: taffy::style::Style,
    children: SmallVec<[NodeId; 4]>, // Optimization for low branching factor
    
    // Dependency Tracking
    dirty_flags: DirtyFlags, // Bitmask: STYLE | CHILDREN | MEASURE
    last_constraints: Size<AvailableSpace>,
    
    // Output Cache (The "Green" Result)
    cached_layout: taffy::prelude::Layout,
}

struct LayoutCache {
    nodes: SlotMap<NodeId, LayoutNode>,
    // A linear buffer mapping NodeId -> GPU Buffer Index
    render_order: Vec<NodeId>, 
}
B. The Partial Evaluation Algorithm
You must implement a custom traversal that short-circuits Taffy's recursion.

Phase 1: Dirty Propagation (Bottom-Up)

When a node changes (e.g., UI hover effect), mark it Red.
Walk up to the root, marking parents as Orange (ChildChanged).
Optimization: Stop walking up if a parent is already marked.
Phase 2: Partial Layout Solve (Top-Down)

Begin traversal at Root.
Check: If Node is Green AND incoming_constraints == last_constraints:
SKIP this entire subtree.
Return the cached_layout.
Crucial for Project NITRATE: This is where you identify a "static subtree."
Else:
Call Taffy's compute logic.
Update last_constraints and cached_layout.
Mark node Green.
3. Turning Subtrees into "Fixed-Position GPU Constants"
To achieve the "sub-100MB footprint" and "8K playback" speed, you cannot regenerate the entire geometry buffer every frame. You need a Bindless GPU Render Graph.

A. The "GPU Constants" Strategy
Instead of sending a new Vertex Buffer every frame, allocate a large Storage Buffer (SSBO) on the GPU that persists across frames. This buffer acts as your "VRAM Layout Cache."

Struct Layout (std140/std430 compatible):

Rust

#[repr(C)]
#[derive(Pod, ZeroCopy)]
struct GpuUiNode {
    // 4x f32: Absolute Screen Coordinates (Calculated by CPU)
    rect: [f32; 4], 
    // 4x f32: Color / Texture ID / Flags
    style_data: [f32; 4],
    // 4x f32: Clipping Rect (for 8K masking)
    clip_rect: [f32; 4],
}
B. Flattening & Zero-Copy Update
When the Layout Solver finishes, you have a tree of Layout structs. You need to "flatten" this into the GPU buffer.

Dirty Range Tracking:

Maintain a dirty_ranges list (e.g., [(index: 5, count: 1), (index: 100, count: 50)]).
When a subtree is skipped (Green), do not touch its corresponding indices in the mapped GPU buffer. The data is already there from the previous frame.
When a node is re-evaluated (Red), calculate its Absolute Position (Parent Abs Pos + Local Offset) and write directly into the mapped staging buffer for that index.
Zero-Copy Path:

Use wgpu::Queue::write_buffer_with or a mapped staging buffer (wgpu::BufferUsages::MAP_WRITE).
Since you only write to the "Red" indices, bandwidth is minimized.
For 8K video, this UI layer sits on top. The "Fixed-Position" requirement is met because the GPU buffer retains the data until explicitly overwritten.
4. Code Sketch: The "Smart" Traverser
This is how you hook into Taffy to enable the caching:

Rust

impl LayoutCache {
    pub fn update_layout(&mut self, root_id: NodeId, viewport: Size<f32>) {
        let constraints = Size::from_length(viewport.width, viewport.height);
        
        // This function mimics Taffy's compute_layout but adds the Red-Green check
        self.solve_recursive(root_id, constraints, Point::ZERO);
    }

    fn solve_recursive(&mut self, node_id: NodeId, constraints: Size<AvailableSpace>, parent_pos: Point<f32>) {
        let node = &mut self.nodes[node_id];

        // 1. GREEN CHECK: If inputs match cached state, skip compute
        if !node.dirty_flags.intersects(DirtyFlags::STYLE | DirtyFlags::CHILDREN) 
           && node.last_constraints == constraints {
            
            // Subtree is static. 
            // We only need to update the ABSOLUTE position if the parent moved.
            if parent_pos != node.last_absolute_pos {
                self.update_absolute_positions_only(node_id, parent_pos);
            }
            return;
        }

        // 2. RED COMPUTE: Run Taffy Layout
        // (Pseudocode: call internal Taffy algo)
        let new_layout = taffy::compute_layout(node, constraints);
        
        // 3. CACHE RESULTS
        node.cached_layout = new_layout;
        node.last_constraints = constraints;
        node.last_absolute_pos = parent_pos + new_layout.location;
        node.dirty_flags = DirtyFlags::empty();

        // 4. FLUSH TO GPU BUFFER (Direct Write)
        self.gpu_mapper.write_node(node_id, node.last_absolute_pos, node.style);

        // 5. RECURSE
        for child in node.children {
            self.solve_recursive(child, new_constraints, node.last_absolute_pos);
        }
    }
}
Summary of Optimizations for Project NITRATE
Memory: Using SlotMap and SmallVec keeps the tree contiguous, reducing cache misses and keeping the footprint tiny (well under 100MB for even complex UIs).
Zero-Copy: You write directly to a mapped buffer that is effectively the GPU's "Scene Graph."
Partial Eval: The Red-Green check ensures that complex subtrees (e.g., a static settings menu) cost zero CPU cycles during layout if they haven't changed, even if the video player behind them is resizing.
For Project NITRATE, achieving 8K playback with a sub-100MB footprint requires a strict zero-copy architecture where the GPU reads directly from the decoder's output buffers. In a "Greenfield" Rust/wgpu environment, this means bypassing the high-level importExternalTexture (which is often browser-specific) and using backend-specific handles (DMA-BUF on Linux, DX12/DirectStorage on Windows) to bind the Y and UV planes as separate wgpu::TextureView resources.

Below is the technical implementation for the Multi-Planar "Uber-Shader" and the architectural strategy.

1. Architectural Strategy: Zero-Copy & Sub-100MB
To stay under 100MB, you cannot afford intermediate full-frame buffers (an 8K RGBA float buffer alone is ~265MB).

Zero-Copy Import: Use platform interoperability (e.g., ash or wgpu-hal in Rust) to wrap the video decoder's output (NV12 or P010) into wgpu::Texture objects without allocation.
The "Uber-Shader": Execute all operations in a single Fragment Shader pass.
Input: Y_Plane (R8/R16), UV_Plane (RG8/RG16), UI_Texture (RGBA).
Pipeline: Sample YUV 
→
→ Convert to Linear RGB (BT.2020) 
→
→ Apply HDR Transfer Function (PQ/HLG) 
→
→ Tone Map (ACES) 
→
→ Blend UI.
Output: The final Swapchain image (likely BGRA8 Unorm or RGB10A2 for HDR output).
2. The "Uber-Shader" (WGSL)
This shader handles 8K P010 (HDR) content. It performs YUV conversion, HDR processing, and UI composition in one pass to minimize memory bandwidth.

Rust

// shader.wgsl

// Bind Group 0: Video Data (Zero-Copy)
@group(0) @binding(0) var y_texture: texture_2d<f32>;  // Plane 0 (Luma)
@group(0) @binding(1) var uv_texture: texture_2d<f32>; // Plane 1 (Chroma)
@group(0) @binding(2) var video_sampler: sampler;      // Linear sampler

// Bind Group 1: UI Data
@group(1) @binding(0) var ui_texture: texture_2d<f32>;
@group(1) @binding(1) var ui_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// --- CONSTANTS -----------------------------------------------------------

// BT.2020 (Non-Constant Luminance) YCbCr to RGB Matrix (Limited Range)
// Derived from Kr = 0.2627, Kb = 0.0593
const bt2020_matrix = mat3x3<f32>(
    1.16438,  0.00000,  1.67867,
    1.16438, -0.18733, -0.65042,
    1.16438,  2.14177,  0.00000
);

// YUV Offsets for Limited Range (10-bit scaled to [0,1])
const yuv_offset = vec3<f32>(0.06275, 0.50196, 0.50196); // (16/255, 128/255, 128/255)

// --- HELPER FUNCTIONS ----------------------------------------------------

// ACES Tone Mapping (Narkowicz Fitted Curve)
// Efficient approximation suitable for real-time video
fn aces_tone_mapping(x: vec3<f32>) -> vec3<f32> {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return saturate((x * (a * x + b)) / (x * (c * x + d) + e));
}

// Perceptual Quantizer (PQ) EOTF - ST.2084
// Converts normalized electrical signal to Linear Light (in nits)
fn eotf_pq(val: vec3<f32>) -> vec3<f32> {
    let m1 = 2610.0 / 4096.0 * 0.25;
    let m2 = 2523.0 / 4096.0 * 128.0;
    let c1 = 3424.0 / 4096.0;
    let c2 = 2413.0 / 4096.0 * 32.0;
    let c3 = 2392.0 / 4096.0 * 32.0;
    
    let temp = pow(clamp(val, vec3(0.0), vec3(1.0)), vec3(1.0 / m2));
    let num = max(temp - c1, vec3(0.0));
    let den = c2 - c3 * temp;
    let linear = pow(num / den, vec3(1.0 / m1));
    
    return linear * 10000.0; // Scale to nits (PQ is absolute up to 10k nits)
}

// Simple Gamma correction for SDR output
fn gamma_correction(color: vec3<f32>) -> vec3<f32> {
    return pow(color, vec3(1.0 / 2.2));
}

// --- FRAGMENT SHADER -----------------------------------------------------

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // 1. Multi-Planar Sampling (Y + UV)
    // 8K Optimization: Ensure texture filtering is linear for smooth chroma upsampling
    let y = textureSample(y_texture, video_sampler, in.uv).r;
    let uv = textureSample(uv_texture, video_sampler, in.uv).rg;
    
    // 2. YUV to RGB Conversion (BT.2020)
    let yuv_vec = vec3<f32>(y, uv.x, uv.y) - yuv_offset;
    let rgb_linear_hdr = bt2020_matrix * yuv_vec;

    // 3. HDR Transfer Function (PQ -> Linear)
    // If input is HLG, replace eotf_pq with HLG OOTF
    let rgb_nits = eotf_pq(rgb_linear_hdr);

    // 4. Tone Mapping (HDR -> SDR)
    // Normalize nits for tone mapper (assuming 1000 nit max mastered content for mapping)
    let tone_mapped_rgb = aces_tone_mapping(rgb_nits / 1000.0);
    
    // 5. Colorspace / Gamma (Linear -> sRGB/Rec709)
    let final_video_rgb = gamma_correction(tone_mapped_rgb);

    // 6. UI Composition (Alpha Blending)
    // Assuming UI is already in sRGB. If UI is linear, apply gamma first.
    let ui_sample = textureSample(ui_texture, ui_sampler, in.uv);
    let ui_alpha = ui_sample.a;
    
    // Premultiplied alpha blending: src + dst * (1 - src_alpha)
    let out_rgb = ui_sample.rgb * ui_alpha + final_video_rgb * (1.0 - ui_alpha);

    return vec4<f32>(out_rgb, 1.0);
}
3. Technical Implementation Details for Rust/wgpu
Multi-Planar Binding (P010/NV12)
Unlike high-level web APIs, in wgpu native you must explicitly handle the planes. When you import a DMA-BUF (Linux) or DX12 Resource (Windows) via wgpu::ExternalTexture or unsafe handles:

Plane 0 (Y): Create a TextureView with format R8Unorm (NV12) or R16Unorm (P010).
Plane 1 (UV): Create a TextureView with format Rg8Unorm (NV12) or Rg16Unorm (P010).
Sampler: Use a ClampToEdge sampler. wgpu automatically handles the chroma subsampling coordinate shift if you sample both textures with the same UV coordinates, provided the UV texture view dimensions are correctly halved (which happens automatically with valid planar imports).
8K Optimization Checks
Workgroup Size (Compute vs Fragment): For playback, a Fragment Shader on a full-screen triangle is usually more efficient than a Compute Shader because the Rasterizer hardware handles memory locality (swizzling) better than manual compute indexing for display.
Bank Conflicts: The provided shader uses simple vector operations. Ensure your yuv_offset and matrices are const so they stay in scalar registers (SGPRs) rather than consuming vector registers (VGPRs).
10-bit Precision: P010 is 10-bit. The shader uses f32. On high-end GPUs, you might use f16 (via shader-f16 extension) for the math to double throughput, but f32 is safer for the high dynamic range of PQ to avoid banding in the blacks.
Zero-Copy Pipeline
Linux: Use gstreamer with wayland sink or vaapi to get DMABUF file descriptors. Use wgpu's unsafe create_texture_from_hal_prototype (or equivalent in wgpu-hal) to wrap these FDs.
Windows: Use DirectStorage or Media Foundation to decode to a DX12 texture. Share the handle with wgpu.
Project NITRATE’s constraints—8K playback, zero-copy, and <100MB CPU RAM—require strictly bypassing the CPU for all pixel data. You cannot decode to system RAM and upload; you must decode directly to GPU-backed surfaces and map them into your render graph.

The answer below outlines the specific architecture, Rust crate selection, and algorithms for "Pressure-Aware" VRAM pooling.

1. The "Zero-Copy" Architecture
To satisfy the <100MB CPU footprint, your Rust application must act merely as a conductor, signalling the GPU to move data. Pixel buffers must never touch Rust Vec<u8> or CPU heaps.

Linux: VA-API / V4L2 
→
→ DMA-BUF 
→
→ Vulkan / wgpu (via EGL or VK_EXT_external_memory_dma_buf).
Windows: Media Foundation / DirectStorage 
→
→ DX12 Resource 
→
→ Vulkan / wgpu (via VK_KHR_external_memory_win32).
macOS: VideoToolbox 
→
→ CVPixelBuffer (IOSurface backed) 
→
→ Metal Texture (via CVMetalTextureCache).
Key Rust Crate Stack:

Decoders: Use native bindings to ensure direct GPU-surface output.
windows crate (Direct3D 12 Video / Media Foundation).
core-foundation + core-video-sys + metal (macOS).
gstreamer-rs (safest bet for Linux VA-API/DMA-BUF zero-copy plumbing) or ash (raw Vulkan) if building a custom decoder.
Graphics: wgpu (using wgpu-hal for unsafe handle imports) or ash / metal / windows for raw control.
Memory: gpu-allocator (for raw Vulkan/DX12 memory management) if bypassing wgpu's allocator.
2. VRAM Pool Management: The Arc<ReleaseGuard> Pattern
Allocating 50MB–130MB buffers (8K NV12 vs RGBA) per frame is too slow (latency) and fragments VRAM. You need a pre-allocated Ring Pool.

The Architecture
Instead of standard RAII, use a Recyclable Handle pattern. When a UI element or the renderer drops a frame, it automatically returns to the pool without CPU intervention.

Rust Implementation Sketch:

Rust

use std::sync::{Arc, Weak};
use crossbeam::queue::ArrayQueue; // Lock-free queue for the pool

struct VramPool {
    // Fixed pool of GPU-backed textures (e.g., 10 slots for 8K)
    available_frames: ArrayQueue<GpuTextureHandle>, 
    // Handle to GPU device to create new ones if budget allows
    device: GpuDevice,
}

pub struct VideoFrame {
    pub texture: GpuTextureHandle,
    // When this drops, the texture goes back to 'pool'
    pool: Weak<VramPool>, 
}

impl Drop for VideoFrame {
    fn drop(&mut self) {
        if let Some(pool) = self.pool.upgrade() {
            // "Zero-cost" return to free list
            pool.return_frame(self.texture.clone()); 
        }
        // If pool is dead, texture is destroyed naturally
    }
}
Best Practices for 8K Pools:

Split Heaps: 8K frames often use NV12 (bi-planar: Y plane + UV plane). Pool the Luma (Y) and Chroma (UV) textures separately if your renderer supports multi-planar sampling. This reduces fragmentation compared to forcing a single massive RGBA allocation.
Fence Tracking: You cannot reuse a buffer immediately after Drop. The GPU might still be reading it.
Implementation: When a frame returns to the pool, tag it with a u64 Fence Value.
Acquire: When pulling from the pool, check gpu.get_fence_value() >= frame.fence. If false, stall or skip (see Pressure-Awareness below).
3. "Pressure-Aware" Frame Recycling
To prevent OS kills (OOM Killer on Linux, jetsam on macOS), your engine must actively query the VRAM Budget and degrade quality before the OS intervenes.

A. The "Leaky Bucket" Pressure Algorithm
Implement a control loop that runs every frame (e.g., 60Hz):

Poll Budget:
Vulkan: VK_EXT_memory_budget (gives heapBudget and heapUsage).
DX12: IDXGIAdapter3::QueryVideoMemoryInfo.
Metal: [MTLDevice currentAllocatedSize] vs recommendedMaxWorkingSetSize.
Calculate Pressure Ratio: 
P
=
Current Usage
Budget
P= 
Budget
Current Usage
​
 
Apply Backpressure:
Pressure (
P
P)	Action	Rust Implementation Detail
< 0.7	Green: Nominal	Alloc new buffers if pool is empty.
0.7 - 0.9	Yellow: Recycling Only	Disable pool.create_new(). If pool is empty, block decoder thread (force drop frames at source).
> 0.9	Red: Panic Dump	Eviction: Immediately Drop cached "Forward/Backward" frames in the playback buffer. Force UI to release non-visible vector textures.
B. Panic Eviction (The "Sub-100MB" Guarantee)
If the user minimizes the window or another app spikes VRAM, the OS will page your 8K textures to system RAM (killing your <100MB requirement) or kill the process.

Rust Strategy: Listen to OS-specific suspend/focus events (winit has Suspended/Resumed).

On Focus Loss: Immediately pool.clear(). Release all decode targets.
On Resize: Do not reallocate immediately. Use wgpu::TextureView to "crop" the 8K texture to the new viewport size if smaller, avoiding a heavy reallocation spike.
4. Technical Checklist for Implementation
NV12 vs RGBA:

Trap: converting 8K NV12 to RGBA expands data from ~50MB to ~130MB.
Fix: Keep frames in NV12 all the way to the final shader. Write a custom fragment shader that samples Y and UV planes directly (sampler2D + sampler2D in GLSL/WGSL) and does the color conversion during the UI composite draw call. This saves ~80MB of VRAM per frame.
Zero-Copy Import (Unsafe Rust):
You will likely need wgpu's hal interface or raw bindings to import the external memory handles.

Rust

// Concept: Importing a Linux DMA-BUF as a Vulkan Image
let memory_import_info = vk::ImportMemoryFdInfoKHR::builder()
    .handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT)
    .fd(dma_buf_fd);

// This memory is NOT mapped to CPU. It exists only on GPU.
let image = device.create_image(&image_info, None)?;
device.bind_image_memory(image, imported_memory, 0)?;
The "Death" Loop:
In 8K, if you allocate faster than the GPU consumes, you will OOM in milliseconds.

Hard Limit: Set a const MAX_POOL_SIZE = 4; (approx 200MB-500MB VRAM).
Backpressure: If the pool is empty, the Decoder Thread must sleep. Do not buffer packets in CPU RAM; let the network socket block (TCP backpressure). This ensures your memory footprint stays flat regardless of stream duration.
For a sub-200ms cold boot in a Rust-based WGPU video engine, the most critical optimization is Pipeline Caching, not just the choice between AOT and JIT shader compilation. While providing pre-compiled SPIR-V (AOT) skips the initial parsing/validation step, the GPU driver still needs to compile that Intermediate Representation (IR) into machine code, which is often the primary bottleneck.

The following technical breakdown addresses the trade-offs and provides the implementation details required for your sub-100MB, zero-copy architecture.

1. Trade-offs: AOT (SPIR-V/DXIL) vs. JIT (WGSL)
In WGPU, "AOT" typically means compiling shaders to SPIR-V offline, whereas "JIT" means shipping WGSL source and compiling it at runtime.

Feature	AOT (Pre-compiled SPIR-V)	JIT (Runtime WGSL)
Startup Latency	Lower. Skips naga frontend parsing & IR generation.	Higher. Requires parsing text & validating WGSL at runtime.
Binary Size	Larger. SPIR-V blobs are significantly larger than minified text.	Smaller. WGSL is concise text; fits better in <100MB constraint.
Runtime Memory	Low. Zero-copy include_bytes! maps directly to slice.	Medium. AST/IR generation allocates temporary heap memory.
Safety/Validation	Deferred. Driver validation errors occur at pipeline creation.	Immediate. naga catches errors before the driver sees them.
DXIL Support	Complex. WGPU has experimental support for raw DXIL passthrough, but it bypasses safety checks.	Native. WGPU translates WGSL to DXIL internally for DX12.
Impact on Time-to-First-Frame:

SPIR-V reduces the CPU-side overhead of Device::create_shader_module by 10-40% compared to WGSL, depending on shader complexity.
However, Device::create_render_pipeline (where the driver compiles IR to ISA) is the dominant cost (often 50ms-200ms+ per pipeline). AOT alone will not guarantee sub-200ms boot.
2. The Solution: Pipeline Caching
To reliably hit sub-200ms, you must implement Pipeline Caching. This allows the driver to skip compilation entirely by loading a previously compiled binary blob from disk.

Technical Implementation Strategy
Enable AOT SPIR-V to minimize CPU overhead on the first run (cold cache).
Implement Pipeline Caching to make subsequent runs instant.
Zero-Copy Shader Loading by embedding shaders directly into the binary.
A. AOT Shader Compilation (Build Script)
Use a build.rs script to compile WGSL/GLSL to SPIR-V at build time. This ensures you ship optimized blobs.

Cargo.toml:

toml

[dependencies]
wgpu = { version = "0.19", features = ["spirv"] }
# "spirv" feature is strictly required to load pre-compiled modules
Implementation (Loading SPIR-V Zero-Copy):
Instead of loading files at runtime (IO cost), embed them into the Rust binary. This respects your "Zero-Copy" requirement by mapping the static memory directly.

Rust

use std::borrow::Cow;
use wgpu::util::make_spirv;

// Zero-copy load: The compiler embeds the bytes; we just reference the slice.
const SHADER_BYTES: &[u8] = include_bytes!("shaders/video_decode.spv");

fn create_shader(device: &wgpu::Device) -> wgpu::ShaderModule {
    // "make_spirv" parses the header but avoids deep copies where possible
    unsafe {
        device.create_shader_module_spirv(&wgpu::ShaderModuleDescriptorSpirV {
            label: Some("Video 8K Shader"),
            source: Cow::Borrowed(unsafe { 
                // Zero-copy cast from &[u8] to &[u32]
                std::slice::from_raw_parts(
                    SHADER_BYTES.as_ptr() as *const u32, 
                    SHADER_BYTES.len() / 4
                )
            }),
        })
    }
}
B. Pipeline Caching (The Sub-200ms Key)
WGPU exposes the underlying driver's cache via PipelineCache. You must manually manage the persistence of this cache.

Rust

use std::fs;

fn init_pipeline_cache(device: &wgpu::Device, cache_path: &str) -> Option<wgpu::PipelineCache> {
    // 1. Try to load existing cache from disk (Zero-Copy if using mmap, but fs::read is fine for <1MB)
    let cache_data = fs::read(cache_path).ok();
    
    let descriptor = wgpu::PipelineCacheDescriptor {
        label: Some("App Pipeline Cache"),
        data: cache_data.as_deref(), // Pass None if file doesn't exist
        fallback: true,              // Fallback to compilation if cache is invalid/stale
    };

    // 2. Create the cache object
    let cache = unsafe { device.create_pipeline_cache(&descriptor) };

    Some(cache)
}

fn save_pipeline_cache(cache: &wgpu::PipelineCache, cache_path: &str) {
    // 3. Retrieve blob from driver and save to disk for next boot
    if let Some(data) = cache.get_data() {
        let _ = fs::write(cache_path, data);
    }
}

// Usage in Pipeline Creation
fn create_pipeline(device: &wgpu::Device, cache: Option<&wgpu::PipelineCache>) {
    let pipeline_layout = /* ... */;
    
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("8K Playback Pipeline"),
        layout: Some(&pipeline_layout),
        cache, // <--- INJECT CACHE HERE
        // ... other fields
    });
}
3. Additional Cold Boot Optimizations
For a generic "Project NITRATE" engine, apply these specific WGPU settings:

Restrict Backends: Don't let WGPU enumerate all adapters (which can spin up internal GL/Vulkan/DX contexts).

Rust

let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
    // Only initialize the backend you need (e.g., DX12 on Windows)
    backends: wgpu::Backends::DX12, 
    ..Default::default()
});
Parallel Compilation: If you have multiple pipelines (UI + Video + Compute), create them in parallel using rayon or tokio. WGPU internals are thread-safe, and drivers often have a global lock, but preparing the descriptors in parallel helps.

DXIL Passthrough (Advanced/Risky):
If you are targeting Windows/DX12 exclusively and need absolute maximum performance, you can bypass WGPU's validation by passing raw DXIL. This is done via ShaderModuleDescriptorPassthrough (requires unsafe).

Warning: This is brittle and platform-locked. Stick to SPIR-V + Pipeline Cache for the best balance of safety and speed.
Summary Recommendation
To meet the sub-200ms target:

Compile shaders AOT to SPIR-V using glslangValidator or naga-cli in your build process.
Embed shaders using include_bytes! (Zero-Copy load).
Implement wgpu::PipelineCache to persist driver compilation artifacts to disk.
This combination allows the first run to be "fast enough" (AOT SPIR-V) and subsequent runs to be "instant" (Pipeline Cache), keeping memory usage low by avoiding runtime compiler libraries.

The following is a technical architectural recommendation for Project NITRATE, focusing on the specific constraints of 8K playback, zero-copy pipelines, and Rust integration on Windows.

Executive Summary
For your specific requirements—specifically the ability to sandwich a transparent UI between a background video and foreground GPU overlays—hosting WebView2 as a DirectComposition Visual is the only viable architecture.

While a pure winit HWND approach offers slightly lower theoretical input latency ("photon-to-kernel"), it suffers from the "Airspace Issue." An HWND-hosted WebView2 is an opaque child window that owns its pixels; you cannot efficiently render 8K video behind it or Rust textures over it without expensive CPU/GPU readbacks and copies.

DirectComposition (Visual Hosting) decouples the input and composition loops, allowing you to build a "zero-copy sandwich" where the OS compositor (DWM) handles the final merge of your video, UI, and overlay planes directly on the GPU hardware.

1. Latency Analysis: Visual vs. Windowed
Windowed Hosting (Pure winit / HWND)
Input Latency: Lowest. The OS Kernel delivers input messages (WM_MOUSEMOVE, etc.) directly to the WebView2’s message queue.
Composition Latency: Higher for mixed media. Because the WebView is a separate HWND, creating a unified presentation with video requires synchronizing two separate windows or using inefficient window layering (WS_EX_LAYERED), which often breaks hardware acceleration and introduces a frame of compositing lag.
Visual Hosting (DirectComposition / ICoreWebView2CompositionController)
Input Latency: Slightly Higher (~1 frame theoretical max penalty). You must capture input messages in your Rust application's message pump (e.g., winit event loop) and manually forward them via SendMouseInput / SendPointerInput.
Mitigation: This "app pump" latency is often negligible (<5ms) if your Rust main loop is non-blocking. The perceived latency is dominated by the DWM's VSync interval, not the forwarding cost.
Video/Render Latency: Lowest (SOTA). This approach supports Multi-Plane Overlays (MPO). If your hardware (GPU) and drivers support it, the DWM can scan out the video swapchain independently of the UI layer. This bypasses the composition pass entirely for the video plane, offering "flip-immediate" latency for the 8K content.
2. Architecture: The "NITRATE Sandwich"
To achieve zero-copy 8K playback with a vector UI and overlays, you must construct a DirectComposition tree. The WebView2 acts not as a window, but as a texture provider in this tree.

The Composition Tree Structure:

Root Visual (Attached to your main winit window HWND)
Child 1: Video Visual (Bottom)
Content: IDXGISwapChain1 (Flip Model).
Source: Decoded 8K frames (NV12/P010) via D3D12/Vulkan interop.
Child 2: WebView2 Visual (Middle)
Content: ICoreWebView2CompositionController::get_RootVisualTarget().
Properties: Transparent background.
Child 3: Rust Overlay Visual (Top)
Content: IDXGISwapChain1 (RGBA).
Source: wgpu or direct DirectX 12 render target for custom UI/HUD.
3. Technical Implementation Details
A. Zero-Copy Video Path
The critical requirement is ensuring the 8K video never leaves GPU memory and is never "copied" by the CPU or a shader pass if possible.

Swapchain Creation: Create a DXGI Swapchain for the video surface using CreateSwapChainForComposition.
Crucial Flag: Use DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL or DXGI_SWAP_EFFECT_FLIP_DISCARD. These "Flip Models" allow the DWM to promote the surface to a hardware overlay (MPO).
Visual Binding:
Rust

// Simplified Rust pseudocode using windows-rs
let dcomp_device: IDCompositionDevice = ...; // Create from D3D11/12 device
let root_visual = dcomp_device.CreateVisual()?;

// 1. Video Layer
let video_visual = dcomp_device.CreateVisual()?;
// The SwapChain must be wrapped in a surface or set directly depending on DComp version
video_visual.SetContent(&video_swapchain)?; 
root_visual.AddVisual(&video_visual, false, None)?;
B. Transparent WebView2 Integration
You must initialize the WebView2 environment with specific settings to allow the video to show through.

Controller Creation: Use CreateCoreWebView2CompositionController.
Transparency:
Rust

// In your WebView2 init callback
let controller: ICoreWebView2CompositionController = ...;
let core_view: ICoreWebView2 = controller.cast()?;
// Turn off the default white background
let settings = core_view.Settings()?;
settings.SetIsScriptEnabled(true)?;

// Set background color to fully transparent (0x00000000)
// Note: The Controller 'DefaultBackgroundColor' API is specifically for this.
let controller2: ICoreWebView2Controller2 = controller.cast()?;
controller2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 })?;
Input Forwarding (The Latency Handling):
Inside your winit event loop, intercept mouse/touch events.
Rust

// winit event loop
Event::WindowEvent { event, .. } => match event {
    WindowEvent::CursorMoved { position, .. } => {
        // Convert physical pixels to logical if necessary (DPI awareness)
        // WebView2 expects physical pixels in Visual Hosting mode usually, 
        // but verify against current DPI scaling.
        composition_controller.SendMouseInput(
            COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
            COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE,
            0, // mouse data
            POINT { x: position.x as i32, y: position.y as i32 }
        )?;
    },
    // Handle Clicks, Wheel, etc.
    _ => {}
}
C. Rust/GPU Overlay (Top Layer)
For the top layer (Rust rendering):

Create a second IDXGISwapChain1 specifically for your UI overlay.
Render your vector UI (using wgpu, skia-safe, or vello) into this swapchain.
Bind it to a third DirectComposition visual placed above the WebView2 visual.
Important: Ensure this swapchain uses DXGI_ALPHA_MODE_PREMULTIPLIED so the transparent parts of your Rust overlay composite correctly over the web content.
Summary Checklist for Project NITRATE
Crate Selection: windows (official Microsoft crate) for COM/DirectComposition, winit for the window shell.
DComp Device: Initialize IDCompositionDevice (or Device3 for latest features) using a D3D11 device (DirectComposition requires D3D11, even if your engine is D3D12/Vulkan; you may need shared handles or ID3D11On12Device for interop).
MPO Verification: Use IDXGIOutput6::CheckHardwareCompositionSupport to verify if your 8K video plane is being promoted to a hardware overlay. This is the "gold standard" for zero-copy performance.
The Architect's Challenge: Project NITRATE
The Objective:
Build a cross-platform (Windows/Linux/macOS) desktop engine called NITRATE. It must handle 8K/60fps video playback with zero-copy efficiency while maintaining a beautiful, web-fidelity UI (inspired by HTML/CSS).
The Performance "North Star":
Zero-Copy: Video frames must move from hardware decoder to GPU VRAM without CPU-side memcpy.
Minimalism: <100MB idle RAM footprint.
Speed: <200ms cold boot ("Instant-on").
Fidelity: UI must be vector-sharp at any zoom level (no blurry raster assets).
The Research "Pile" (Context for the Architect):
We have investigated several SOTA paths. Consider these as available ingredients, but feel free to reject them for better alternatives:
Rendering: wgpu (for cross-platform GPU abstraction).
Layout: Taffy (for CSS Flexbox/Grid logic in Rust).
Vector UI: Vello or Lyon (for compute/tessellation-based UI rendering).
Inter-Process/Inter-Thread: wgpu-hal for raw texture imports from FFmpeg/Hardware Contexts (DXGI_SHARED_HANDLE / DMA-BUF).
UI Design Workflow: The developer mocks in HTML/CSS, but the engine runs natively.
Your Task:
As a Senior Systems Architect, design the Internal Data Flow and Module Hierarchy for NITRATE. Do not just list libraries; explain the mechanical bridge between the hardware video decoder and the final composition pass.
Address the following "Friction Points":
The Bandwidth Wall: How do we handle ~1.5GB/s of 8K video data without stalling the UI thread or triggering Garbage Collection?
The Styling Gap: How do we bridge the "objective" appearance defined in CSS/HTML with a high-performance native Rust rendering pipeline?
Synchronization: How do we sync the video decoder's "Ready" signal with the GPU's "Draw" call across different platform APIs (Vulkan/Metal/DX12)?
Resource Management: How do we handle the lifecycles of massive 8K textures to stay within the 100MB RAM budget?
The Output Requirement:
Provide a comprehensive Architectural Blueprint. Define the crates, the thread boundaries, and the specific memory-sharing strategies. If you find a way to "compile" UI states into something faster than a standard layout-solver, explain that mechanism.
Constraint: No Webviews. No Electron. No JavaScript. Pure Rust and Graphics APIs.
