// UI API Contract - bridges app internals to UI components
// This is the ONLY file that knows about both sides

import { EXPOSURE_FLASH_PARAMS } from './modules/exposure-flash.js';
import { TONE_PARAMS } from './modules/tone.js';
import { SPLIT_CAST_PARAMS } from './modules/split-cast.js';
import { BLOOM_VIGNETTE_OPTICS_PARAMS } from './modules/bloom-vignette-optics.js';
import { MOTION_BLUR_PARAMS, sliderToShutterSeconds, formatShutter, shutterToPixels } from './modules/motion-blur.js';
import { HANDHELD_PARAMS } from './modules/handheld-camera.js';
import { GRAIN_PARAMS } from './modules/film-grain.js';
import { createTexture } from './gl-context.js';
import { exportPNGSequence } from './export-images.js';
import { download, toast } from './utils.js';

// Collect all parameters into a simple data structure
const ALL_PARAMS = {
  ...EXPOSURE_FLASH_PARAMS,
  ...TONE_PARAMS,
  ...SPLIT_CAST_PARAMS,
  ...BLOOM_VIGNETTE_OPTICS_PARAMS,
  ...MOTION_BLUR_PARAMS,
  ...HANDHELD_PARAMS,
  ...GRAIN_PARAMS
};

// Tab structure - UI just needs this data
export const TAB_CONFIG = [
  { id: 'exposure', label: 'Exposure', params: ['ev', 'flashStrength', 'flashFalloff'], hasFlashPad: true },
  { id: 'tone', label: 'Tone', params: ['scurve', 'blacks', 'blackLift', 'knee'] },
  { id: 'color', label: 'Color', params: ['shadowCool', 'highlightWarm', 'greenShadows', 'magentaMids'] },
  { id: 'bloom', label: 'Bloom', params: ['bloomThreshold', 'bloomRadius', 'bloomIntensity', 'bloomWarm'] },
  { id: 'optics', label: 'Optics', params: ['halation', 'vignette', 'vignettePower', 'ca', 'clarity'] },
  { id: 'motion', label: 'Motion', params: ['shutterUI', 'shake', 'motionAngle'] },
  { id: 'handheld', label: 'Handheld', params: ['shakeHandheld', 'shakeStyle', 'shakeWobble', 'shakeJitter'] },
  { id: 'grain', label: 'Grain', params: Object.keys(GRAIN_PARAMS) },
  { id: 'file', label: 'File', special: 'file' }
];

// Create the API that UI components consume
export function createUIAPI(state, gl, canvas, video, render, layout, ensureRenderTargets) {
  
  const api = {
    // Data the UI needs
    params: ALL_PARAMS,
    tabs: TAB_CONFIG,
    
    // Formatters for special values
    formatShutterSpeed: (sliderValue) => formatShutter(sliderToShutterSeconds(sliderValue)),
    formatParamValue: (value, step) => 
      step < 0.01 ? value.toFixed(3) :
      step < 1 ? value.toFixed(2) : value.toFixed(0),
    
    // State getters/setters
    getState: (key) => state[key],
    setState: (key, value) => {
      state[key] = value;
      state.needsRender = true;
    },
    getAllState: () => ({ ...state }),
    
    // Media loading
    loadImage: (file) => {
      const img = new Image();
      img.onload = () => {
        state.isVideo = false;
        state.mediaW = img.naturalWidth;
        state.mediaH = img.naturalHeight;
        state.tex = createTexture(gl, state.mediaW, state.mediaH);
        gl.bindTexture(gl.TEXTURE_2D, state.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        layout();
        state.needsRender = true;
      };
      img.src = URL.createObjectURL(file);
    },
    
    loadVideo: (file) => {
      if (state._vfcb && video.cancelVideoFrameCallback) {
        try { video.cancelVideoFrameCallback(state._vfcb); } catch (e) {}
      }
      
      video.src = URL.createObjectURL(file);
      video.loop = video.muted = true;
      video.playsInline = true;
      
      video.onloadedmetadata = () => {
        state.isVideo = true;
        state.mediaW = video.videoWidth;
        state.mediaH = video.videoHeight;
        state.tex = createTexture(gl, state.mediaW, state.mediaH);
        layout();
        video.play().catch(() => {});
        
        const upload = () => {
          gl.bindTexture(gl.TEXTURE_2D, state.tex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          state.frameSeed = (state.frameSeed + 1) | 0;
          state.needsRender = true;
        };
        
        if (video.requestVideoFrameCallback) {
          const loop = () => {
            if (!state.isVideo) return;
            if (!video.paused) upload();
            state._vfcb = video.requestVideoFrameCallback(loop);
          };
          state._vfcb = video.requestVideoFrameCallback(loop);
        } else {
          (function pump() {
            if (!state.isVideo) return;
            if (!video.paused && !video.ended) upload();
            requestAnimationFrame(pump);
          })();
        }
      };
    },
    
    // Playback controls
    togglePlayback: () => {
      if (!state.isVideo) return false;
      if (video.paused) {
        video.play();
        return true; // playing
      } else {
        video.pause();
        return false; // paused
      }
    },
    
    toggleOriginal: () => {
      state.showOriginal = !state.showOriginal;
      state.needsRender = true;
      return state.showOriginal;
    },
    
    toggleViewMode: () => {
      if (state.viewMode === 'fit') {
        state.viewMode = '1x';
        canvas.classList.add('grabbable');
        state.panX = undefined;
        state.panY = undefined;
      } else {
        state.viewMode = 'fit';
        canvas.classList.remove('grabbable');
      }
      layout();
      return state.viewMode;
    },
    
    // Reset
    resetAll: () => {
      for (const [key, config] of Object.entries(ALL_PARAMS)) {
        state[key] = config.default;
      }
      state.flashCenterX = 0.5;
      state.flashCenterY = 0.5;
      state.needsRender = true;
    },
    
    // Export functions
    exportPNG: async () => {
      if (!state.tex) throw new Error('No media loaded');
      
      return await withFullRes(async () => {
        if (state.isVideo) {
          gl.bindTexture(gl.TEXTURE_2D, state.tex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          state.frameSeed = (state.frameSeed + 1) | 0;
          state.needsRender = true;
        }
        await new Promise(r => requestAnimationFrame(r));
        return await new Promise(r => canvas.toBlob(r, 'image/webp', 1.0));
      });
    },
    
    exportPNGSequence: async () => {
      if (!state.tex) throw new Error('No media loaded');
      if (!state.isVideo) throw new Error('Load a video to export sequence');
      
      const blob = await withFullRes(async () => {
        const renderFunc = async () => {
          gl.bindTexture(gl.TEXTURE_2D, state.tex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          state.frameSeed = (state.frameSeed + 1) | 0;
          state.needsRender = true;
          render(performance.now());
        };
        
        return await exportPNGSequence(canvas, state.tex, video, state.isVideo, renderFunc, 
          document.getElementById('overlay'), document.getElementById('overlayText'));
      });
      
      // Return blob but trigger download immediately in export.js
      return blob;
    },
    
    // Utilities
    download,
    toast,
    layout,
    
    // Render single frame (for Electron export)
    renderCurrentFrame: async () => {
      if (state.isVideo) {
        gl.bindTexture(gl.TEXTURE_2D, state.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        state.frameSeed = (state.frameSeed + 1) | 0;
        state.needsRender = true;
      }
      render(performance.now());
    }
  };
  
  // Helper for full resolution export
  async function withFullRes(callback) {
    const prev = {
      cssW: canvas.style.width,
      cssH: canvas.style.height,
      w: canvas.width,
      h: canvas.height
    };
    
    canvas.style.width = state.mediaW + 'px';
    canvas.style.height = state.mediaH + 'px';
    canvas.width = state.mediaW;
    canvas.height = state.mediaH;
    gl.viewport(0, 0, state.mediaW, state.mediaH);
    ensureRenderTargets();
    state.needsRender = true;
    
    const result = await callback();
    
    canvas.style.width = prev.cssW;
    canvas.style.height = prev.cssH;
    canvas.width = prev.w;
    canvas.height = prev.h;
    gl.viewport(0, 0, prev.w, prev.h);
    ensureRenderTargets();
    state.needsRender = true;
    
    return result;
  }
  
  return api;
}