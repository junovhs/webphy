// Pure UI - no knowledge of app internals
// Receives everything through the API contract

const $ = s => document.querySelector(s);

export function initUI(api) {
  generateControls(api);
  setupTabs();
  bindControls(api);
  setupCanvasInteraction(api);
}

function generateControls(api) {
  const tabNav = $('#tab-nav');
  const tabContent = $('#tab-content');
  
  api.tabs.forEach(tab => {
    // Tab button
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.textContent = tab.label;
    btn.dataset.tab = tab.id;
    tabNav.appendChild(btn);
    
    // Tab pane
    const pane = document.createElement('div');
    pane.className = 'tab-pane';
    pane.dataset.pane = tab.id;
    
    {
      if (tab.hasFlashPad) {
        // Generate the new instruction element instead of the pad
        pane.appendChild(createFlashPadControl());
      }
      
      tab.params.forEach(key => {
        const config = api.params[key];
        if (config) pane.appendChild(createParamControl(key, config, api));
      });
    }
    
    tabContent.appendChild(pane);
  });
  
  tabNav.querySelector('.tab').classList.add('active');
  tabContent.querySelector('.tab-pane').classList.add('active');
}

function createFlashPadControl() {
  const el = document.createElement('div');
  el.className = 'control';
  el.innerHTML = `
    <div class="control-header">
      <span class="control-label">Flash Position</span>
    </div>
    <div class="flash-instruction" id="flashInstruction">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14"/>
            <path d="M12 5v14"/>
            <circle cx="12" cy="12" r="10"/>
        </svg>
        <span>Click or drag on the image to position the flash.</span>
    </div>
  `;
  return el;
}


function formatValue(api, config, value) {
  return config.special === 'shutter'
    ? api.formatShutterSpeed(value)
    : api.formatParamValue(value, config);
}

function createParamControl(key, config, api) {
  const el = document.createElement('div');
  el.className = 'control';
  el.dataset.param = key;
  if (config.grainMode) el.dataset.grainMode = config.grainMode;
  
  const value = api.getState(key);
  const displayValue = formatValue(api, config, value);
  
  if (Array.isArray(config.options)) {
    const options = config.options.map((label, index) =>
      `<option value="${index}" ${Math.round(value) === index ? 'selected' : ''}>${label}</option>`
    ).join('');
    el.innerHTML = `
      <div class="control-header">
        <span class="control-label">${config.label}</span>
        <span class="control-value" data-for="${key}">${displayValue}</span>
      </div>
      <select class="control-select" id="${key}">${options}</select>
    `;
  } else {
    el.innerHTML = `
      <div class="control-header">
        <span class="control-label">${config.label}</span>
        <span class="control-value" data-for="${key}">${displayValue}</span>
      </div>
      <input type="range" id="${key}" min="${config.min}" max="${config.max}" 
             step="${config.step}" value="${value}">
    `;
  }
  
  return el;
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector(`[data-pane="${tab.dataset.tab}"]`).classList.add('active');
    });
  });
}

function bindControls(api) {
  Object.entries(api.params).forEach(([key, config]) => {
    const el = $(`#${key}`);
    if (!el) return;
    
    const eventName = Array.isArray(config.options) ? 'change' : 'input';
    el.addEventListener(eventName, e => {
      const value = parseFloat(e.target.value);
      api.setState(key, value);
      
      const lbl = $(`.control-value[data-for="${key}"]`);
      if (lbl) lbl.textContent = formatValue(api, config, value);

      if (key === 'grainMode') refreshConditionalControls(api);
    });
  });

  refreshConditionalControls(api);
}

function refreshConditionalControls(api) {
  const grainMode = Math.round(Number(api.getState('grainMode')) || 0) === 1 ? 'performant' : 'baked';

  document.querySelectorAll('[data-grain-mode]').forEach(el => {
    const visible = el.dataset.grainMode === grainMode;
    el.classList.toggle('hidden-control', !visible);
  });

  const pane = document.querySelector('[data-pane="grain"]');
  if (!pane) return;
  pane.dataset.activeGrainMode = grainMode;
}

// REMOVED setupFlashPad() function

function setupCanvasInteraction(api) {
  const canvas = $('#gl');
  
  const updateFlashFromCanvas = (cx, cy) => {
    const r = canvas.getBoundingClientRect();
    const fx = (cx - r.left) / r.width;
    const fy = (cy - r.top) / r.height;
    api.setState('flashCenterX', 1.0 - Math.max(0, Math.min(1, fx)));
    api.setState('flashCenterY', 1.0 - Math.max(0, Math.min(1, fy)));
  };
  
  let panStart = { x: 0, y: 0, ox: 0, oy: 0 };
  
  createPointerTracker(canvas, (cx, cy, isStart) => {
    if (api.getState('viewMode') === '1x') {
      if (isStart) {
        canvas.classList.add('dragging');
        panStart = { x: cx, y: cy, ox: api.getState('panX') || 0, oy: api.getState('panY') || 0 };
      } else {
        const dx = cx - panStart.x;
        const dy = cy - panStart.y;
        api.setState('panX', panStart.ox + dx);
        api.setState('panY', panStart.oy + dy);
        api.layout();
      }
    } else {
      updateFlashFromCanvas(cx, cy);
    }
  }, false, () => canvas.classList.remove('dragging'));
}

function createPointerTracker(element, onMove, preventDefault = false, onEnd = null) {
  let active = false;
  
  const getPos = e => ({
    x: e.clientX ?? e.touches?.[0]?.clientX,
    y: e.clientY ?? e.touches?.[0]?.clientY
  });
  
  const start = e => {
    active = true;
    const { x, y } = getPos(e);
    onMove(x, y, true);
    if (preventDefault) e.preventDefault();
  };
  
  const move = e => {
    if (!active) return;
    const { x, y } = getPos(e);
    onMove(x, y, false);
    if (preventDefault) e.preventDefault();
  };
  
  const end = () => {
    active = false;
    if (onEnd) onEnd();
  };
  
  element.addEventListener('mousedown', start);
  element.addEventListener('touchstart', start, { passive: !preventDefault });
  window.addEventListener('mousemove', move);
  window.addEventListener('touchmove', move, { passive: !preventDefault });
  window.addEventListener('mouseup', end);
  window.addEventListener('touchend', end);
}