// Enhanced Film Grain Module
// Based on AOMedia AV1 film grain synthesis research
// Resolution-normalized with authentic intensity scaling

import { compileShader, bindProgram } from '../gl-context.js';

export const GRAIN_PARAMS = {
  filmSpeed: { min: 100, max: 3200, step: 50, default: 800, label: 'Film Speed (ISO)' },
  grainCharacter: { min: 0, max: 1, step: 0.01, default: 0.62, label: 'Grain Character' },
  grainChroma: { min: 0, max: 1, step: 0.01, default: 0.72, label: 'Color Grain' }
};

// Reference resolution for grain consistency
const REFERENCE_HEIGHT = 1080;

// Film speed presets (ISO → grain strength curves)
const INTENSITY_CURVES = {
  // Format: [luma_value, grain_strength] pairs
  100:  [[0, 0.02], [40, 0.015], [128, 0.008], [200, 0.005], [255, 0.003]],
  400:  [[0, 0.05], [40, 0.040], [128, 0.025], [200, 0.015], [255, 0.010]],
  800:  [[0, 0.12], [40, 0.100], [128, 0.060], [200, 0.040], [255, 0.030]],
  1600: [[0, 0.20], [40, 0.160], [128, 0.100], [200, 0.070], [255, 0.055]],
  3200: [[0, 0.32], [40, 0.260], [128, 0.160], [200, 0.120], [255, 0.095]]
};

const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0, 1);
}
`;

const GRAIN_SHADER = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uCharacter, uChroma, uSeed, uResScale;
uniform float uIntensityCurve[10]; // 5 points x 2 values (luma, strength)

// Better color space
vec3 toLinear(vec3 s) {
  return mix(s / 12.92, pow((s + 0.055) / 1.055, vec3(2.4)), step(0.04045, s));
}

vec3 toSRGB(vec3 l) {
  return mix(l * 12.92, pow(l, vec3(1.0/2.4)) * 1.055 - 0.055, step(0.0031308, l));
}

// High-quality hash
float hash1(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 hash3(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

// Autoregressive grain (from AV1 paper)
float arGrain(vec2 p, float seed, float character) {
  float n = hash1(p + seed) - 0.5;
  
  // AR coefficients depend on character (lag parameter)
  float a0 = mix(0.85, 0.6, character);
  float a1 = mix(0.08, 0.25, character);
  
  float g_left = (hash1(p + vec2(-1, 0) + seed) - 0.5);
  float g_up = (hash1(p + vec2(0, -1) + seed) - 0.5);
  
  return a0 * n + a1 * (g_left + g_up);
}

// Gradient noise for variation
float gradNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  
  vec2 ga = hash2(i + vec2(0.0, 0.0)) * 2.0 - 1.0;
  vec2 gb = hash2(i + vec2(1.0, 0.0)) * 2.0 - 1.0;
  vec2 gc = hash2(i + vec2(0.0, 1.0)) * 2.0 - 1.0;
  vec2 gd = hash2(i + vec2(1.0, 1.0)) * 2.0 - 1.0;
  
  float va = dot(ga, f - vec2(0.0, 0.0));
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  
  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y);
}

// Worley for shadow clumping
float worley(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float minDist = 1.0;
  
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      vec2 neighbor = vec2(float(x), float(y));
      vec2 point = hash2(i + neighbor);
      vec2 diff = neighbor + point - f;
      minDist = min(minDist, length(diff));
    }
  }
  
  return minDist;
}

// Multi-octave grain synthesis
float grainLayer(vec2 p, float seed, float character) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  
  vec2 offset = hash2(vec2(seed, seed * 1.234)) * 100.0;
  vec2 jitter = (hash2(vec2(seed * 0.1234, seed * 0.5678)) - 0.5) * 0.8;
  p += offset + jitter;
  
  for (int i = 0; i < 3; i++) {
    float ar = arGrain(p * freq, seed + float(i), character);
    float grad = gradNoise(p * freq * 1.3);
    float n = mix(grad, ar, character);
    
    sum += amp * n;
    freq *= 2.1;
    amp *= 0.5;
  }
  
  return sum;
}

// Piece-wise linear lookup (from AV1 paper Section 4)
float lookupIntensity(float luma) {
  // Binary search would be more efficient, but 5 points is fine for linear
  for (int i = 0; i < 4; i++) {
    float x0 = uIntensityCurve[i * 2];
    float y0 = uIntensityCurve[i * 2 + 1];
    float x1 = uIntensityCurve[(i + 1) * 2];
    float y1 = uIntensityCurve[(i + 1) * 2 + 1];
    
    if (luma >= x0 && luma <= x1) {
      float t = (luma - x0) / (x1 - x0);
      return mix(y0, y1, t);
    }
  }
  
  // Fallback (shouldn't reach here)
  return uIntensityCurve[9]; // last strength value
}

void main() {
  vec3 color = texture2D(uTex, v_uv).rgb;
  vec3 linear = toLinear(color);
  float luma = dot(linear, vec3(0.2126, 0.7152, 0.0722));
  
  // Resolution-normalized grain coordinate (CRITICAL for consistency)
  // Base grain size scaled by resolution relative to 1080p reference
  float baseGrainSize = 1.2 * uResScale;
  vec2 grainUV = (v_uv * uRes) / baseGrainSize;
  
  // Lookup intensity scaling from piece-wise linear curve
  float lumaScaled = luma * 255.0;
  float intensityScale = lookupIntensity(lumaScaled);
  
  // Luminance-dependent response (preserve midtone contrast)
  float midtones = 1.0 - pow(abs(luma - 0.5) * 2.0, 1.5);
  midtones = mix(0.3, 1.0, midtones);
  
  float shadows = smoothstep(0.35, 0.0, luma);
  float highlights = smoothstep(0.8, 1.0, luma);
  
  // Generate luma grain
  float lumaGrain = grainLayer(grainUV, uSeed, uCharacter);
  
  // Shadow clumping (characteristic of film grain and underexposed sensors)
  float clumps = worley(grainUV * 0.6 + hash2(vec2(uSeed)) * 10.0);
  clumps = (clumps * 2.0 - 1.0) * 0.7;
  lumaGrain = mix(lumaGrain, clumps, shadows * uCharacter * 0.6);
  
  // Chromatic grain (looser AR correlation as per paper)
  vec3 chromaGrain = vec3(
    grainLayer(grainUV * 0.85 + vec2(12.34, 56.78), uSeed * 1.1, uCharacter * 0.7),
    grainLayer(grainUV * 0.85 + vec2(91.01, 23.45), uSeed * 1.2, uCharacter * 0.7),
    grainLayer(grainUV * 0.85 + vec2(67.89, 34.56), uSeed * 1.3, uCharacter * 0.7)
  );
  
  vec3 grain = mix(vec3(lumaGrain), chromaGrain, uChroma);
  
  // Apply intensity scaling from LUT
  float intensity = intensityScale;
  intensity *= midtones;
  intensity *= (1.0 - highlights * 0.6);
  intensity *= (1.0 + shadows * 0.4);
  
  // Density modulation (as per paper equation 2)
  vec3 grainedLinear = linear + (grain * intensity);
  grainedLinear = max(grainedLinear, 0.0);
  
  // Output
  vec3 finalColor = toSRGB(grainedLinear);
  
  // Dithering
  vec2 ditherJitter = hash2(v_uv * uRes + vec2(uSeed * 123.45));
  float dither = (ditherJitter.x - 0.5) / 255.0;
  finalColor += dither;
  
  gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
}
`;

function interpolateCurve(iso) {
  // Find surrounding ISO values
  const isoValues = [100, 400, 800, 1600, 3200];
  
  if (iso <= 100) return INTENSITY_CURVES[100];
  if (iso >= 3200) return INTENSITY_CURVES[3200];
  
  // Find bracketing values
  let lower = 100, upper = 400;
  for (let i = 0; i < isoValues.length - 1; i++) {
    if (iso >= isoValues[i] && iso <= isoValues[i + 1]) {
      lower = isoValues[i];
      upper = isoValues[i + 1];
      break;
    }
  }
  
  // Linear interpolation between curves
  const t = (iso - lower) / (upper - lower);
  const lowerCurve = INTENSITY_CURVES[lower];
  const upperCurve = INTENSITY_CURVES[upper];
  
  const result = [];
  for (let i = 0; i < lowerCurve.length; i++) {
    result.push([
      lowerCurve[i][0], // luma value (same for all ISOs)
      lowerCurve[i][1] * (1 - t) + upperCurve[i][1] * t // interpolated strength
    ]);
  }
  
  return result;
}

export class FilmGrainModule {
  constructor(gl, quad) {
    this.gl = gl;
    this.quad = quad;
    this.program = this.createProgram();
  }
  
  createProgram() {
    const gl = this.gl;
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, GRAIN_SHADER);
    
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Grain program link error:', gl.getProgramInfoLog(program));
      return null;
    }
    
    return program;
  }
  
  apply(inputTex, params, time, frameSeed, canvasW, canvasH) {
    const gl = this.gl;
    
    bindProgram(gl, this.program, this.quad, canvasW, canvasH);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uTex'), 0);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    
    // Resolution normalization (key for consistency)
    const resolutionScale = canvasH / REFERENCE_HEIGHT;
    gl.uniform1f(gl.getUniformLocation(this.program, 'uResScale'), resolutionScale);
    
    // Get intensity curve for current film speed
    const curve = interpolateCurve(params.filmSpeed);
    const curveFlat = curve.flat(); // [luma0, strength0, luma1, strength1, ...]
    gl.uniform1fv(gl.getUniformLocation(this.program, 'uIntensityCurve'), curveFlat);
    
    gl.uniform1f(gl.getUniformLocation(this.program, 'uCharacter'), params.grainCharacter);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uChroma'), params.grainChroma);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uSeed'), frameSeed);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}