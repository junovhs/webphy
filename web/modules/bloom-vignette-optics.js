// Bloom, Vignette, and Optical Effects Module
// Bloom extraction, blur pyramid, vignette, chromatic aberration, clarity

import { compileShader, bindProgram } from '../gl-context.js';

export const BLOOM_VIGNETTE_OPTICS_PARAMS = {
  bloomThreshold: { min: 0.2, max: 1, step: 0.001, default: 0.358, label: 'Bloom Threshold' },
  bloomRadius: { min: 1, max: 60, step: 0.1, default: 11.2, label: 'Bloom Radius' },
  bloomIntensity: { min: 0, max: 3, step: 0.01, default: 0.45, label: 'Bloom Intensity' },
  bloomWarm: { min: 0, max: 1, step: 0.01, default: 0.0, label: 'Bloom Warmth' },
  halation: { min: 0, max: 2, step: 0.01, default: 0.60, label: 'Halation' },
  vignette: { min: 0, max: 0.5, step: 0.001, default: 0.0, label: 'Vignette' },
  vignettePower: { min: 1, max: 5, step: 0.01, default: 1.0, label: 'Vignette Power' },
  ca: { min: 0, max: 2, step: 0.01, default: 0.27, label: 'Chromatic Aberration' },
  clarity: { min: 0, max: 0.3, step: 0.01, default: 0.0, label: 'Clarity' }
};

const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0, 1);
}
`;

const COMMON = `
precision highp float;
varying vec2 v_uv;
uniform vec2 uRes;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

const BLOOM_EXTRACT_SHADER = COMMON + `
uniform sampler2D uTex;
uniform float uT, uWarm;
vec3 warm(float a) { return mix(vec3(1.0), vec3(1.15, 1.0, 0.88), a); }
void main() {
  vec3 c = texture2D(uTex, v_uv).rgb;
  float Y = luma(c);
  float m = clamp((Y - uT) / max(1e-5, 1.0 - uT), 0.0, 1.0);
  vec3 b = clamp(c, 0.0, 1.0) * m * warm(uWarm) * 1.5;
  gl_FragColor = vec4(b, 1.0);
}
`;

const DOWNSAMPLE_SHADER = COMMON + `
uniform sampler2D uTex;
uniform vec2 uTexel;
void main() {
  vec3 s = vec3(0.0);
  s += texture2D(uTex, v_uv + uTexel * vec2(-.5, -.5)).rgb;
  s += texture2D(uTex, v_uv + uTexel * vec2(.5, -.5)).rgb;
  s += texture2D(uTex, v_uv + uTexel * vec2(-.5, .5)).rgb;
  s += texture2D(uTex, v_uv + uTexel * vec2(.5, .5)).rgb;
  gl_FragColor = vec4(s * .25, 1.0);
}
`;

const BLUR_SHADER = COMMON + `
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uR;
void main() {
  vec3 s = vec3(0.0);
  float w[5];
  w[0] = 0.227027; w[1] = 0.1945946; w[2] = 0.1216216;
  w[3] = 0.054054; w[4] = 0.016216;
  vec2 st = uTexel * max(uR, 1.0);
  s += texture2D(uTex, v_uv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    s += texture2D(uTex, v_uv + st * float(i)).rgb * w[i];
    s += texture2D(uTex, v_uv - st * float(i)).rgb * w[i];
  }
  gl_FragColor = vec4(s, 1.0);
}
`;

const UPSAMPLE_ADD_SHADER = COMMON + `
uniform sampler2D uLow, uHigh;
uniform float uAdd;
void main() {
  vec3 low = texture2D(uLow, v_uv).rgb;
  vec3 hi = texture2D(uHigh, v_uv).rgb;
  gl_FragColor = vec4(hi + low * uAdd, 1.0);
}
`;

const BLOOM_COMPOSITE_SHADER = COMMON + `
uniform sampler2D uBase, uBloom;
uniform float uI, uHal;
vec3 screen(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }
void main() {
  vec3 base = texture2D(uBase, v_uv).rgb;
  vec3 bloom = texture2D(uBloom, v_uv).rgb;
  vec3 outc = screen(base, bloom * uI);
  vec3 hal = bloom * (uHal * 2.0) * vec3(1.0, 0.22, 0.07);
  // Previous fix: Ensure this shader doesn't output negative values
  gl_FragColor = vec4(max(outc + hal, 0.0), 1.0);
}
`;

const VIGNETTE_SHADER = COMMON + `
uniform sampler2D uTex;
uniform float uV, uP;
void main() {
  vec2 ac = vec2(uRes.x / uRes.y, 1.0);
  float r = length((v_uv - 0.5) * ac);
  float v = pow(r, uP);
  gl_FragColor = vec4(texture2D(uTex, v_uv).rgb * (1.0 - uV * v), 1.0);
}
`;

const CLARITY_SHADER = COMMON + `
uniform sampler2D uTex;
uniform vec2 uPx;
uniform float uAmt;
vec3 blur9(vec2 uv) {
  vec3 s = vec3(0.0);
  float w[5];
  w[0] = 0.227027; w[1] = 0.1945946; w[2] = 0.1216216;
  w[3] = 0.054054; w[4] = 0.016216;
  s += texture2D(uTex, uv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    s += texture2D(uTex, uv + uPx * float(i)).rgb * w[i];
    s += texture2D(uTex, uv - uPx * float(i)).rgb * w[i];
  }
  return s;
}
void main() {
  vec3 c = texture2D(uTex, v_uv).rgb;
  vec3 b = blur9(v_uv);
  vec3 hi = c - b;
  c += hi * uAmt * 2.0;
  // *** DEFINITIVE FIX: Ensure the clarity calculation never results in a negative color ***
  gl_FragColor = vec4(max(c, 0.0), 1.0);
}
`;

const CA_SHADER = COMMON + `
uniform sampler2D uTex;
uniform vec2 uPx;
uniform float uCA;
void main() {
  vec2 ac = vec2(uRes.x / uRes.y, 1.0);
  vec2 dir = normalize((v_uv - 0.5) * ac);
  dir = mix(vec2(1.0, 0.0), dir, step(0.0001, length(dir)));
  vec2 d = dir * uPx * uCA;
  vec3 c;
  c.r = texture2D(uTex, v_uv + d).r;
  c.g = texture2D(uTex, v_uv).g;
  c.b = texture2D(uTex, v_uv - d).b;
  gl_FragColor = vec4(c, 1.0);
}
`;

export class BloomVignetteOpticsModule {
  constructor(gl, quad) {
    this.gl = gl;
    this.quad = quad;
    
    this.programs = {
      bloomExtract: this.createProgram(BLOOM_EXTRACT_SHADER),
      downsample: this.createProgram(DOWNSAMPLE_SHADER),
      blur: this.createProgram(BLUR_SHADER),
      upsampleAdd: this.createProgram(UPSAMPLE_ADD_SHADER),
      bloomComposite: this.createProgram(BLOOM_COMPOSITE_SHADER),
      vignette: this.createProgram(VIGNETTE_SHADER),
      clarity: this.createProgram(CLARITY_SHADER),
      ca: this.createProgram(CA_SHADER)
    };
  }
  
  createProgram(fragSource) {
    const gl = this.gl;
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
    
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      return null;
    }
    
    return program;
  }
  
  extractBright(inputTex, outputFB, threshold, warmth, canvasW, canvasH) {
    const gl = this.gl;
    const prog = this.programs.bloomExtract;
    
    bindProgram(gl, prog, this.quad, canvasW, canvasH);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB ? outputFB.fbo : null);
    
    gl.uniform1f(gl.getUniformLocation(prog, 'uT'), threshold);
    gl.uniform1f(gl.getUniformLocation(prog, 'uWarm'), warmth);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  
  downsample(inputTex, inputW, inputH, outputFB, canvasW, canvasH) {
    const gl = this.gl;
    const prog = this.programs.downsample;
    
    bindProgram(gl, prog, this.quad, canvasW, canvasH);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB ? outputFB.fbo : null);
    
    gl.uniform2f(gl.getUniformLocation(prog, 'uTexel'), 1 / inputW, 1 / inputH);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  
  blurHorizontalVertical(srcFB, dstFB, radius, canvasW, canvasH) {
    const gl = this.gl;
    const prog = this.programs.blur;
    
    bindProgram(gl, prog, this.quad, canvasW, canvasH);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcFB.tex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFB.fbo);
    gl.uniform2f(gl.getUniformLocation(prog, 'uTexel'), 1 / srcFB.w, 0);
    gl.uniform1f(gl.getUniformLocation(prog, 'uR'), radius);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    
    bindProgram(gl, prog, this.quad, canvasW, canvasH);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dstFB.tex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, srcFB.fbo);
    gl.uniform2f(gl.getUniformLocation(prog, 'uTexel'), 0, 1 / srcFB.h);
    gl.uniform1f(gl.getUniformLocation(prog, 'uR'), radius);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  
  upsampleAdd(lowTex, highTex, outputFB, canvasW, canvasH) {
    const gl = this.gl;
    const prog = this.programs.upsampleAdd;
    
    bindProgram(gl, prog, this.quad, canvasW, canvasH);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, lowTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uLow'), 0);
    
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, highTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uHigh'), 1);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB ? outputFB.fbo : null);
    
    gl.uniform1f(gl.getUniformLocation(prog, 'uAdd'), 1.0);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  
  compositeBloom(baseTex, bloomTex, outputFB, intensity, halation, canvasW, canvasH) {
    const gl = this.gl;
    const prog = this.programs.bloomComposite;
    
    bindProgram(gl, prog, this.quad, canvasW, canvasH);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, baseTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uBase'), 0);
    
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uBloom'), 1);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB ? outputFB.fbo : null);
    
    gl.uniform1f(gl.getUniformLocation(prog, 'uI'), intensity);
    gl.uniform1f(gl.getUniformLocation(prog, 'uHal'), halation);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  
  applyVignette(inputTex, outputFB, amount, power, canvasW, canvasH) {
    const gl = this.gl;
    const prog = this.programs.vignette;
    
    bindProgram(gl, prog, this.quad, canvasW, canvasH);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB ? outputFB.fbo : null);
    
    gl.uniform1f(gl.getUniformLocation(prog, 'uV'), amount);
    gl.uniform1f(gl.getUniformLocation(prog, 'uP'), power);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  
  applyClarity(inputTex, outputFB, amount, pxX, pxY, canvasW, canvasH) {
    const gl = this.gl;
    const prog = this.programs.clarity;
    
    bindProgram(gl, prog, this.quad, canvasW, canvasH);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB ? outputFB.fbo : null);
    
    gl.uniform2f(gl.getUniformLocation(prog, 'uPx'), pxX, pxY);
    gl.uniform1f(gl.getUniformLocation(prog, 'uAmt'), amount);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  
  applyChromaticAberration(inputTex, outputFB, amount, pxX, pxY, canvasW, canvasH) {
    const gl = this.gl;
    const prog = this.programs.ca;
    
    bindProgram(gl, prog, this.quad, canvasW, canvasH);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB ? outputFB.fbo : null);
    
    gl.uniform2f(gl.getUniformLocation(prog, 'uPx'), pxX, pxY);
    gl.uniform1f(gl.getUniformLocation(prog, 'uCA'), amount);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}