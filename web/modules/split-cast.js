// Split Toning and Color Cast Module
// Shadow/highlight split toning + green shadows/magenta mids

import { compileShader, bindProgram } from '../gl-context.js';

export const SPLIT_CAST_PARAMS = {
  shadowCool: { min: 0, max: 1, step: 0.01, default: 0.0, label: 'Shadow Cool' },
  highlightWarm: { min: 0, max: 1, step: 0.01, default: 0.0, label: 'Highlight Warm' },
  greenShadows: { min: 0, max: 1, step: 0.01, default: 0.16, label: 'Green Shadows' },
  magentaMids: { min: 0, max: 1, step: 0.01, default: 0.13, label: 'Magenta Mids' }
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

const SPLIT_SHADER = COMMON + `
uniform sampler2D uTex;
uniform float uSh, uHi;
void main() {
  vec3 c = texture2D(uTex, v_uv).rgb;
  float Y = luma(c);
  float wS = 1.0 - smoothstep(0.18, 0.55, Y);
  float wH = smoothstep(0.5, 0.9, Y);
  vec3 sh = mix(vec3(1.0), vec3(0.95, 1.08, 1.15), uSh);
  vec3 hi = mix(vec3(1.0), vec3(1.15, 1.00, 0.90), uHi);
  c *= mix(vec3(1.0), sh, wS);
  c *= mix(vec3(1.0), hi, wH);
  gl_FragColor = vec4(c, 1.0);
}
`;

const CAST_SHADER = COMMON + `
uniform sampler2D uTex;
uniform float uGS, uMM;
void main() {
  vec3 c = texture2D(uTex, v_uv).rgb;
  float Y = luma(c);
  float wS = 1.0 - smoothstep(0.18, 0.55, Y);
  float wM = smoothstep(0.20, 0.60, Y) * (1.0 - smoothstep(0.60, 0.90, Y));
  c *= mix(vec3(1.0), vec3(0.80, 1.25, 0.82), uGS * wS);
  c *= mix(vec3(1.0), vec3(1.22, 0.80, 1.22), uMM * wM);
  gl_FragColor = vec4(c, 1.0);
}
`;

export class SplitCastModule {
  constructor(gl, quad) {
    this.gl = gl;
    this.quad = quad;
    this.splitProgram = this.createProgram(SPLIT_SHADER);
    this.castProgram = this.createProgram(CAST_SHADER);
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
  
  applySplit(inputTex, outputFB, params, canvasW, canvasH) {
    const gl = this.gl;
    
    bindProgram(gl, this.splitProgram, this.quad, canvasW, canvasH);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(this.splitProgram, 'uTex'), 0);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB ? outputFB.fbo : null);
    
    gl.uniform1f(gl.getUniformLocation(this.splitProgram, 'uSh'), params.shadowCool);
    gl.uniform1f(gl.getUniformLocation(this.splitProgram, 'uHi'), params.highlightWarm);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  
  applyCast(inputTex, outputFB, params, canvasW, canvasH) {
    const gl = this.gl;
    
    bindProgram(gl, this.castProgram, this.quad, canvasW, canvasH);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(this.castProgram, 'uTex'), 0);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB ? outputFB.fbo : null);
    
    gl.uniform1f(gl.getUniformLocation(this.castProgram, 'uGS'), params.greenShadows);
    gl.uniform1f(gl.getUniformLocation(this.castProgram, 'uMM'), params.magentaMids);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}