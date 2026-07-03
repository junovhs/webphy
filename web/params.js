import { EXPOSURE_FLASH_PARAMS } from './modules/exposure-flash.js';
import { TONE_PARAMS } from './modules/tone.js';
import { SPLIT_CAST_PARAMS } from './modules/split-cast.js';
import { BLOOM_VIGNETTE_OPTICS_PARAMS } from './modules/bloom-vignette-optics.js';
import { MOTION_BLUR_PARAMS } from './modules/motion-blur.js';
import { HANDHELD_PARAMS } from './modules/handheld-camera.js';
import { GRAIN_PARAMS } from './modules/film-grain.js';

export const ALL_PARAMS = {
  ...EXPOSURE_FLASH_PARAMS,
  ...TONE_PARAMS,
  ...SPLIT_CAST_PARAMS,
  ...BLOOM_VIGNETTE_OPTICS_PARAMS,
  ...MOTION_BLUR_PARAMS,
  ...HANDHELD_PARAMS,
  ...GRAIN_PARAMS,
};

export const TAB_CONFIG = [
  { id: 'exposure', label: 'Exposure', params: ['ev', 'flashStrength', 'flashFalloff'], hasFlashPad: true },
  { id: 'tone', label: 'Tone', params: ['scurve', 'blacks', 'blackLift', 'knee'] },
  { id: 'color', label: 'Color', params: ['shadowCool', 'highlightWarm', 'greenShadows', 'magentaMids'] },
  { id: 'bloom', label: 'Bloom', params: ['bloomThreshold', 'bloomRadius', 'bloomIntensity', 'bloomWarm'] },
  { id: 'optics', label: 'Optics', params: ['halation', 'vignette', 'vignettePower', 'ca', 'clarity'] },
  { id: 'motion', label: 'Motion', params: ['shutterUI', 'shake', 'motionAngle'] },
  { id: 'handheld', label: 'Handheld', params: ['shakeHandheld', 'shakeStyle', 'shakeWobble', 'shakeJitter'] },
  { id: 'grain', label: 'Grain Studio', params: Object.keys(GRAIN_PARAMS) },
];

export function makeDefaultParamState() {
  const defaults = {};
  for (const [key, config] of Object.entries(ALL_PARAMS)) {
    defaults[key] = config.default;
  }
  return defaults;
}

export function hasOptions(config) {
  return Array.isArray(config?.options) && config.options.length > 0;
}

export function formatParamValue(config, value) {
  if (hasOptions(config)) {
    const index = Math.max(0, Math.min(config.options.length - 1, Math.round(value)));
    return config.options[index];
  }

  const step = config?.step ?? 1;
  return step < 0.01 ? value.toFixed(3) : step < 1 ? value.toFixed(2) : value.toFixed(0);
}
