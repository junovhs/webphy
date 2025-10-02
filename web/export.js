// webphy/web/export.js

import { exportVideoFrameSequence } from './export-video.js';

const $ = s => document.querySelector(s);
const isElectron = typeof window.electronAPI !== 'undefined';

export function initExport(api) {
  setupExportButton(api);
  
  if (isElectron) {
    console.log('[EXPORT] Electron mode - high-quality pipeline export available');
  }
}

function setupExportButton(api) {
  const btn = $('#export-btn');
  
  btn.onclick = async () => {
    const isVideo = api.getState('isVideo');
    
    try {
      if (isVideo) {
        if (isElectron) {
          await exportVideoPipeline(api);
        } else {
          await exportVideoWeb(api);
        }
      } else {
        if (isElectron) {
          await exportFrameElectron(api);
        } else {
          await exportFrameWeb(api);
        }
      }
    } catch (err) {
      if (err.message && err.message !== 'Export cancelled') {
        api.toast(err.message, 'err');
      }
      $('#overlay').classList.add('hidden');
    }
  };
  
  const updateButtonText = () => {
    const isVideo = api.getState('isVideo');
    if (isElectron) {
      btn.textContent = isVideo ? 'Export MP4 (High Quality)' : 'Export WebP';
    } else {
      btn.textContent = isVideo ? 'Export Frames (TAR)' : 'Export WebP';
    }
  };
  
  updateButtonText();
  window.updateExportButton = updateButtonText;
}

async function exportVideoPipeline(api) {
  const video = $('#vid');
  const canvas = $('#gl');
  const overlay = $('#overlay');
  const overlayText = $('#overlayText');

  try {
    await exportVideoFrameSequence(api, canvas, video, overlay, overlayText);
    api.toast('Video exported successfully!');
  } finally {
    overlay.classList.add('hidden');
  }
}

// Fallback exports for web mode (unchanged)
async function exportVideoWeb(api) {
  const tarBlob = await api.exportPNGSequence();
  
  if (tarBlob === null) {
    api.toast('Frame sequence exported');
  } else {
    api.download(tarBlob, 'frames.tar');
    api.toast('Frames exported');
  }
}

async function exportFrameWeb(api) {
  const blob = await api.exportPNG();
  api.download(blob, 'image_processed.webp');
  api.toast('Image exported');
}

async function exportFrameElectron(api) {
  const canvas = $('#gl');
  
  await api.renderCurrentFrame();
  await new Promise(r => requestAnimationFrame(r));
  
  const dataUrl = canvas.toDataURL('image/webp', 0.95);
  
  const result = await window.electronAPI.exportFrame(dataUrl, 'frame.webp');
  
  if (result.success) {
    api.toast('Frame exported');
  } else if (!result.cancelled) {
    throw new Error(result.error || 'Failed to export frame');
  }
}