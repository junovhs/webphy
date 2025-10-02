// Export UI controls - proper FFmpeg pipeline

const $ = s => document.querySelector(s);
const isElectron = typeof window.electronAPI !== 'undefined';

export function initExport(api) {
  setupExportButton(api);
  
  if (isElectron) {
    console.log('[EXPORT] Electron mode - pipeline export available');
    setupPipelineExport(api);
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
          // Web fallback remains unchanged
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
      // Hide overlay on any error
      $('#overlay').classList.add('hidden');
    }
  };
  
  const updateButtonText = () => {
    const isVideo = api.getState('isVideo');
    if (isElectron) {
      btn.textContent = isVideo ? 'Export MP4' : 'Export WebP';
    } else {
      btn.textContent = isVideo ? 'Export Frames (TAR)' : 'Export WebP';
    }
  };
  
  updateButtonText();
  window.updateExportButton = updateButtonText;
}

// The renderer-side processing logic is now only for listening to progress/completion
function setupPipelineExport(api) {
  // Progress updates
  window.electronAPI.onExportProgress(({ progress, frameIndex, totalFrames }) => {
    const overlay = $('#overlay');
    const overlayText = $('#overlayText');
    overlay.classList.remove('hidden');
    
    if (totalFrames > 0) {
      overlayText.textContent = `Encoding: ${progress}% (${frameIndex}/${totalFrames})`;
    } else {
      overlayText.textContent = `Encoding: Frame ${frameIndex}`;
    }
  });
  
  // Completion
  window.electronAPI.onExportComplete(({ success, outputPath, error }) => {
    const overlay = $('#overlay');
    overlay.classList.add('hidden');
    
    if (success) {
      api.toast('Video exported successfully');
    } else if (error) {
      api.toast(error, 'err');
    }
  });
}

async function exportVideoPipeline(api) {
  const videoPath = api.getState('sourceVideoPath');
  
  if (!videoPath) {
    api.toast('Original video file path not available', 'err');
    return;
  }
  
  const video = $('#vid');
  const canvas = $('#gl');
  
  $('#overlay').classList.remove('hidden');
  $('#overlayText').textContent = 'Starting export…';

  const result = await window.electronAPI.exportVideoStart({
    inputPath: videoPath,
    width: canvas.width,
    height: canvas.height,
    fps: 30, // Or get this from video metadata if available
    duration: video.duration
  });
  
  if (!result.success && result.cancelled) {
    api.toast('Export cancelled');
    $('#overlay').classList.add('hidden');
  } else if (!result.success) {
    api.toast(result.error || 'Export failed', 'err');
    $('#overlay').classList.add('hidden');
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