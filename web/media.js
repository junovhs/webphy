// Media UI controls - pure callback-based

const $ = s => document.querySelector(s);
const FRAME_RATE_TARGET = 30; // for frame scrubbing

export function initMedia(api) {
  setupFileInput(api);
  setupTransportControls(api);
  setupResetButton(api);
}

function setupFileInput(api) {
  $('#file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    
    // *** THIS IS THE DEFINITIVE FIX ***
    const exportBtn = $('#export-btn');
    const isVideo = (file.type || '').startsWith('video/');
    
    if (isVideo) {
      api.loadVideo(file);
      $('#transport-bar').classList.remove('hidden');
      if (exportBtn) exportBtn.textContent = 'Export MP4'; // Directly set the text here
      if (typeof window.electronAPI !== 'undefined' && file.path) {
        api.setState('sourceVideoPath', file.path);
      }
    } else {
      api.loadImage(file);
      $('#transport-bar').classList.add('hidden');
      if (exportBtn) exportBtn.textContent = 'Export Image'; // And here for images
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
  const prevFrameBtn = $('#prev-frame');
  const nextFrameBtn = $('#next-frame');
  const timeline = $('#timeline');
  const currentTime = $('#current-time');
  const durationTime = $('#duration-time');
  const playIcon = $('#play-icon');
  const pauseIcon = $('#pause-icon');
  
  function updatePlayIcon(playing) {
    if (!playIcon || !pauseIcon) return;
    playIcon.style.display = playing ? 'none' : 'block';
    pauseIcon.style.display = playing ? 'block' : 'none';
  }
  
  function scrubFrames(direction) {
    if (!api.getState('isVideo')) return;
    video.pause();
    const frameDuration = 1 / FRAME_RATE_TARGET;
    const newTime = video.currentTime + (frameDuration * direction);
    video.currentTime = Math.max(0, Math.min(video.duration, newTime));
  }

  if (transportPlay) transportPlay.onclick = () => { if (api.getState('isVideo')) video.paused ? video.play() : video.pause(); };
  if (prevFrameBtn) prevFrameBtn.onclick = () => scrubFrames(-1);
  if (nextFrameBtn) nextFrameBtn.onclick = () => scrubFrames(1);
  
  if (timeline) {
    let seeking = false;
    const updateTimelineProgress = () => {
      const percent = (video.currentTime / video.duration) * 100;
      timeline.style.setProperty('--timeline-progress', `${percent}%`);
      timeline.value = percent || 0;
      if (currentTime) currentTime.textContent = formatTime(video.currentTime);
    };

    timeline.addEventListener('mousedown', () => { if(api.getState('isVideo')) { seeking = true; video.pause(); }});
    timeline.addEventListener('input', (e) => {
      if (!api.getState('isVideo') || !seeking) return;
      const percent = parseFloat(e.target.value);
      video.currentTime = (percent / 100) * video.duration;
    });
    window.addEventListener('mouseup', () => { if(seeking) { seeking = false; }});
    
    video.addEventListener('seeked', () => {
      if (seeking) {
        api.renderCurrentFrame();
        updateTimelineProgress();
      }
    });

    video.addEventListener('timeupdate', () => { if (!seeking) updateTimelineProgress(); });
    video.addEventListener('loadedmetadata', () => {
      if (durationTime) durationTime.textContent = formatTime(video.duration);
      timeline.max = 100;
      updateTimelineProgress();
    });
    
    video.addEventListener('play', () => updatePlayIcon(true));
    video.addEventListener('pause', () => updatePlayIcon(false));
  }
  
  const originalBtn = $('#original');
  const viewBtn = $('#view-mode');
  
  if (originalBtn) originalBtn.onclick = () => { originalBtn.classList.toggle('active', api.toggleOriginal()); };
  if (viewBtn) viewBtn.onclick = () => { viewBtn.textContent = api.toggleViewMode() === 'fit' ? 'Fit' : '1:1'; };
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
  };
}