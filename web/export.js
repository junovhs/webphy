// webphy/web/export.js
// KISS: one file adds detection-on-import, a tiny toggle, and preview audio wiring.

const $ = s => document.querySelector(s);
const isElectron = typeof window.electronAPI !== 'undefined';

let audioState = {
  hasAudio: false,
  includeAudio: false,
  volume: 1.0,
  probedForPath: null
};

export function initExport(api) {
  createAudioToggleUI(api);
  wireAudioDetectionOnImport(api);
  setupExportButton(api);
  if (isElectron) setupPipelineExport(api);
}

function createAudioToggleUI(api) {
  const exportBtn = $('#export-btn');
  if (!exportBtn) return;

  // Container to the LEFT of Export
  const label = document.createElement('label');
  label.id = 'audio-toggle';
  label.style.cssText = [
    'display:none', 'user-select:none', 'cursor:pointer', 'margin-right:12px',
    'font: 500 12px/1.2 system-ui', 'align-items:center', 'gap:8px',
    'padding:6px 10px', 'border:1px solid #ccc', 'border-radius:999px'
  ].join(';');

  // Include checkbox
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.style.cssText = 'accent-color: currentColor;';

  const text = document.createElement('span');
  text.textContent = 'Include sound';

  // Volume slider
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.01';
  slider.value = String(audioState.volume);
  slider.style.cssText = 'width:120px; vertical-align:middle;';

  label.appendChild(input);
  label.appendChild(text);
  label.appendChild(slider);

  // Insert immediately before the export button (i.e., to its left)
  exportBtn.parentNode.insertBefore(label, exportBtn);

  // Ensure preview reflects current defaults
  const vid = $('#vid');
  if (vid) {
    vid.volume = audioState.volume;
    vid.muted = !audioState.includeAudio;
  }

  input.addEventListener('change', () => {
    audioState.includeAudio = input.checked;
    api.setState?.('includeAudio', audioState.includeAudio);
    const v = $('#vid');
    if (v) v.muted = !audioState.includeAudio;
    // Enable/disable slider when audio is excluded
    slider.disabled = !audioState.includeAudio;
    slider.style.opacity = audioState.includeAudio ? '1' : '0.5';
  });

  slider.addEventListener('input', () => {
    const v = Math.max(0, Math.min(1, Number(slider.value)));
    audioState.volume = v;
    api.setState?.('audioVolume', v);
    const el = $('#vid');
    if (el) el.volume = v;
  });

  // Initial disabled state mirrors includeAudio
  slider.disabled = !audioState.includeAudio;
  slider.style.opacity = audioState.includeAudio ? '1' : '0.5';
}

async function detectForPath(api, videoPath) {
  if (!isElectron || !videoPath) return { success: false };
  if (audioState.probedForPath === videoPath) {
    // Already done for this file
    applyToggleVisibility(api);
    return { success: true, hasAudio: audioState.hasAudio };
  }

  try {
    const probe = await window.electronAPI.detectAudio(videoPath);
    audioState.probedForPath = videoPath;
    audioState.hasAudio = !!(probe && probe.success && probe.hasAudio);
    audioState.includeAudio = audioState.hasAudio; // default ON when present
    api.setState?.('hasAudio', audioState.hasAudio);
    api.setState?.('includeAudio', audioState.includeAudio);

    applyToggleVisibility(api);

    // Live preview: un/mute the <video> to reflect the toggle
    const vid = $('#vid');
    if (vid) vid.muted = !audioState.includeAudio;

    return { success: true, hasAudio: audioState.hasAudio };
  } catch {
    // Hide toggle if probe failed
    const toggle = $('#audio-toggle');
    if (toggle) toggle.style.display = 'none';
    audioState.hasAudio = false;
    audioState.includeAudio = false;
    api.setState?.('hasAudio', false);
    api.setState?.('includeAudio', false);
    return { success: false };
  }
}

function applyToggleVisibility(api) {
  const toggle = $('#audio-toggle');
  const input = toggle?.querySelector('input[type="checkbox"]');
  if (!toggle || !input) return;
  toggle.style.display = audioState.hasAudio ? 'inline-flex' : 'none';
  input.checked = audioState.includeAudio;
}

function wireAudioDetectionOnImport(api) {
  const vid = $('#vid');
  if (!vid) return;

  const run = async () => {
    const path = api.getState?.('sourceVideoPath');
    await detectForPath(api, path);
  };

  // Fire once if metadata is already available, otherwise on load.
  if (vid.readyState >= 1) run(); // HAVE_METADATA
  vid.addEventListener('loadedmetadata', run);

  // If app replaces <video src> without reloading metadata, catch it.
  const obs = new MutationObserver(run);
  obs.observe(vid, { attributes: true, attributeFilter: ['src'] });
}

function setupExportButton(api) {
  const btn = $('#export-btn');
  if (!btn) return;

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
      if (err?.message && err.message !== 'Export cancelled') {
        api.toast(err.message, 'err');
      }
      $('#overlay')?.classList.add('hidden');
    }
  };
}

function setupPipelineExport(api) {
  window.electronAPI.onExportProgress(({ progress, frameIndex, totalFrames }) => {
    const overlay = $('#overlay');
    const overlayText = $('#overlayText');
    if (!overlay || !overlayText) return;

    overlay.classList.remove('hidden');
    overlayText.textContent = totalFrames > 0
      ? `Encoding: ${progress}% (${frameIndex}/${totalFrames})`
      : `Encoding: Frame ${frameIndex}`;
  });

  window.electronAPI.onExportComplete(({ success, outputPath, error }) => {
    $('#overlay')?.classList.add('hidden');
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

  // Ensure detection is ready (covers rare “export immediately after import” case)
  await detectForPath(api, videoPath);

  const vid = $('#vid');
  $('#overlay')?.classList.remove('hidden');
  const ot = $('#overlayText'); if (ot) ot.textContent = 'Preparing native resolution export…';

  const result = await window.electronAPI.exportVideoStart({
    inputPath: videoPath,
    width: api.getState('mediaW'),
    height: api.getState('mediaH'),
    fps: 30,
    duration: vid?.duration || api.getState('duration') || 0,
    params: api.getAllState(),
    includeAudio: !!audioState.includeAudio,
    audioVolume: audioState.includeAudio ? Math.max(0, Math.min(1, audioState.volume)) : 0
  });


  if (!result.success && result.cancelled) {
    api.toast('Export cancelled');
    $('#overlay')?.classList.add('hidden');
  } else if (!result.success) {
    api.toast(result.error || 'Export failed', 'err');
    $('#overlay')?.classList.add('hidden');
  }
}

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
