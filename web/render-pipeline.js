import { ensureFramebuffer, compileShader, bindProgram } from './gl-context.js';
import { ExposureFlashModule } from './modules/exposure-flash.js';
import { ToneModule } from './modules/tone.js';
import { SplitCastModule } from './modules/split-cast.js';
import { BloomVignetteOpticsModule } from './modules/bloom-vignette-optics.js';
import { MotionBlurModule, sliderToShutterSeconds, shutterToPixels } from './modules/motion-blur.js';
import { HandheldCameraModule } from './modules/handheld-camera.js';
import { FilmGrainModule } from './modules/film-grain.js';

const EPS = 0.0005;

const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const COPY_SHADER = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D uTex;
void main() {
  gl_FragColor = vec4(texture2D(uTex, v_uv).rgb, 1.0);
}
`;

const DISPLAY_SHADER = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D uTex;
vec3 toSRGB(vec3 l) {
  l = max(l, 0.0);
  return mix(l * 12.92, pow(l, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, l));
}
void main() {
  gl_FragColor = vec4(clamp(toSRGB(texture2D(uTex, v_uv).rgb), 0.0, 1.0), 1.0);
}
`;

function absActive(value) {
  return Math.abs(Number(value) || 0) > EPS;
}

function posActive(value) {
  return (Number(value) || 0) > EPS;
}

function createProgram(gl, fragSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Render pipeline program link error:', gl.getProgramInfoLog(program));
    return null;
  }

  return program;
}

export function isGrainActive(state) {
  const mode = Math.round(Number(state.grainMode) || 0);
  return mode === 1 ? posActive(state.performantGrainAmount) : posActive(state.grainAmount);
}

export function stillGrainFrameSeed(state, timeMs) {
  if (!isGrainActive(state)) return 0;

  const mode = Math.round(Number(state.grainMode) || 0);
  if (mode === 1) {
    const fps = Math.max(1, Math.min(30, Number(state.performantGrainFps) || 12));
    return Math.floor((Number(timeMs) || 0) * 0.001 * fps);
  }

  if (Number(state.grainAnimateStill) < 0.5) return 0;
  const fps = Math.max(1, Math.min(60, Number(state.grainFps) || 24));
  return Math.floor((Number(timeMs) || 0) * 0.001 * fps);
}

export function isPipelineActive(state) {
  const bloomActive = posActive(state.bloomIntensity) || posActive(state.halation);

  return (
    absActive(state.ev) ||
    posActive(state.flashStrength) ||
    posActive(state.shutterUI) ||
    posActive(state.shakeHandheld) ||
    bloomActive ||
    posActive(state.scurve) ||
    posActive(state.blacks) ||
    posActive(state.blackLift) ||
    posActive(state.knee) ||
    posActive(state.shadowCool) ||
    posActive(state.highlightWarm) ||
    posActive(state.greenShadows) ||
    posActive(state.magentaMids) ||
    posActive(state.vignette) ||
    posActive(state.ca) ||
    posActive(state.clarity) ||
    isGrainActive(state)
  );
}

export class RenderPipeline {
  constructor(gl, quad, caps) {
    this.gl = gl;
    this.quad = quad;
    this.caps = caps;

    this.exposureFlash = new ExposureFlashModule(gl, quad);
    this.tone = new ToneModule(gl, quad);
    this.splitCast = new SplitCastModule(gl, quad);
    this.bloomVignetteOptics = new BloomVignetteOpticsModule(gl, quad);
    this.motionBlur = new MotionBlurModule(gl, quad);
    this.handheldCamera = new HandheldCameraModule(gl, quad);
    this.filmGrain = new FilmGrainModule(gl, quad);

    this.copyProgram = createProgram(gl, COPY_SHADER);
    this.displayProgram = createProgram(gl, DISPLAY_SHADER);
  }

  ensure(width, height) {
    const W = Math.max(1, width | 0);
    const H = Math.max(1, height | 0);
    this.rtA = ensureFramebuffer(this.rtA, this.gl, this.caps, W, H);
    this.rtB = ensureFramebuffer(this.rtB, this.gl, this.caps, W, H);
    this.rtH_A = ensureFramebuffer(this.rtH_A, this.gl, this.caps, W >> 1 || 1, H >> 1 || 1);
    this.rtH_B = ensureFramebuffer(this.rtH_B, this.gl, this.caps, W >> 1 || 1, H >> 1 || 1);
    this.rtQ_A = ensureFramebuffer(this.rtQ_A, this.gl, this.caps, W >> 2 || 1, H >> 2 || 1);
    this.rtQ_B = ensureFramebuffer(this.rtQ_B, this.gl, this.caps, W >> 2 || 1, H >> 2 || 1);
    this.rtE_A = ensureFramebuffer(this.rtE_A, this.gl, this.caps, W >> 3 || 1, H >> 3 || 1);
    this.rtE_B = ensureFramebuffer(this.rtE_B, this.gl, this.caps, W >> 3 || 1, H >> 3 || 1);
    this.rtBloom = ensureFramebuffer(this.rtBloom, this.gl, this.caps, W, H);
  }

  ping(currentTex) {
    return currentTex === this.rtA.tex ? this.rtB : this.rtA;
  }

  drawTexture(inputTex, outputFB, width, height, encodeDisplay = false) {
    const gl = this.gl;
    const program = encodeDisplay ? this.displayProgram : this.copyProgram;
    bindProgram(gl, program, this.quad, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB ? outputFB.fbo : null);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  render(sourceTex, state, options = {}) {
    const width = Math.max(1, options.width | 0);
    const height = Math.max(1, options.height | 0);
    const target = options.target ?? null;
    const timeMs = options.timeMs ?? 0;
    const frameSeed = options.frameSeed ?? 0;
    const forceProcessing = !!options.forceProcessing;

    this.ensure(width, height);

    if (!forceProcessing && !isPipelineActive(state)) {
      this.drawTexture(sourceTex, target, width, height, false);
      return;
    }

    const pxX = 1 / width;
    const pxY = 1 / height;

    this.exposureFlash.applyExposure(sourceTex, this.rtA, Number(state.ev) || 0, width, height);
    let currentTex = this.rtA.tex;

    if (posActive(state.shakeHandheld)) {
      const shakeDst = this.ping(currentTex);
      this.handheldCamera.apply(currentTex, shakeDst, state, frameSeed, width, height);
      currentTex = shakeDst.tex;
    }

    const shutterSeconds = sliderToShutterSeconds(Number(state.shutterUI) || 0);
    const motionAmt = shutterToPixels(shutterSeconds, Number(state.shake) || 0);
    if (motionAmt > 0.05) {
      const motionDst = this.ping(currentTex);
      this.motionBlur.apply(
        currentTex,
        motionDst,
        { amount: motionAmt, angle: Number(state.motionAngle) || 0, shake: Number(state.shake) || 0 },
        pxX,
        pxY,
        width,
        height,
      );
      currentTex = motionDst.tex;
    }

    if (posActive(state.flashStrength)) {
      const flashDst = this.ping(currentTex);
      this.exposureFlash.applyFlash(
        currentTex,
        flashDst,
        {
          centerX: Number(state.flashCenterX) || 0.5,
          centerY: Number(state.flashCenterY) || 0.5,
          strength: Number(state.flashStrength) || 0,
          falloff: Number(state.flashFalloff) || 5,
        },
        width,
        height,
      );
      currentTex = flashDst.tex;
    }

    const bloomActive = posActive(state.bloomIntensity) || posActive(state.halation);
    if (bloomActive) {
      const brightDst = this.ping(currentTex);
      this.bloomVignetteOptics.extractBright(
        currentTex,
        brightDst,
        Number(state.bloomThreshold) || 0.8,
        Number(state.bloomWarm) || 0,
        width,
        height,
      );
      this.bloomVignetteOptics.downsample(brightDst.tex, brightDst.w, brightDst.h, this.rtH_A, width, height);
      this.bloomVignetteOptics.downsample(this.rtH_A.tex, this.rtH_A.w, this.rtH_A.h, this.rtQ_A, width, height);
      this.bloomVignetteOptics.downsample(this.rtQ_A.tex, this.rtQ_A.w, this.rtQ_A.h, this.rtE_A, width, height);
      this.bloomVignetteOptics.blurHorizontalVertical(this.rtE_A, this.rtE_B, (Number(state.bloomRadius) || 10) * 0.6, width, height);
      this.bloomVignetteOptics.blurHorizontalVertical(this.rtQ_A, this.rtQ_B, (Number(state.bloomRadius) || 10) * 0.8, width, height);
      this.bloomVignetteOptics.blurHorizontalVertical(this.rtH_A, this.rtH_B, (Number(state.bloomRadius) || 10) * 1.0, width, height);
      this.bloomVignetteOptics.upsampleAdd(this.rtE_A.tex, this.rtQ_A.tex, this.rtQ_B, width, height);
      this.bloomVignetteOptics.upsampleAdd(this.rtQ_B.tex, this.rtH_A.tex, this.rtH_B, width, height);
      this.bloomVignetteOptics.upsampleAdd(this.rtH_B.tex, brightDst.tex, this.rtBloom, width, height);
    }

    if (posActive(state.scurve) || posActive(state.blacks) || posActive(state.blackLift) || posActive(state.knee)) {
      const toneDst = this.ping(currentTex);
      this.tone.apply(
        currentTex,
        toneDst,
        {
          scurve: Number(state.scurve) || 0,
          blacks: Number(state.blacks) || 0,
          knee: Number(state.knee) || 0,
          blackLift: Number(state.blackLift) || 0,
        },
        width,
        height,
      );
      currentTex = toneDst.tex;
    }

    if (posActive(state.shadowCool) || posActive(state.highlightWarm)) {
      const splitDst = this.ping(currentTex);
      this.splitCast.applySplit(
        currentTex,
        splitDst,
        { shadowCool: Number(state.shadowCool) || 0, highlightWarm: Number(state.highlightWarm) || 0 },
        width,
        height,
      );
      currentTex = splitDst.tex;
    }

    if (posActive(state.greenShadows) || posActive(state.magentaMids)) {
      const castDst = this.ping(currentTex);
      this.splitCast.applyCast(
        currentTex,
        castDst,
        { greenShadows: Number(state.greenShadows) || 0, magentaMids: Number(state.magentaMids) || 0 },
        width,
        height,
      );
      currentTex = castDst.tex;
    }

    if (posActive(state.vignette)) {
      const vigDst = this.ping(currentTex);
      this.bloomVignetteOptics.applyVignette(
        currentTex,
        vigDst,
        Number(state.vignette) || 0,
        Number(state.vignettePower) || 1,
        width,
        height,
      );
      currentTex = vigDst.tex;
    }

    if (bloomActive) {
      const bloomCompDst = this.ping(currentTex);
      this.bloomVignetteOptics.compositeBloom(
        currentTex,
        this.rtBloom.tex,
        bloomCompDst,
        Number(state.bloomIntensity) || 0,
        Number(state.halation) || 0,
        width,
        height,
      );
      currentTex = bloomCompDst.tex;
    }

    if (posActive(state.clarity)) {
      const clarDst = this.ping(currentTex);
      this.bloomVignetteOptics.applyClarity(currentTex, clarDst, Number(state.clarity) || 0, pxX, pxY, width, height);
      currentTex = clarDst.tex;
    }

    if (posActive(state.ca)) {
      const caDst = this.ping(currentTex);
      this.bloomVignetteOptics.applyChromaticAberration(currentTex, caDst, Number(state.ca) || 0, pxX, pxY, width, height);
      currentTex = caDst.tex;
    }

    if (isGrainActive(state)) {
      this.filmGrain.apply(currentTex, target, state, timeMs, frameSeed, width, height);
    } else {
      this.drawTexture(currentTex, target, width, height, true);
    }
  }
}
