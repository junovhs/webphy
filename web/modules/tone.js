// Tone Curve Module
// S-curve, black crush, lifted blacks, highlight rolloff

import { compileShader, bindProgram } from '../gl-context.js';

export const TONE_PARAMS = {
  scurve: { min: 0, max: 1, step: 0.01, default: 0.0, label: 'S-curve' },
  blacks: { min: 0, max: 0.15, step: 0.001, default: 0.011, label: 'Black Crush' },
  blackLift: { min: 0, max: 0.15, step: 0.001, default: 0.048, label: 'Lifted Blacks' },
  knee: { min: 0, max: 0.25, step: 0.001, default: 0.082, label: 'Highlight Knee' }
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

const TONE_SHADER = COMMON + `
uniform sampler2D uTex;
uniform float uSc, uBl, uKnee, uLift;

vec3 s(vec3 x) { return mix(x, x * x * (3.0 - 2.0 * x), uSc); }
vec3 crush(vec3 x) { return max(vec3(0.0), x - uBl) / (1.0 - uBl + 1e-6); }
vec3 lift(vec3 x) { return x * (1.0 - uLift) + vec3(uLift); }
vec3 shoulder(vec3 x) {
  vec3 t = clamp(x, 0.0, 1.0);
  return 1.0 - pow(1.0 - t, vec3(1.0 + 5.0 * uKnee));
}

void main() {
  vec3 c = texture2D(uTex, v_uv).rgb;
  c = s(c);
  c = crush(c);
  c = lift(c);
  c = shoulder(c);
  gl_FragColor = vec4(c, 1.0);
}
`;

export class ToneModule {
  constructor(gl, quad) {
    this.gl = gl;
    this.quad = quad;
    this.program = this.createProgram();
  }
  
  createProgram() {
    const gl = this.gl;
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, TONE_SHADER);
    
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Tone program link error:', gl.getProgramInfoLog(program));
      return null;
    }
    
    return program;
  }
  
  apply(inputTex, outputFB, params, canvasW, canvasH) {
    const gl = this.gl;
    
    bindProgram(gl, this.program, this.quad, canvasW, canvasH);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uTex'), 0);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB ? outputFB.fbo : null);
    
    gl.uniform1f(gl.getUniformLocation(this.program, 'uSc'), params.scurve);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uBl'), params.blacks);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uKnee'), params.knee);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uLift'), params.blackLift);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}