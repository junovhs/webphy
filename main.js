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

// REWRITTEN WITH A MORE ACCURATE AND COLOR-CORRECT FILTER GRAPH
ipcMain.handle('export-video-start', async (event, { inputPath, width, height, fps, duration }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'output.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });

  if (canceled) {
    return { success: false, cancelled: true };
  }

  const outputPath = filePath;
  const totalFrames = Math.floor(duration * fps);

  // This new filter graph is more robust and produces a look much closer
  // to the WebGL renderer's disposable camera aesthetic.
  const filterGraph = [
    // 1. Apply a standard contrast S-curve first
    "curves=preset=medium_contrast",
    // 2. Use colorbalance for proper tinting of shadows/mids
    // Adds green to shadows and a slight magenta cast to midtones
    "colorbalance=gs=0.08:rm=0.05:bm=0.05",
    // 3. Optics: Default vignette
    "vignette",
    // 4. Optics: Clarity via unsharp mask
    "unsharp=5:5:0.6:5:5:0.0",
    // 5. Grain: Much stronger noise to avoid the "smooth" look
    "noise=alls=20:allf=t",
    // 6. Ensure dimensions are even for H.264 compatibility
    "pad=ceil(iw/2)*2:ceil(ih/2)*2"
  ].join(',');

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
  
  console.log('[EXPORT] Starting FAST native export with NEW command:');
  console.log(`ffmpeg ${ffmpegArgs.join(' ')}`);

  return new Promise((resolve) => {
    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);

    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Parse progress from FFmpeg's stderr
      const frameMatch = output.match(/frame=\s*(\d+)/);
      if (frameMatch) {
        const currentFrame = parseInt(frameMatch[1], 10);
        // Ensure totalFrames is not zero to avoid division by zero
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