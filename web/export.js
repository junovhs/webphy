// Export UI controls - handles both web and Electron

const $ = s => document.querySelector(s);
const isElectron = typeof window.electronAPI !== 'undefined';

export function initExport(api) {
  setupExportButton(api);
  
  if (isElectron) {
    console.log('[EXPORT] Running in Electron mode - native MP4 export available');
  }
}

function setupExportButton(api) {
  const btn = $('#export-btn');
  
  btn.onclick = async () => {
    const isVideo = api.getState('isVideo');
    
    try {
      if (isVideo) {
        if (isElectron) {
          await exportVideoElectron(api);
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
      if (err.message !== 'Export cancelled') {
        api.toast(err.message, 'err');
      }
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

// Web export (existing TAR method)
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

// Electron native export
async function exportVideoElectron(api) {
  const canvas = document.getElementById('gl');
  const video = document.getElementById('vid');
  const overlay = document.getElementById('overlay');
  const overlayText = document.getElementById('overlayText');
  
  overlay.classList.remove('hidden');
  overlayText.textContent = 'Starting export…';
  
  // Get video info
  const dur = Math.max(0.01, video.duration || 1);
  const fps = 30; // You could make this configurable
  
  // Start export session
  const startResult = await window.electronAPI.exportVideoStart({
    width: canvas.width,
    height: canvas.height,
    fps: fps
  });
  
  if (!startResult.success) {
    overlay.classList.add('hidden');
    if (startResult.cancelled) {
      return;
    }
    throw new Error(startResult.error || 'Failed to start export');
  }
  
  const exportId = startResult.exportId;
  const outputPath = startResult.outputPath;
  
  // Setup progress listener
  window.electronAPI.onExportProgress((data) => {
    overlayText.textContent = `Encoding video… ${data.percent}%`;
  });
  
  // Capture all frames
  const wasLoop = video.loop;
  const wasPaused = video.paused;
  
  video.loop = false;
  video.playbackRate = 1.0;
  video.pause();
  video.currentTime = 0;
  
  await new Promise(resolve => {
    video.addEventListener('seeked', resolve, { once: true });
  });
  
  let frameIndex = 0;
  const startTime = performance.now();
  
  try {
    await new Promise((resolve, reject) => {
      let vfcb;
      let aborted = false;
      
      const cleanup = () => {
        if (video.cancelVideoFrameCallback && vfcb) {
          try { video.cancelVideoFrameCallback(vfcb); } catch (e) {}
        }
        video.pause();
        video.loop = wasLoop;
        if (wasPaused) video.pause();
      };
      
      const onFrame = async () => {
        try {
          if (aborted) return;
          
          video.pause();
          
          // Trigger render of this frame
          await api.renderCurrentFrame();
          await new Promise(r => requestAnimationFrame(r));
          
          // Capture canvas as data URL
          const dataUrl = canvas.toDataURL('image/png');
          
          // Send frame to Electron
          const result = await window.electronAPI.exportVideoFrame({
            exportId: exportId,
            frameIndex: frameIndex,
            frameDataUrl: dataUrl
          });
          
          if (!result.success) {
            throw new Error(result.error || 'Failed to save frame');
          }
          
          frameIndex++;
          
          const progress = Math.round((video.currentTime / dur) * 100);
          const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
          const fps = (frameIndex / (performance.now() - startTime) * 1000).toFixed(1);
          
          overlayText.textContent = `Capturing frame ${frameIndex} (${progress}%) • ${fps} fps`;
          
          if (video.ended || video.currentTime >= dur - 1e-4) {
            cleanup();
            resolve();
            return;
          }
          
          vfcb = video.requestVideoFrameCallback(onFrame);
          video.play().catch(() => {});
          
        } catch (err) {
          console.error('[EXPORT] Error:', err);
          aborted = true;
          cleanup();
          reject(err);
        }
      };
      
      vfcb = video.requestVideoFrameCallback(onFrame);
      video.addEventListener('ended', () => {
        cleanup();
        resolve();
      }, { once: true });
      
      video.play().catch(err => {
        cleanup();
        reject(err);
      });
    });
    
    // All frames captured, now encode
    overlayText.textContent = 'Encoding video…';
    
    const encodeResult = await window.electronAPI.exportVideoFinish({
      exportId: exportId,
      outputPath: outputPath,
      fps: fps
    });
    
    overlay.classList.add('hidden');
    
    if (!encodeResult.success) {
      throw new Error(encodeResult.error || 'Failed to encode video');
    }
    
    api.toast('MP4 exported successfully');
    
  } catch (error) {
    // Cancel/cleanup on error
    await window.electronAPI.exportVideoCancel({ exportId: exportId });
    overlay.classList.add('hidden');
    throw error;
  }
}

async function exportFrameElectron(api) {
  const canvas = document.getElementById('gl');
  
  // Render current frame
  await api.renderCurrentFrame();
  await new Promise(r => requestAnimationFrame(r));
  
  // Get as data URL
  const dataUrl = canvas.toDataURL('image/webp', 0.95);
  
  // Send to Electron for save dialog
  const result = await window.electronAPI.exportFrame(dataUrl, 'frame.webp');
  
  if (result.success) {
    api.toast('Frame exported');
  } else if (!result.cancelled) {
    throw new Error(result.error || 'Failed to export frame');
  }
}