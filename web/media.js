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
      
      const transportBar = $('#transport-bar');
      if (transportBar) transportBar.classList.remove('hidden');
      
      if (typeof window.electronAPI !== 'undefined' && file.path) {
        api.setState('sourceVideoPath', file.path);
      }
    } else {
      api.loadImage(file);
      
      const transportBar = $('#transport-bar');
      if (transportBar) transportBar.classList.add('hidden');
    }
    
    if (window.updateExportButton) {
      window.updateExportButton();
    }
  });
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function setupTransportControls(api) {
  const video = $('#vid');
  const transportPlay = $('#transport-play');
  const timeline = $('#timeline');
  const currentTime = $('#current-time');
  const durationTime = $('#duration-time');
  const playIcon = $('#play-icon');
  const pauseIcon = $('#pause-icon');
  
  // Update play/pause icon
  function updatePlayIcon(playing) {
    if (playIcon && pauseIcon) {
      if (playing) {
        playIcon.style.display = 'none';
        pauseIcon.style.display = 'block';
      } else {
        playIcon.style.display = 'block';
        pauseIcon.style.display = 'none';
      }
    }
  }
  
  // Transport play/pause
  if (transportPlay) {
    transportPlay.onclick = () => {
      if (!api.getState('isVideo')) return;
      
      if (video.paused) {
        video.play();
        updatePlayIcon(true);
      } else {
        video.pause();
        updatePlayIcon(false);
      }
    };
  }
  
  // Timeline scrubbing with REAL-TIME preview
  if (timeline) {
    let seeking = false;
    
    timeline.addEventListener('mousedown', () => {
      seeking = true;
      video.pause();
    });
    
    timeline.addEventListener('input', (e) => {
      if (!api.getState('isVideo')) return;
      const time = (parseFloat(e.target.value) / 100) * video.duration;
      video.currentTime = time;
      if (currentTime) currentTime.textContent = formatTime(time);
    });
    
    timeline.addEventListener('mouseup', () => {
      seeking = false;
    });
    
    // Update timeline as video plays
    video.addEventListener('timeupdate', () => {
      if (seeking) return;
      const percent = (video.currentTime / video.duration) * 100;
      timeline.value = percent || 0;
      if (currentTime) currentTime.textContent = formatTime(video.currentTime);
    });
    
    video.addEventListener('loadedmetadata', () => {
      if (durationTime) durationTime.textContent = formatTime(video.duration);
      timeline.max = 100;
      timeline.value = 0;
    });
    
    video.addEventListener('play', () => updatePlayIcon(true));
    video.addEventListener('pause', () => updatePlayIcon(false));
  }
  
  // Legacy controls
  const playBtn = $('#play');
  const originalBtn = $('#original');
  const viewBtn = $('#view-mode');
  
  if (playBtn) {
    playBtn.onclick = () => {
      const playing = api.togglePlayback();
      playBtn.textContent = playing ? 'Pause' : 'Play';
      updatePlayIcon(playing);
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
    
    const pad = $('#flashPad');
    const dot = $('#flashDot');
    if (pad && dot) {
      const r = pad.getBoundingClientRect();
      dot.style.left = (0.5 * r.width) + 'px';
      dot.style.top = (0.5 * r.height) + 'px';
    }
  };
}