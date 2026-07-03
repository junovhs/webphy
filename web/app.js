import { initGL, getCapabilities, createQuadBuffer, createTexture } from './gl-context.js';
import { RenderPipeline, stillGrainFrameSeed } from './render-pipeline.js';
import { ALL_PARAMS, makeDefaultParamState } from './params.js';
import { createUIAPI } from './ui-api.js';
import { initUI } from './ui.js';
import { initMedia } from './media.js';
import { initExport } from './export.js';

const $ = s => document.querySelector(s);

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
  zoomScale: 1.0,
  needsRender: true,
  showOriginal: false,
  ...makeDefaultParamState(),
};

const canvas = $('#gl');
const video = $('#vid');
const gl = initGL(canvas);
if (!gl) throw new Error('WebGL failed');

const caps = getCapabilities(gl);
const quad = createQuadBuffer(gl);
const pipeline = new RenderPipeline(gl, quad, caps);

function ensureRenderTargets() {
  pipeline.ensure(canvas.width | 0, canvas.height | 0);
}

function layout() {
  const wrapper = $('#player-wrapper');
  const container = $('#viewer');
  if (!state.mediaW || !state.mediaH || !wrapper || !container) return;

  const computedStyle = getComputedStyle(container);
  const cW = container.clientWidth - parseFloat(computedStyle.paddingLeft) - parseFloat(computedStyle.paddingRight);
  const cH = container.clientHeight - parseFloat(computedStyle.paddingTop) - parseFloat(computedStyle.paddingBottom);
  const transportHeight = state.isVideo ? (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--transport-height'), 10) || 64) : 0;
  const availableH = Math.max(1, cH - transportHeight);
  const scaleFit = Math.max(0.001, Math.min(cW / state.mediaW, availableH / state.mediaH));
  const fitW = Math.max(1, Math.round(state.mediaW * scaleFit));
  const fitH = Math.max(1, Math.round(state.mediaH * scaleFit));

  wrapper.style.width = `${fitW}px`;
  wrapper.style.height = `${fitH + transportHeight}px`;
  canvas.style.height = `${fitH}px`;

  if (state.viewMode === 'fit') {
    state.zoomScale = 1.0;
    state.panX = state.panY = null;
    canvas.style.transform = 'translate(0, 0) scale(1)';

    const targetW = Math.max(1, Math.round(fitW * state.dpr));
    const targetH = Math.max(1, Math.round(fitH * state.dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      ensureRenderTargets();
    }
    gl.viewport(0, 0, targetW, targetH);
  } else {
    state.zoomScale = state.mediaW / fitW;

    const targetW = Math.max(1, Math.round(state.mediaW * state.dpr));
    const targetH = Math.max(1, Math.round(state.mediaH * state.dpr));
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

function uploadVideoFrame() {
  if (!state.isVideo || !state.tex || !video || video.readyState < 2) return false;
  gl.bindTexture(gl.TEXTURE_2D, state.tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  state.frameSeed = (state.frameSeed + 1) | 0;
  state.needsRender = true;
  return true;
}

function draw(t = performance.now()) {
  if (!state.tex) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0.05, 0.06, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }

  gl.viewport(0, 0, canvas.width, canvas.height);
  const frameSeed = state.isVideo ? state.frameSeed : stillGrainFrameSeed(state, t);

  if (state.showOriginal) {
    pipeline.drawTexture(state.tex, null, canvas.width, canvas.height, false);
  } else {
    pipeline.render(state.tex, state, {
      width: canvas.width,
      height: canvas.height,
      timeMs: t,
      frameSeed,
      target: null,
    });
  }

  state.needsRender = false;
}

function renderLoop(t) {
  draw(t);
  requestAnimationFrame(renderLoop);
}

function loadImage(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    state.isVideo = false;
    state.mediaW = img.naturalWidth;
    state.mediaH = img.naturalHeight;
    state.tex = createTexture(gl, state.mediaW, state.mediaH);
    gl.bindTexture(gl.TEXTURE_2D, state.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    URL.revokeObjectURL(url);
    layout();
    state.needsRender = true;
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

function loadVideo(file) {
  if (state._vfcb && video.cancelVideoFrameCallback) {
    try { video.cancelVideoFrameCallback(state._vfcb); } catch {}
  }

  video.src = URL.createObjectURL(file);
  video.loop = true;
  video.muted = true;
  video.playsInline = true;

  video.onloadedmetadata = () => {
    state.isVideo = true;
    state.mediaW = video.videoWidth;
    state.mediaH = video.videoHeight;
    state.frameSeed = 0;
    state.tex = createTexture(gl, state.mediaW, state.mediaH);
    layout();
    video.play().catch(() => {});

    if (video.requestVideoFrameCallback) {
      const loop = () => {
        if (!state.isVideo) return;
        if (!video.paused) uploadVideoFrame();
        state._vfcb = video.requestVideoFrameCallback(loop);
      };
      state._vfcb = video.requestVideoFrameCallback(loop);
    } else {
      (function pump() {
        if (!state.isVideo) return;
        if (!video.paused && !video.ended) uploadVideoFrame();
        requestAnimationFrame(pump);
      })();
    }
  };
}

window.addEventListener('resize', layout);

const api = createUIAPI({
  state,
  gl,
  canvas,
  video,
  draw,
  layout,
  ensureRenderTargets,
  uploadVideoFrame,
  loadImage,
  loadVideo,
  allParams: ALL_PARAMS,
});

initUI(api);
initMedia(api);
initExport(api);

layout();
ensureRenderTargets();
requestAnimationFrame(renderLoop);
