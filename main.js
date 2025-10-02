// main.js

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'web/index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// --- IPC Handlers ---

ipcMain.handle('export-frame', async (event, dataUrl, suggestedName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName || 'frame.webp',
    filters: [{ name: 'WebP Image', extensions: ['webp'] }],
  });

  if (canceled || !filePath) {
    return { success: false, cancelled: true };
  }

  try {
    const base64Data = dataUrl.replace(/^data:image\/webp;base64,/, "");
    fs.writeFileSync(filePath, base64Data, 'base64');
    return { success: true, path: filePath };
  } catch (error) {
    console.error('Failed to save frame:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Translates UI slider values into a robust FFmpeg filter string.
 * This version uses stable filters to prevent crashes.
 * @param {object} params - The state object from the UI.
 * @returns {string} A comma-separated FFmpeg filter graph string.
 */
function buildFilterGraph(params) {
  const filters = [];

  // --- 1. Exposure (from exposure-flash.js) ---
  const exposure = params.ev || 0;
  if (Math.abs(exposure) > 0.01) {
    filters.push(`lutyuv=y='val*pow(2,${exposure})'`);
  }

  // --- 2. Tone (from tone.js) - ROBUST IMPLEMENTATION ---
  // *** DEFINITIVE FIX: Using the stable 'eq' filter instead of buggy 'curves' or 'geq'. ***
  // This simulates Lifted Blacks by raising gamma and S-Curve with contrast.
  const lift = params.blackLift || 0;
  const scurve = params.scurve || 0;
  const contrast = 1 + (scurve * 0.3); // Map S-curve slider to contrast
  const gamma = 1 + (lift * 0.3); // Map Lifted Blacks to gamma
  filters.push(`eq=contrast=${contrast}:gamma=${gamma}`);

  // --- 3. Flash (from exposure-flash.js) ---
  if (params.flashStrength > 0.01) {
    const { flashStrength, flashFalloff, flashCenterX, flashCenterY } = params;
    const flashEq = `p(X,Y) * (1 + ${flashStrength} / (1 + pow(${flashFalloff} * hypot(X-(${(1.0 - flashCenterX)}*W), Y-(${flashCenterY}*H)) / W, 2)))`;
    filters.push(`geq=r='${flashEq}':g='${flashEq}':b='${flashEq}'`);
  }
  
  // --- 4. Color Cast (from split-cast.js) ---
  const green = params.greenShadows * 0.08;
  const magenta = params.magentaMids * 0.06;
  if (green > 0.005 || magenta > 0.005) {
      filters.push(`colorbalance=gs=${green}:rm=${magenta}:bm=${magenta}`);
  }

  // --- 5. Bloom & Halation (Approximation) ---
  if (params.bloomIntensity > 0.01) {
    const bloom = params.bloomIntensity * 0.4;
    filters.push(`unsharp=5:5:-${bloom}`); // Negative unsharp creates a blur/glow
  }
  if (params.halation > 0.01) {
    filters.push(`colorbalance=rh=${params.halation * 0.05}`);
  }
  
  // --- 6. Optics (Vignette, Clarity, CA) ---
  if (params.vignette > 0.01) {
    const strength = 1.0 + params.vignette * 0.5 + (params.vignettePower - 1.0) * 0.2;
    filters.push(`vignette=eval=strength(${strength})`);
  }
  if (params.clarity > 0.01) {
    const strength = (params.clarity * 2.0).toFixed(2);
    filters.push(`unsharp=5:5:${strength}:5:5:0.0`);
  }
  if (params.ca > 0.01) {
    const shift = (params.ca * 1.0).toFixed(2);
    filters.push(`chromashift=cbh=-${shift}:crh=${shift}`);
  }

  // --- 7. Motion Blur (from motion-blur.js) ---
  if (params.shutterUI > 0.1) {
    const framesToMix = 1 + Math.floor(params.shutterUI * 9);
    if (framesToMix > 1) {
      filters.push(`tmix=frames=${framesToMix}:weights=1`);
    }
  }

  // --- 8. Grain ---
  filters.push("noise=alls=15:allf=t:c0s=7:c1s=7");

  // --- Finalization ---
  filters.push("format=yuv420p");
  filters.push("pad=ceil(iw/2)*2:ceil(ih/2)*2");
  
  return filters.join(',');
}

ipcMain.handle('export-video-start', async (event, { inputPath, width, height, fps, duration, params }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'output.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });

  if (canceled) {
    return { success: false, cancelled: true };
  }

  const outputPath = filePath;
  const totalFrames = Math.floor(duration * fps);

  // Build the filter graph dynamically from UI params
  const filterGraph = buildFilterGraph(params);

  const ffmpegArgs = [
    '-i', inputPath,
    '-vf', filterGraph,
    '-c:v', 'libx264',
    '-preset', 'fast', 
    '-crf', '20',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];
  
  console.log('[EXPORT] Starting DYNAMIC native export with command:');
  console.log(`ffmpeg ${ffmpegArgs.join(' ')}`);

  return new Promise((resolve) => {
    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);

    let stderrOutput = '';
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      stderrOutput += output;
      
      const frameMatch = output.match(/frame=\s*(\d+)/);
      if (frameMatch) {
        const currentFrame = parseInt(frameMatch[1], 10);
        const progress = totalFrames > 0 ? Math.min(100, Math.round((currentFrame / totalFrames) * 100)) : 0;
        mainWindow.webContents.send('export-progress', { progress, frameIndex: currentFrame, totalFrames });
      }
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        console.log('[EXPORT] Native export completed successfully.');
        mainWindow.webContents.send('export-complete', { success: true, outputPath });
        resolve({ success: true });
      } else {
        const errorMsg = `FFmpeg exited with error code ${code}. Check console for details.`;
        console.error(`[EXPORT] ${errorMsg}\nFFMPEG Log:\n${stderrOutput}`);
        mainWindow.webContents.send('export-complete', { success: false, error: errorMsg });
        resolve({ success: false, error: errorMsg });
      }
    });

    ffmpegProcess.on('error', (err) => {
        console.error('[EXPORT] Failed to start FFmpeg process.', err);
        mainWindow.webContents.send('export-complete', { success: false, error: 'Failed to start FFmpeg process.' });
        resolve({ success: false, error: err.message });
    });
  });
});