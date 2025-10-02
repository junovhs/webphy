// Motion Blur Module
// Directional blur with shutter speed simulation

import { compileShader, bindProgram } from '../gl-context.js';

export const MOTION_BLUR_PARAMS = {
  shutterUI: { min: 0, max: 1, step: 0.001, default: 0.15, label: 'Shutter', special: 'shutter' }, // 1/139 ≈ 0.348 on slider
  shake: { min: 0, max: 1, step: 0.01, default: 0.5, label: 'Shake' },
  motionAngle: { min: 0, max: 180, step: 1, default: 0, label: 'Trail Angle (°)' }
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
`;

const MOTION_SHADER = COMMON + `
uniform sampler2D uTex;
uniform vec2 uPx;
uniform float uAmt, uAng, uShake;
void main() {
  vec2 dir = vec2(cos(uAng), sin(uAng));
  const int N = 24;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N - 1) - 0.5;
    float w1 = sin(6.28318 * 2.7 * t + 1.7);
    float w2 = sin(6.28318 * 4.9 * t + 5.1);
    vec2 wig = uShake * 0.25 * vec2(w1, w2);
    acc += texture2D(uTex, v_uv + (dir * t + wig) * uAmt * uPx).rgb;
  }
  gl_FragColor = vec4(acc / float(N), 1.0);
}
`;

// Shutter speed conversion utilities
export function sliderToShutterSeconds(v) {
  const sMin = 1 / 250, sMax = 0.5;
  return Math.pow(sMax / sMin, v) * sMin;
}

export function formatShutter(s) {
  return s >= 1 ? `${s.toFixed(1)}s` : `1/${Math.round(1 / s)}`;
}

export function shutterToPixels(shutterSeconds, shake01) {
  const sMin = 1 / 250, sMax = 0.5;
  const t = Math.log(shutterSeconds / sMin) / Math.log(sMax / sMin);
  const base = 0.5 + 26.0 * Math.pow(t, 0.85);
  return base * (0.2 + 1.2 * shake01);
}

export class MotionBlurModule {
  constructor(gl, quad) {
    this.gl = gl;
    this.quad = quad;
    this.program = this.createProgram();
  }
  
  createProgram() {
    const gl = this.gl;
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, MOTION_SHADER);
    
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Motion blur program link error:', gl.getProgramInfoLog(program));
      return null;
    }
    
    return program;
  }
  
  apply(inputTex, outputFB, params, pxX, pxY, canvasW, canvasH) {
    const gl = this.gl;
    
    bindProgram(gl, this.program, this.quad, canvasW, canvasH);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uTex'), 0);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB ? outputFB.fbo : null);
    
    gl.uniform2f(gl.getUniformLocation(this.program, 'uPx'), pxX, pxY);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uAmt'), params.amount);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uAng'), params.angle * Math.PI / 180);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uShake'), params.shake);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}