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

// REWRITTEN TO DYNAMICALLY BUILD FILTERS FROM UI PARAMETERS
ipcMain.handle('export-video-start', async (event, { inputPath, fps, duration, params }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'output.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });

  if (canceled) {
    return { success: false, cancelled: true };
  }

  const outputPath = filePath;
  const totalFrames = Math.floor(duration * fps);

  // --- Dynamic Filter Graph Construction ---
  const filters = [];

  // 1. Exposure
  if (params.ev !== 0) {
    // FFmpeg's 'eq' brightness is roughly equivalent to exposure
    const brightness = (params.ev * 0.2).toFixed(3);
    filters.push(`eq=brightness=${brightness}`);
  }

  // 2. Tone (S-Curve, Black Crush, Lifted Blacks)
  if (params.scurve > 0.01) {
    filters.push('curves=preset=medium_contrast');
  }
  if (params.blacks > 0.001 || params.blackLift > 0.001) {
    const inputBlack = params.blacks.toFixed(3);
    const outputBlack = params.blackLift.toFixed(3);
    filters.push(`levels=black_in=${inputBlack}:black_out=${outputBlack}`);
  }

  // 3. Color (Green Shadows, Magenta Mids)
  if (params.greenShadows > 0.01 || params.magentaMids > 0.01) {
    const greenShadows = (params.greenShadows * 0.15).toFixed(3);
    const magentaMidsR = (params.magentaMids * 0.08).toFixed(3);
    const magentaMidsB = (params.magentaMids * 0.08).toFixed(3);
    filters.push(`colorbalance=gs=${greenShadows}:rm=${magentaMidsR}:bm=${magentaMidsB}`);
  }

  // 4. Optics (Vignette, Clarity, Chromatic Aberration)
  if (params.vignette > 0.001) {
    // We can make vignette stronger by chaining it
    const vigStrength = 1 + params.vignette * 1.5;
    filters.push(`vignette=eval=frame:angle=PI/3*${vigStrength}`);
  }
  if (params.clarity > 0.01) {
    const clarityAmount = (params.clarity * 2.0).toFixed(2);
    filters.push(`unsharp=5:5:${clarityAmount}:5:5:0.0`);
  }
  if (params.ca > 0.01) {
    const caAmount = Math.floor(params.ca * 1.5);
    filters.push(`chromashift=${caAmount}:${caAmount}`);
  }

  // 5. Grain
  if (params.grainAmount > 0.01) {
    const grainStrength = Math.floor(params.grainAmount * 12);
    filters.push(`noise=alls=${grainStrength}:allf=t+p`);
  }

  // 6. Final padding for compatibility
  filters.push("pad=ceil(iw/2)*2:ceil(ih/2)*2");
  
  const filterGraph = filters.join(',');

  const ffmpegArgs = [
    '-i', inputPath,
    '-vf', filterGraph,
    '-c:v', 'libx264',
    '-preset', 'fast', 
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];
  
  console.log('[EXPORT] Starting FAST native export with DYNAMIC command:');
  console.log(`ffmpeg ${ffmpegArgs.join(' ')}`);

  return new Promise((resolve) => {
    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);

    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
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
        const errorMsg = `FFmpeg exited with error code ${code}`;
        console.error(`[EXPORT] ${errorMsg}`);
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