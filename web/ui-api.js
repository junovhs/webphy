// UI API Contract - the UI reads and mutates app state only through this object.

import { ALL_PARAMS, TAB_CONFIG, makeDefaultParamState, formatParamValue } from './params.js';
import { sliderToShutterSeconds, formatShutter } from './modules/motion-blur.js';
import { exportPNGSequence } from './export-images.js';
import { download, toast } from './utils.js';

export { TAB_CONFIG } from './params.js';

export function createUIAPI(deps) {
  const {
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
    allParams = ALL_PARAMS,
  } = deps;

  const renderCurrentFrame = async () => {
    if (state.isVideo) uploadVideoFrame?.();
    ensureRenderTargets?.();
    draw(performance.now());
  };

  const api = {
    params: allParams,
    tabs: TAB_CONFIG,

    formatShutterSpeed: sliderValue => formatShutter(sliderToShutterSeconds(sliderValue)),
    formatParamValue: (value, configOrStep) => {
      if (typeof configOrStep === 'object') return formatParamValue(configOrStep, value);
      const step = Number(configOrStep) || 1;
      return step < 0.01 ? value.toFixed(3) : step < 1 ? value.toFixed(2) : value.toFixed(0);
    },

    getState: key => state[key],
    setState: (key, value) => {
      state[key] = value;
      state.needsRender = true;
    },
    getAllState: () => ({ ...state }),

    getGL: () => gl,
    loadImage,
    loadVideo,

    togglePlayback: () => {
      if (!state.isVideo) return false;
      if (video.paused) {
        video.play();
        return true;
      }
      video.pause();
      return false;
    },

    toggleOriginal: () => {
      state.showOriginal = !state.showOriginal;
      state.needsRender = true;
      return state.showOriginal;
    },

    toggleViewMode: () => {
      const flashInstruction = document.getElementById('flashInstruction');
      if (state.viewMode === 'fit') {
        state.viewMode = '1x';
        canvas.classList.add('grabbable');
        if (flashInstruction) flashInstruction.classList.add('disabled');
        state.panX = null;
        state.panY = null;
      } else {
        state.viewMode = 'fit';
        canvas.classList.remove('grabbable');
        if (flashInstruction) flashInstruction.classList.remove('disabled');
      }
      layout();
      return state.viewMode;
    },

    resetAll: () => {
      Object.assign(state, makeDefaultParamState());
      state.flashCenterX = 0.5;
      state.flashCenterY = 0.5;
      state.needsRender = true;
    },

    exportPNG: async () => {
      await renderCurrentFrame();
      return await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.95));
    },

    exportPNGSequence: async () => {
      return exportPNGSequence(
        canvas,
        state.tex,
        video,
        state.isVideo,
        renderCurrentFrame,
        document.getElementById('overlay'),
        document.getElementById('overlayText'),
      );
    },

    download,
    toast,
    layout,
    renderCurrentFrame,
  };

  return api;
}
