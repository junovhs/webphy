nitrate on  main [✘] is 📦 v0.1.0 via 🦀 v1.91.1
❯ cargo mutants
Found 170 mutants to test
ok       Unmutated baseline in 25.7s build + 0.3s test
 INFO Auto-set test timeout to 20s
MISSED   crates/nitrate-pal/src/vulkan/queues.rs:25:9: replace QueueFamilies::unique_indices -> Vec<u32> with vec![0] in 0.7s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/presentation/handle.rs:153:60: replace | with ^ in create_info in 0.6s build + 0.2s test
MISSED   crates/nitrate-app/src/bin/spike1.rs:149:26: replace += with -= in Session::render in 0.6s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/extensions.rs:18:5: replace filter_supported -> Vec<*const i8> with vec![Default::default()] in 0.7s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/instance.rs:165:17: replace | with ^ in create_debug_messenger in 0.6s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/presentation/sync.rs:49:43: replace % with / in FramePacer::advance in 0.7s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/presentation/sync.rs:53:9: replace FramePacer::teardown with () in 0.7s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/instance.rs:142:14: replace == with != in build_layers in 0.7s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/device.rs:92:5: replace is_device_suitable -> bool with true in 0.7s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/instance.rs:164:17: replace | with ^ in create_debug_messenger in 0.7s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/presentation/handle.rs:80:9: replace SwapchainHandle::destroy with () in 0.7s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/presentation/sync.rs:49:38: replace + with - in FramePacer::advance in 0.7s build + 0.2s test
MISSED   crates/nitrate-app/src/bin/spike1.rs:149:26: replace += with *= in Session::render in 0.6s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/instance.rs:103:9: delete match arm RawDisplayHandle::Wayland(_) in build_instance_extensions in 0.7s build + 0.3s test
MISSED   crates/nitrate-app/src/bin/spike1.rs:145:9: replace Session::render -> Result<()> with Ok(()) in 0.5s build + 0.2s test
MISSED   crates/nitrate-app/src/bin/spike1.rs:150:29: replace % with + in Session::render in 0.7s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/presentation/handle.rs:146:5: replace create_info -> vk::SwapchainCreateInfoKHR<'static> with Default::default() in 0.6s build + 0.3s test
MISSED   crates/nitrate-app/src/main.rs:11:5: replace main with () in 0.7s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/presentation/sync.rs:49:43: replace % with + in FramePacer::advance in 0.6s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/instance.rs:164:17: replace | with & in create_debug_messenger in 0.6s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/instance.rs:160:17: replace | with ^ in create_debug_messenger in 0.6s build + 0.3s test
MISSED   crates/nitrate-app/src/bin/spike1.rs:25:5: replace main -> Result<()> with Ok(()) in 0.7s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/presentation/sync.rs:49:9: replace FramePacer::advance with () in 0.7s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/instance.rs:101:9: delete match arm RawDisplayHandle::Xlib(_) in build_instance_extensions in 0.7s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/queues.rs:62:18: replace == with != in select_queue_families in 0.6s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/instance.rs:102:9: delete match arm RawDisplayHandle::Xcb(_) in build_instance_extensions in 0.6s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/presentation/sync.rs:49:38: replace + with * in FramePacer::advance in 0.6s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/presentation/images.rs:49:9: replace ImageChain::teardown with () in 0.7s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/instance.rs:116:14: replace == with != in build_instance_extensions in 0.7s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/device.rs:65:9: replace <impl Drop for VulkanDevice>::drop with () in 0.9s build + 0.3s test
MISSED   crates/nitrate-app/src/bin/spike1.rs:172:5: replace submit_clear -> Result<()> with Ok(()) in 0.6s build + 0.2s test
MISSED   crates/nitrate-app/src/bin/spike1.rs:45:9: replace <impl ApplicationHandler for SpikeApp>::resumed with () in 0.4s build + 0.2s test
MISSED   crates/nitrate-app/src/bin/spike1.rs:150:29: replace % with / in Session::render in 0.7s build + 0.2s test
MISSED   crates/nitrate-app/src/bin/spike1.rs:62:9: replace <impl ApplicationHandler for SpikeApp>::window_event with () in 0.4s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/presentation/handle.rs:153:60: replace | with & in create_info in 0.7s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/queues.rs:25:9: replace QueueFamilies::unique_indices -> Vec<u32> with vec![1] in 0.7s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/device.rs:92:5: replace is_device_suitable -> bool with false in 0.7s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/instance.rs:160:17: replace | with & in create_debug_messenger in 0.7s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/instance.rs:80:9: replace <impl Drop for VulkanInstance>::drop with () in 1.0s build + 0.3s test
MISSED   crates/nitrate-pal/src/vulkan/instance.rs:127:8: delete ! in build_layers in 1.0s build + 0.3s test
MISSED   crates/nitrate-app/src/bin/spike1.rs:150:35: replace == with != in Session::render in 0.7s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/instance.rs:165:17: replace | with & in create_debug_messenger in 0.7s build + 0.2s test
MISSED   crates/nitrate-app/src/bin/spike1.rs:69:13: delete match arm WindowEvent::RedrawRequested in <impl ApplicationHandler for SpikeApp>::window_event in 0.6s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/queues.rs:89:5: replace find_queue_families -> Option<QueueFamilies> with None in 0.9s build + 0.2s test
MISSED   crates/nitrate-app/src/bin/spike1.rs:63:13: delete match arm WindowEvent::CloseRequested in <impl ApplicationHandler for SpikeApp>::window_event in 0.9s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/presentation/engine.rs:68:9: replace PresentationEngine::teardown with () in 0.8s build + 0.2s test
MISSED   crates/nitrate-app/src/bin/spike1.rs:158:9: replace Session::destroy with () in 0.7s build + 0.2s test
MISSED   crates/nitrate-pal/src/vulkan/queues.rs:25:9: replace QueueFamilies::unique_indices -> Vec<u32> with vec![] in 0.6s build + 0.2s test
170 mutants tested in 2m 36s: 48 missed, 30 caught, 92 unviable

## Spike 1 Baseline (2024-XX-XX)
48 missed, 30 caught, 92 unviable — Accepted for spike phase.
Queue logic (`queues.rs`) flagged for property tests in Phase 2.
