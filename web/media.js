// Media UI controls - pure callback-based

const $ = s => document.querySelector(s);

export function initMedia(api) {
  setupFileInput(api);
  setupTransportControls(api);
  setupResetButton(api);
}

function setupFileInput(api) {
  $('#file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    
    const isVideo = (file.type || '').startsWith('video/');
    
    if (isVideo) {
      api.loadVideo(file);
      $('#play').disabled = false;
      $('#play').textContent = 'Pause';
    } else {
      api.loadImage(file);
      $('#play').disabled = true;
    }
    
    // Update export button text
    if (window.updateExportButton) {
      window.updateExportButton();
    }
  });
}

function setupTransportControls(api) {
  const playBtn = $('#play');
  const originalBtn = $('#original');
  const viewBtn = $('#view-mode');
  
  if (playBtn) {
    playBtn.onclick = () => {
      const playing = api.togglePlayback();
      playBtn.textContent = playing ? 'Pause' : 'Play';
    };
  }
  
  if (originalBtn) {
    originalBtn.onclick = () => {
      const showing = api.toggleOriginal();
      originalBtn.classList.toggle('active', showing);
    };
  }
  
  if (viewBtn) {
    viewBtn.onclick = () => {
      const mode = api.toggleViewMode();
      viewBtn.textContent = mode === 'fit' ? 'Fit' : '1:1';
    };
  }
}

function setupResetButton(api) {
  $('#reset').onclick = () => {
    api.resetAll();
    
    // Update all UI controls
    Object.entries(api.params).forEach(([key, config]) => {
      const el = $(`#${key}`);
      if (!el) return;
      
      el.value = config.default;
      const lbl = $(`.control-value[data-for="${key}"]`);
      if (lbl) {
        lbl.textContent = config.special === 'shutter' ? 
          api.formatShutterSpeed(config.default) : 
          api.formatParamValue(config.default, config.step);
      }
    });
    
    // Update flash dot
    const pad = $('#flashPad');
    const dot = $('#flashDot');
    if (pad && dot) {
      const r = pad.getBoundingClientRect();
      dot.style.left = (0.5 * r.width) + 'px';
      dot.style.top = (0.5 * r.height) + 'px';
    }
  };
}