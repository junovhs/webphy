// Exposure and Flash Module
// Everything related to exposure and flash effects in one place

import { compileShader, bindProgram } from '../gl-context.js';

export const EXPOSURE_FLASH_PARAMS = {
  ev: { min: -1, max: 0.5, step: 0.01, default: -0.04, label: 'Exposure (EV)' },
  flashStrength: { min: 0, max: 2.0, step: 0.01, default: 0.28, label: 'Flash Strength' },
  flashFalloff: { min: 0.5, max: 10, step: 0.01, default: 6.72, label: 'Flash Falloff' }
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
vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSRGB(vec3 c) { return pow(max(c, 0.0), vec3(1.0/2.2)); }
`;

const EXPOSURE_SHADER = COMMON + `
uniform sampler2D uTex;
uniform float uEV;
void main() {
  vec3 c = toLin(texture2D(uTex, v_uv).rgb) * exp2(uEV);
  gl_FragColor = vec4(c, 1.0);
}
`;

const FLASH_SHADER = COMMON + `
uniform sampler2D uTex;
uniform vec2 uCenter;
uniform float uStrength, uFall;
void main() {
  vec3 c = texture2D(uTex, v_uv).rgb;
  vec2 ac = vec2(uRes.x / uRes.y, 1.0);
  float r = length((v_uv - uCenter) * ac);
  float m = 1.0 / (1.0 + pow(max(0.0, uFall) * r, 2.0));
  c *= (1.0 + uStrength * m);
  gl_FragColor = vec4(c, 1.0);
}
`;

export class ExposureFlashModule {
  constructor(gl, quad) {
    this.gl = gl;
    this.quad = quad;
    
    this.exposureProgram = this.createProgram(EXPOSURE_SHADER);
    this.flashProgram = this.createProgram(FLASH_SHADER);
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
  
  drawQuad(program, textures, target, uniforms, canvasW, canvasH) {
    const gl = this.gl;
    
    bindProgram(gl, program, this.quad, canvasW, canvasH);
    
    let unit = 0;
    for (const [name, tex] of Object.entries(textures || {})) {
      const loc = gl.getUniformLocation(program, name);
      gl.activeTexture(gl[`TEXTURE${unit}`]);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, unit);
      unit++;
    }
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    
    if (uniforms) uniforms(program);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  
  applyExposure(inputTex, outputFB, ev, canvasW, canvasH) {
    this.drawQuad(
      this.exposureProgram,
      { uTex: inputTex },
      outputFB,
      (p) => {
        this.gl.uniform1f(this.gl.getUniformLocation(p, 'uEV'), ev);
      },
      canvasW,
      canvasH
    );
  }
  
  applyFlash(inputTex, outputFB, params, canvasW, canvasH) {
    this.drawQuad(
      this.flashProgram,
      { uTex: inputTex },
      outputFB,
      (p) => {
        this.gl.uniform2f(this.gl.getUniformLocation(p, 'uCenter'),
          1.0 - params.centerX, params.centerY);
        this.gl.uniform1f(this.gl.getUniformLocation(p, 'uStrength'), params.strength);
        this.gl.uniform1f(this.gl.getUniformLocation(p, 'uFall'), params.falloff);
      },
      canvasW,
      canvasH
    );
  }
}