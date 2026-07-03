// Film Grain Studio Module
// Baked grain remains available for final-pixel exports.
// Performant grain previews the low-cost overlay kit that is exported next to the video.

import { compileShader, bindProgram } from '../gl-context.js';

export const GRAIN_PARAMS = {
  grainMode: {
    min: 0,
    max: 1,
    step: 1,
    default: 0,
    label: 'Grain Mode',
    options: ['Baked Grain', 'Performant Grain'],
  },

  // Baked pixel grain controls.
  grainAmount: {
    min: 0,
    max: 3,
    step: 0.01,
    default: 0,
    label: 'Grain Amount',
    grainMode: 'baked',
  },
  filmSpeed: {
    min: 100,
    max: 3200,
    step: 50,
    default: 400,
    label: 'Texture ISO',
    grainMode: 'baked',
  },
  grainSize: {
    min: 0.35,
    max: 4,
    step: 0.01,
    default: 1.0,
    label: 'Grain Size',
    grainMode: 'baked',
  },
  grainPrickliness: {
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.35,
    label: 'Prickliness',
    grainMode: 'baked',
  },
  grainCharacter: {
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.45,
    label: 'Organic Texture',
    grainMode: 'baked',
  },
  grainChroma: {
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.08,
    label: 'Color Grain',
    grainMode: 'baked',
  },
  grainShadowBias: {
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.55,
    label: 'Shadow Bias',
    grainMode: 'baked',
  },
  grainHighlightProtect: {
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.7,
    label: 'Highlight Protect',
    grainMode: 'baked',
  },
  grainNoiseType: {
    min: 0,
    max: 3,
    step: 1,
    default: 0,
    label: 'Noise Recipe',
    options: ['Organic', 'Fine Gaussian', 'Clumped', 'Prickly'],
    grainMode: 'baked',
  },
  grainAnimateStill: {
    min: 0,
    max: 1,
    step: 1,
    default: 1,
    label: 'Animate Stills',
    options: ['Off', 'On'],
    grainMode: 'baked',
  },
  grainFps: {
    min: 1,
    max: 60,
    step: 1,
    default: 24,
    label: 'Grain FPS',
    grainMode: 'baked',
  },

  // Low-cost overlay kit controls.
  performantGrainAmount: {
    min: 0,
    max: 0.22,
    step: 0.001,
    default: 0.065,
    label: 'Overlay Amount',
    grainMode: 'performant',
  },
  performantGrainScale: {
    min: 0.5,
    max: 4,
    step: 0.01,
    default: 1.15,
    label: 'Texture Scale',
    grainMode: 'performant',
  },
  performantGrainContrast: {
    min: 0.2,
    max: 2.5,
    step: 0.01,
    default: 1.1,
    label: 'Texture Contrast',
    grainMode: 'performant',
  },
  performantGrainPrickliness: {
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.38,
    label: 'Prickliness',
    grainMode: 'performant',
  },
  performantGrainSoftness: {
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.18,
    label: 'Softness',
    grainMode: 'performant',
  },
  performantGrainMotion: {
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.65,
    label: 'Motion Jitter',
    grainMode: 'performant',
  },
  performantGrainFps: {
    min: 1,
    max: 30,
    step: 1,
    default: 12,
    label: 'Animation FPS',
    grainMode: 'performant',
  },
  performantGrainTile: {
    min: 0,
    max: 2,
    step: 1,
    default: 1,
    label: 'Texture Resolution',
    options: ['128 px', '256 px', '512 px'],
    grainMode: 'performant',
  },
};

const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const GRAIN_SHADER = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uMode;
uniform float uAmount;
uniform float uIso;
uniform float uSize;
uniform float uPrickliness;
uniform float uCharacter;
uniform float uChroma;
uniform float uShadowBias;
uniform float uHighlightProtect;
uniform float uNoiseType;
uniform float uSeed;
uniform float uPerfAmount;
uniform float uPerfScale;
uniform float uPerfContrast;
uniform float uPerfPrickliness;
uniform float uPerfSoftness;
uniform float uPerfMotion;

vec3 toSRGB(vec3 l) {
  l = max(l, 0.0);
  return mix(l * 12.92, pow(l, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, l));
}

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

float signedPow(float v, float p) {
  return sign(v) * pow(abs(v), p);
}

float gradNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 ga = hash2(i + vec2(0.0, 0.0)) * 2.0 - 1.0;
  vec2 gb = hash2(i + vec2(1.0, 0.0)) * 2.0 - 1.0;
  vec2 gc = hash2(i + vec2(0.0, 1.0)) * 2.0 - 1.0;
  vec2 gd = hash2(i + vec2(1.0, 1.0)) * 2.0 - 1.0;
  float va = dot(ga, f - vec2(0.0, 0.0));
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y) * 1.8;
}

float gaussianNoise(vec2 p, float seed) {
  float s = 0.0;
  s += hash1(p + seed + 0.11);
  s += hash1(p * 1.37 + seed + 9.73);
  s += hash1(p * 1.91 + seed + 23.41);
  s += hash1(p * 2.53 + seed + 47.19);
  return (s - 2.0) * 0.75;
}

float arGrain(vec2 p, float seed, float character) {
  float n = hash1(p + seed) - 0.5;
  float left = hash1(p + vec2(-1.0, 0.0) + seed) - 0.5;
  float up = hash1(p + vec2(0.0, -1.0) + seed) - 0.5;
  float diag = hash1(p + vec2(-1.0, -1.0) + seed) - 0.5;
  float center = mix(0.95, 0.62, character);
  float neighbor = mix(0.03, 0.20, character);
  return center * n + neighbor * (left + up) + neighbor * 0.45 * diag;
}

float worley(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d = 1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 n = vec2(float(x), float(y));
      vec2 pt = hash2(i + n);
      d = min(d, length(n + pt - f));
    }
  }
  return d;
}

float organicLayer(vec2 p, float seed, float character, float prickly) {
  vec2 offset = hash2(vec2(seed, seed * 1.37)) * 200.0;
  p += offset;

  float n = 0.0;
  float amp = 0.64;
  float freq = 1.0;
  for (int i = 0; i < 4; i++) {
    float ar = arGrain(p * freq, seed + float(i) * 13.13, character);
    float gr = gradNoise(p * freq * 0.83 + seed);
    n += amp * mix(gr, ar, 0.65 + character * 0.35);
    freq *= mix(1.75, 2.35, prickly);
    amp *= mix(0.46, 0.62, prickly);
  }
  return n;
}

float recipeNoise(vec2 p, float seed, float recipe, float character, float prickly) {
  float organic = organicLayer(p, seed, character, prickly);
  float fine = gaussianNoise(floor(p * mix(1.0, 1.7, prickly)), seed);

  float clump = worley(p * 0.48 + hash2(vec2(seed)) * 30.0);
  clump = (1.0 - smoothstep(0.12, 0.88, clump)) * 2.0 - 1.0;
  clump = mix(organic, clump, 0.48 + 0.35 * character);

  float saltSeed = hash1(floor(p * 1.15) + seed * 37.0);
  float threshold = mix(0.9975, 0.982, prickly);
  float salt = step(threshold, saltSeed) * sign(hash1(p + seed * 7.7) - 0.5);
  float biting = mix(fine, signedPow(fine, 0.54), 0.65) + salt * 1.75;

  if (recipe < 0.5) return organic;
  if (recipe < 1.5) return fine;
  if (recipe < 2.5) return clump;
  return biting;
}

vec3 applyPerformantOverlay(vec3 displayColor) {
  float scale = max(0.5, uPerfScale);
  vec2 jitter = (hash2(vec2(uSeed * 19.1, uSeed * 3.7)) - 0.5) * uPerfMotion * 180.0;
  vec2 p = floor((v_uv * uRes + jitter) / scale);

  float n = gaussianNoise(p, uSeed * 17.0 + 11.0);
  float saltSeed = hash1(p * 1.7 + uSeed * 31.0);
  float saltThreshold = mix(0.9992, 0.979, clamp(uPerfPrickliness, 0.0, 1.0));
  float salt = step(saltThreshold, saltSeed) * sign(hash1(p + uSeed * 71.0) - 0.5) * 1.75;
  n = signedPow(n, mix(1.85, 0.48, clamp(uPerfPrickliness, 0.0, 1.0))) + salt;

  float alphaShape = mix(1.9, 0.72, clamp(uPerfPrickliness, 0.0, 1.0));
  alphaShape = mix(alphaShape, 2.5, clamp(uPerfSoftness, 0.0, 1.0));
  float a = pow(clamp(abs(n) * max(0.05, uPerfContrast), 0.0, 1.0), alphaShape);
  a *= clamp(uPerfAmount, 0.0, 0.35);

  vec3 ink = n >= 0.0 ? vec3(1.0) : vec3(0.0);
  return mix(displayColor, ink, a);
}

void main() {
  vec3 linear = texture2D(uTex, v_uv).rgb;

  if (uMode > 0.5) {
    vec3 displayColor = toSRGB(linear);
    gl_FragColor = vec4(clamp(applyPerformantOverlay(displayColor), 0.0, 1.0), 1.0);
    return;
  }

  float y = dot(linear, vec3(0.2126, 0.7152, 0.0722));

  float iso01 = clamp(log2(max(uIso, 100.0) / 100.0) / 5.0, 0.0, 1.0);
  float resScale = max(0.5, uRes.y / 1080.0);
  float grainPitch = max(0.25, uSize * resScale);
  vec2 p = v_uv * uRes / grainPitch;

  float lumaNoise = recipeNoise(p, uSeed, uNoiseType, uCharacter, uPrickliness);
  float grit = signedPow(lumaNoise, mix(1.35, 0.55, uPrickliness));
  lumaNoise = mix(lumaNoise, grit, uPrickliness);

  vec3 chromaNoise = vec3(
    recipeNoise(p * 0.91 + vec2(17.1, 43.7), uSeed * 1.11 + 7.0, uNoiseType, uCharacter * 0.75, uPrickliness),
    recipeNoise(p * 0.88 + vec2(81.4, 12.9), uSeed * 1.23 + 19.0, uNoiseType, uCharacter * 0.75, uPrickliness),
    recipeNoise(p * 0.93 + vec2(35.8, 67.2), uSeed * 1.37 + 31.0, uNoiseType, uCharacter * 0.75, uPrickliness)
  );

  vec3 grain = mix(vec3(lumaNoise), chromaNoise, uChroma);

  float shadows = 1.0 - smoothstep(0.08, 0.55, y);
  float mids = 1.0 - pow(clamp(abs(y - 0.42) * 2.1, 0.0, 1.0), 1.35);
  float highs = smoothstep(0.62, 1.0, y);
  float response = mix(0.55, 1.15, mids);
  response *= 1.0 + shadows * uShadowBias * 0.85;
  response *= 1.0 - highs * uHighlightProtect * 0.82;

  float baseStrength = mix(0.006, 0.052, iso01);
  float strength = uAmount * baseStrength * response;

  vec3 densityScale = 0.55 + sqrt(max(linear, 0.0));
  vec3 grained = linear + grain * strength * densityScale;

  vec3 finalColor = toSRGB(grained);
  gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
}
`;

function uniform(gl, program, name) {
  return gl.getUniformLocation(program, name);
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

  apply(inputTex, outputFB, params, timeMs, frameSeed, canvasW, canvasH) {
    const gl = this.gl;
    const mode = Math.round(Number(params.grainMode) || 0);
    const amount = Math.max(0, Number(params.grainAmount) || 0);
    const perfAmount = Math.max(0, Number(params.performantGrainAmount) || 0);

    bindProgram(gl, this.program, this.quad, canvasW, canvasH);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(uniform(gl, this.program, 'uTex'), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB ? outputFB.fbo : null);

    const stableSeed = (Number(frameSeed) || 0) + Math.floor((Number(timeMs) || 0) * 0.0001) * 0.001;

    gl.uniform2f(uniform(gl, this.program, 'uRes'), canvasW, canvasH);
    gl.uniform1f(uniform(gl, this.program, 'uMode'), mode);

    gl.uniform1f(uniform(gl, this.program, 'uAmount'), amount);
    gl.uniform1f(uniform(gl, this.program, 'uIso'), Number(params.filmSpeed) || 400);
    gl.uniform1f(uniform(gl, this.program, 'uSize'), Math.max(0.25, Number(params.grainSize) || 1));
    gl.uniform1f(uniform(gl, this.program, 'uPrickliness'), Number(params.grainPrickliness) || 0);
    gl.uniform1f(uniform(gl, this.program, 'uCharacter'), Number(params.grainCharacter) || 0);
    gl.uniform1f(uniform(gl, this.program, 'uChroma'), Number(params.grainChroma) || 0);
    gl.uniform1f(uniform(gl, this.program, 'uShadowBias'), Number(params.grainShadowBias) || 0);
    gl.uniform1f(uniform(gl, this.program, 'uHighlightProtect'), Number(params.grainHighlightProtect) || 0);
    gl.uniform1f(uniform(gl, this.program, 'uNoiseType'), Math.round(Number(params.grainNoiseType) || 0));

    gl.uniform1f(uniform(gl, this.program, 'uPerfAmount'), perfAmount);
    gl.uniform1f(uniform(gl, this.program, 'uPerfScale'), Math.max(0.5, Number(params.performantGrainScale) || 1));
    gl.uniform1f(uniform(gl, this.program, 'uPerfContrast'), Math.max(0.05, Number(params.performantGrainContrast) || 1));
    gl.uniform1f(uniform(gl, this.program, 'uPerfPrickliness'), Number(params.performantGrainPrickliness) || 0);
    gl.uniform1f(uniform(gl, this.program, 'uPerfSoftness'), Number(params.performantGrainSoftness) || 0);
    gl.uniform1f(uniform(gl, this.program, 'uPerfMotion'), Number(params.performantGrainMotion) || 0);
    gl.uniform1f(uniform(gl, this.program, 'uSeed'), stableSeed);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}
