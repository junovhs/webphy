// Fullscreen blit shader for Spike 2.
// Samples imported texture and outputs to swapchain.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var tex_sampler: sampler;

// Fullscreen triangle (no vertex buffer needed).
// Vertices: (-1,-1), (3,-1), (-1,3) cover entire screen.
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
    var out: VertexOutput;

    // Generate fullscreen triangle positions
    let x = f32(i32(idx & 1u) * 4 - 1);
    let y = f32(i32(idx >> 1u) * 4 - 1);

    out.position = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(tex, tex_sampler, in.uv);
}