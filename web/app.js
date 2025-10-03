// Main application - now just wires things together via the API

import { initGL, getCapabilities, createQuadBuffer, ensureFramebuffer, compileShader, bindProgram } from './gl-context.js';
import { ExposureFlashModule, EXPOSURE_FLASH_PARAMS } from './modules/exposure-flash.js';
import { ToneModule, TONE_PARAMS } from './modules/tone.js';
import { SplitCastModule, SPLIT_CAST_PARAMS } from './modules/split-cast.js';
import { BloomVignetteOpticsModule, BLOOM_VIGNETTE_OPTICS_PARAMS } from './modules/bloom-vignette-optics.js';
import { MotionBlurModule, MOTION_BLUR_PARAMS, sliderToShutterSeconds, shutterToPixels } from './modules/motion-blur.js';
import { HandheldCameraModule, HANDHELD_PARAMS } from './modules/handheld-camera.js';
import { FilmGrainModule, GRAIN_PARAMS } from './modules/film-grain.js';
import { createUIAPI } from './ui-api.js';
import { initUI } from './ui.js';
import { initMedia } from './media.js';
import { initExport } from './export.js';

const $ = s => document.querySelector(s);

// Collect all parameters
const ALL_PARAMS = {
  ...EXPOSURE_FLASH_PARAMS,
  ...TONE_PARAMS,
  ...SPLIT_CAST_PARAMS,
  ...BLOOM_VIGNETTE_OPTICS_PARAMS,
  ...MOTION_BLUR_PARAMS,
  ...HANDHELD_PARAMS,
  ...GRAIN_PARAMS
};

// State - initialize with base values and parameter defaults
const state = {
  mediaW: 960,
  mediaH: 540,
  dpr: Math.min(2, devicePixelRatio || 1),
  tex: null,
  isVideo: false,
  frameSeed: 0,
  flashCenterX: 0.5,
  flashCenterY: 0.5,
  viewMode: 'fit',
  panX: null,
  panY: null,
  zoomScale: 1.0, // To store the current scale in 1:1 mode
  needsRender: true,
  showOriginal: false
};

// Initialize state with parameter defaults
for (const [key, config] of Object.entries(ALL_PARAMS)) {
  state[key] = config.default;
}

// WebGL setup
const canvas = $('#gl');
const gl = initGL(canvas);
if (!gl) throw new Error('WebGL failed');

const caps = getCapabilities(gl);
const quad = createQuadBuffer(gl);

// Modules
const exposureFlash = new ExposureFlashModule(gl, quad);
const tone = new ToneModule(gl, quad);
const splitCast = new SplitCastModule(gl, quad);
const bloomVignetteOptics = new BloomVignetteOpticsModule(gl, quad);
const motionBlur = new MotionBlurModule(gl, quad);
const handheldCamera = new HandheldCameraModule(gl, quad);
const filmGrain = new FilmGrainModule(gl, quad);

// Copy shader
const vs = compileShader(gl, gl.VERTEX_SHADER, `attribute vec2 a_pos; varying vec2 v_uv; void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0, 1); }`);
const fs = compileShader(gl, gl.FRAGMENT_SHADER, `precision highp float; varying vec2 v_uv; uniform sampler2D uTex; void main() { gl_FragColor = vec4(texture2D(uTex, v_uv).rgb, 1.0); }`);
const copyProgram = gl.createProgram();
gl.attachShader(copyProgram, vs);
gl.attachShader(copyProgram, fs);
gl.linkProgram(copyProgram);

// Render targets
let rtA, rtB, rtH_A, rtH_B, rtQ_A, rtQ_B, rtE_A, rtE_B, rtBloom;

function ensureRenderTargets() {
  const W = canvas.width | 0, H = canvas.height | 0;
  rtA = ensureFramebuffer(rtA, gl, caps, W, H);
  rtB = ensureFramebuffer(rtB, gl, caps, W, H);
  rtH_A = ensureFramebuffer(rtH_A, gl, caps, W >> 1 || 1, H >> 1 || 1);
  rtH_B = ensureFramebuffer(rtH_B, gl, caps, W >> 1 || 1, H >> 1 || 1);
  rtQ_A = ensureFramebuffer(rtQ_A, gl, caps, W >> 2 || 1, H >> 2 || 1);
  rtQ_B = ensureFramebuffer(rtQ_B, gl, caps, W >> 2 || 1, H >> 2 || 1);
  rtE_A = ensureFramebuffer(rtE_A, gl, caps, W >> 3 || 1, H >> 3 || 1);
  rtE_B = ensureFramebuffer(rtE_B, gl, caps, W >> 3 || 1, H >> 3 || 1);
  rtBloom = ensureFramebuffer(rtBloom, gl, caps, W, H);
}

function layout() {
    const wrapper = $('#player-wrapper');
    const container = $('#viewer');

    if (!state.mediaW || !state.mediaH || !wrapper || !container) return;

    const computedStyle = getComputedStyle(container);
    const cW = container.clientWidth - parseFloat(computedStyle.paddingLeft) - parseFloat(computedStyle.paddingRight);
    const cH = container.clientHeight - parseFloat(computedStyle.paddingTop) - parseFloat(computedStyle.paddingBottom);
    
    const transportHeight = state.isVideo ? (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--transport-height')) || 64) : 0;
    const availableH = Math.max(0, cH); // Full container height for wrapper
    
    const scaleFit = Math.min(cW / state.mediaW, (availableH - transportHeight) / state.mediaH);
    const fitW = Math.round(state.mediaW * scaleFit);
    const fitH = Math.round(state.mediaH * scaleFit);

    wrapper.style.width = `${fitW}px`;
    wrapper.style.height = `${fitH + transportHeight}px`;
    canvas.style.height = `${fitH}px`;

    if (state.viewMode === 'fit') {
        state.zoomScale = 1.0;
        state.panX = state.panY = null;
        canvas.style.transform = 'translate(0, 0) scale(1)';
        
        const targetW = Math.round(fitW * state.dpr);
        const targetH = Math.round(fitH * state.dpr);
        if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
            ensureRenderTargets();
        }
        gl.viewport(0, 0, targetW, targetH);
    } else { // 1:1 Mode
        state.zoomScale = state.mediaW / fitW;

        const targetW = Math.round(state.mediaW * state.dpr);
        const targetH = Math.round(state.mediaH * state.dpr);
        if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
            ensureRenderTargets();
        }
        gl.viewport(0, 0, targetW, targetH);
        
        if (state.panX === null || state.panY === null) {
            state.panX = 0;
            state.panY = 0;
        }

        const maxPanX = (state.zoomScale - 1) * fitW / 2;
        const maxPanY = (state.zoomScale - 1) * fitH / 2;

        state.panX = Math.max(-maxPanX, Math.min(maxPanX, state.panX));
        state.panY = Math.max(-maxPanY, Math.min(maxPanY, state.panY));

        canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoomScale})`;
    }

    state.needsRender = true;
}


window.addEventListener('resize', layout);

// Initialize UI through API
const video = $('#vid');
const api = createUIAPI(state, gl, canvas, video, render, layout, ensureRenderTargets);
initUI(api);
initMedia(api);
initExport(api);

function render(t = performance.now()) {
  if (!state.tex) { gl.clearColor(0.05, 0.06, 0.08, 1); gl.clear(gl.COLOR_BUFFER_BIT); requestAnimationFrame(render); return; }
  if (state.showOriginal) {
    bindProgram(gl, copyProgram, quad, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, state.tex);
    gl.uniform1i(gl.getUniformLocation(copyProgram, 'uTex'), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.drawArrays(gl.TRIANGLES, 0, 6);
    state.needsRender = false; requestAnimationFrame(render); return;
  }
  const pxX = 1 / canvas.width, pxY = 1 / canvas.height;
  exposureFlash.applyExposure(state.tex, rtA, state.ev, canvas.width, canvas.height);
  let currentTex = rtA.tex;
  if (state.isVideo && state.shakeHandheld > 0.001) {
    const shakeDst = (currentTex === rtA.tex) ? rtB : rtA;
    handheldCamera.apply(currentTex, shakeDst, state, state.frameSeed, canvas.width, canvas.height);
    currentTex = shakeDst.tex;
  }
  const sh = sliderToShutterSeconds(state.shutterUI), motionAmt = shutterToPixels(sh, state.shake);
  if (motionAmt > 0.05) {
    const motionDst = (currentTex === rtA.tex) ? rtB : rtA;
    motionBlur.apply(currentTex, motionDst, { amount: motionAmt, angle: state.motionAngle, shake: state.shake }, pxX, pxY, canvas.width, canvas.height);
    currentTex = motionDst.tex;
  }
  const flashDst = (currentTex === rtA.tex) ? rtB : rtA;
  exposureFlash.applyFlash(currentTex, flashDst, { centerX: state.flashCenterX, centerY: state.flashCenterY, strength: state.flashStrength, falloff: state.flashFalloff }, canvas.width, canvas.height);
  currentTex = flashDst.tex;
  const brightDst = (currentTex === rtA.tex) ? rtB : rtA;
  bloomVignetteOptics.extractBright(currentTex, brightDst, state.bloomThreshold, state.bloomWarm, canvas.width, canvas.height);
  bloomVignetteOptics.downsample(brightDst.tex, brightDst.w, brightDst.h, rtH_A, canvas.width, canvas.height);
  bloomVignetteOptics.downsample(rtH_A.tex, rtH_A.w, rtH_A.h, rtQ_A, canvas.width, canvas.height);
  bloomVignetteOptics.downsample(rtQ_A.tex, rtQ_A.w, rtQ_A.h, rtE_A, canvas.width, canvas.height);
  bloomVignetteOptics.blurHorizontalVertical(rtE_A, rtE_B, state.bloomRadius * 0.6, canvas.width, canvas.height);
  bloomVignetteOptics.blurHorizontalVertical(rtQ_A, rtQ_B, state.bloomRadius * 0.8, canvas.width, canvas.height);
  bloomVignetteOptics.blurHorizontalVertical(rtH_A, rtH_B, state.bloomRadius * 1.0, canvas.width, canvas.height);
  bloomVignetteOptics.upsampleAdd(rtE_A.tex, rtQ_A.tex, rtQ_B, canvas.width, canvas.height);
  bloomVignetteOptics.upsampleAdd(rtQ_B.tex, rtH_A.tex, rtH_B, canvas.width, canvas.height);
  bloomVignetteOptics.upsampleAdd(rtH_B.tex, brightDst.tex, rtBloom, canvas.width, canvas.height);
  const toneDst = (currentTex === rtA.tex) ? rtB : rtA;
  tone.apply(currentTex, toneDst, { scurve: state.scurve, blacks: state.blacks, knee: state.knee, blackLift: state.blackLift }, canvas.width, canvas.height);
  const splitDst = (toneDst === rtA) ? rtB : rtA;
  splitCast.applySplit(toneDst.tex, splitDst, { shadowCool: state.shadowCool, highlightWarm: state.highlightWarm }, canvas.width, canvas.height);
  const castDst = (splitDst === rtA) ? rtB : rtA;
  splitCast.applyCast(splitDst.tex, castDst, { greenShadows: state.greenShadows, magentaMids: state.magentaMids }, canvas.width, canvas.height);
  const vigDst = (castDst === rtA) ? rtB : rtA;
  bloomVignetteOptics.applyVignette(castDst.tex, vigDst, state.vignette, state.vignettePower, canvas.width, canvas.height);
  const bloomCompDst = (vigDst === rtA) ? rtB : rtA;
  bloomVignetteOptics.compositeBloom(vigDst.tex, rtBloom.tex, bloomCompDst, state.bloomIntensity, state.halation, canvas.width, canvas.height);
  let currentFB = bloomCompDst;
  if (state.clarity > 0.001) {
    const clarDst = (currentFB === rtA) ? rtB : rtA;
    bloomVignetteOptics.applyClarity(currentFB.tex, clarDst, state.clarity, pxX, pxY, canvas.width, canvas.height);
    currentFB = clarDst;
  }
  const caDst = (currentFB === rtA) ? rtB : rtA;
  bloomVignetteOptics.applyChromaticAberration(currentFB.tex, caDst, state.ca, pxX, pxY, canvas.width, canvas.height);
  filmGrain.apply(caDst.tex, state, t, state.isVideo ? state.frameSeed : 0, canvas.width, canvas.height);
  state.needsRender = false; requestAnimationFrame(render);
}

layout(); ensureRenderTargets(); requestAnimationFrame(render);