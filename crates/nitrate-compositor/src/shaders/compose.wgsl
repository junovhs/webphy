// NITRATE Composition Shader
// Composites video + UI in linear light space

struct ColorUniforms {
    yuv_matrix: mat3x3<f32>,
    yuv_offset: vec3<f32>,
    transfer_in: u32,
    transfer_out: u32,
    tonemap_mode: u32,
    src_max_lum: f32,
    dst_max_lum: f32,
}

@group(0) @binding(0) var y_plane: texture_2d<f32>;
@group(0) @binding(1) var uv_plane: texture_2d<f32>;
@group(0) @binding(2) var ui_texture: texture_2d<f32>;
@group(0) @binding(3) var linear_sampler: sampler;
@group(0) @binding(4) var<uniform> color: ColorUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    // Fullscreen triangle
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    
    var uvs = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0),
    );
    
    var output: VertexOutput;
    output.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
    output.uv = uvs[vertex_index];
    return output;
}

// EOTF: Electrical → Optical (decode gamma)
fn apply_eotf(color: vec3<f32>, transfer: u32) -> vec3<f32> {
    switch transfer {
        // BT.709 gamma
        case 0u: {
            return pow(color, vec3<f32>(2.4));
        }
        // sRGB
        case 1u: {
            let low = color / 12.92;
            let high = pow((color + 0.055) / 1.055, vec3<f32>(2.4));
            return select(high, low, color <= vec3<f32>(0.04045));
        }
        // PQ (ST 2084) - simplified
        case 2u: {
            let m1 = 0.1593017578125;
            let m2 = 78.84375;
            let c1 = 0.8359375;
            let c2 = 18.8515625;
            let c3 = 18.6875;
            
            let Np = pow(color, vec3<f32>(1.0 / m2));
            let L = pow(max(Np - c1, vec3<f32>(0.0)) / (c2 - c3 * Np), vec3<f32>(1.0 / m1));
            return L * 10000.0; // nits
        }
        // Linear
        default: {
            return color;
        }
    }
}

// OETF: Optical → Electrical (encode gamma)  
fn apply_oetf(color: vec3<f32>, transfer: u32) -> vec3<f32> {
    switch transfer {
        // BT.709 gamma
        case 0u: {
            return pow(color, vec3<f32>(1.0 / 2.4));
        }
        // sRGB
        case 1u: {
            let low = color * 12.92;
            let high = 1.055 * pow(color, vec3<f32>(1.0 / 2.4)) - 0.055;
            return select(high, low, color <= vec3<f32>(0.0031308));
        }
        // Linear
        default: {
            return color;
        }
    }
}

// Simple Reinhard tone mapping
fn tonemap_reinhard(color: vec3<f32>, src_max: f32, dst_max: f32) -> vec3<f32> {
    let normalized = color / src_max;
    let mapped = normalized / (1.0 + normalized);
    return mapped * dst_max;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // 1. Sample video (NV12)
    let y = textureSample(y_plane, linear_sampler, input.uv).r;
    let uv_sample = textureSample(uv_plane, linear_sampler, input.uv).rg;
    
    // 2. YUV → RGB
    let yuv = vec3<f32>(y, uv_sample.x, uv_sample.y) - color.yuv_offset;
    let rgb_electrical = color.yuv_matrix * yuv;
    
    // 3. Apply EOTF → linear light
    var video_linear = apply_eotf(rgb_electrical, color.transfer_in);
    
    // 4. Tone map if needed (HDR → SDR)
    if color.tonemap_mode > 0u {
        video_linear = tonemap_reinhard(video_linear, color.src_max_lum, color.dst_max_lum);
    }
    
    // 5. Sample UI (assumed linear or sRGB texture)
    let ui = textureSample(ui_texture, linear_sampler, input.uv);
    
    // 6. Alpha composite in LINEAR space
    let composited = mix(video_linear, ui.rgb, ui.a);
    
    // 7. Apply output OETF
    let output = apply_oetf(composited, color.transfer_out);
    
    return vec4<f32>(clamp(output, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
