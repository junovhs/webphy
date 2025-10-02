// webphy/main.js

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

let mainWindow;
let exportTempDir = null; 
let exportOutputPath = null;

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
  // mainWindow.webContents.openDevTools(); // Uncomment for debugging
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

// STAGE 1: Initialize the export
ipcMain.handle('export-video-initialize', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'output.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });

  if (canceled) {
    return { success: false, cancelled: true };
  }

  try {
    exportTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disposable-night-'));
    exportOutputPath = filePath;
    console.log(`[EXPORT] Temp directory for frames created at: ${exportTempDir}`);
    return { success: true };
  } catch (error) {
    console.error('[EXPORT] Failed to create temp directory:', error);
    return { success: false, error: 'Failed to create temporary directory.' };
  }
});

// STAGE 2: Receive and write frames (now handles efficient Uint8Array)
ipcMain.on('export-video-write-frame', (event, { frameIndex, frameBuffer }) => {
  if (!exportTempDir) return;
  
  try {
    // Convert the received ArrayBuffer into a Node.js Buffer and write to disk
    const buffer = Buffer.from(frameBuffer);
    const framePath = path.join(exportTempDir, `frame_${String(frameIndex).padStart(6, '0')}.png`);
    fs.writeFileSync(framePath, buffer);
  } catch (error) {
    console.error(`[EXPORT] Failed to write frame ${frameIndex} to disk:`, error);
  }
});

// STAGE 3: Finalize the export
ipcMain.handle('export-video-finalize', async (event, { fps, totalFrames }) => {
  if (!exportTempDir || !exportOutputPath) {
    return { success: false, error: 'Export process was not correctly initialized.' };
  }

  const ffmpegArgs = [
    '-framerate', String(fps),
    '-i', path.join(exportTempDir, 'frame_%06d.png'),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'medium',
    '-crf', '18',
    '-movflags', '+faststart',
    '-y',
    exportOutputPath,
  ];

  console.log('[EXPORT] Finalizing video by stitching frames with command:');
  console.log(`${ffmpegPath} ${ffmpegArgs.join(' ')}`);

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
      try {
        if (exportTempDir) {
          fs.rmSync(exportTempDir, { recursive: true, force: true });
          console.log(`[EXPORT] Successfully cleaned up temp directory: ${exportTempDir}`);
        }
      } catch (e) {
        console.error('[EXPORT] CRITICAL: Failed to clean up temp directory:', e);
      }
      exportTempDir = null;
      exportOutputPath = null;

      if (code === 0) {
        console.log('[EXPORT] FFmpeg stitching process completed successfully.');
        mainWindow.webContents.send('export-complete', { success: true, outputPath: exportOutputPath });
        resolve({ success: true });
      } else {
        const errorMsg = `FFmpeg exited with error code ${code}. The video was not created.`;
        console.error(`[EXPORT] ${errorMsg}\n--- FFMPEG LOG ---\n${stderrOutput}\n--- END LOG ---`);
        mainWindow.webContents.send('export-complete', { success: false, error: errorMsg });
        resolve({ success: false, error: errorMsg });
      }
    });

    ffmpegProcess.on('error', (err) => {
        console.error('[EXPORT] Failed to start FFmpeg stitching process.', err);
        mainWindow.webContents.send('export-complete', { success: false, error: 'Failed to start FFmpeg.' });
        resolve({ success: false, error: err.message });
    });
  });
});