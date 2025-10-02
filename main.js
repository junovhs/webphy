const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const os = require('os');

// Set FFmpeg path (you'll need to bundle ffmpeg binary or have user install it)
// For bundled: point to resources/bin/ffmpeg
// For now assumes system ffmpeg
try {
  const ffmpegPath = require('ffmpeg-static');
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch (e) {
  // Fall back to system ffmpeg
  console.log('Using system FFmpeg');
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'web', 'index.html'));
  
  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers

// Open file dialog
ipcMain.handle('open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Media', extensions: ['mp4', 'mov', 'webm', 'jpg', 'jpeg', 'png', 'webp'] }
    ]
  });

  if (result.canceled) {
    return null;
  }

  return result.filePaths[0];
});

// Export single frame
ipcMain.handle('export-frame', async (event, frameDataUrl, suggestedName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName || 'frame.webp',
    filters: [
      { name: 'WebP Image', extensions: ['webp'] }
    ]
  });

  if (result.canceled) {
    return { success: false, cancelled: true };
  }

  try {
    // Convert data URL to buffer
    const base64Data = frameDataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    fs.writeFileSync(result.filePath, buffer);
    return { success: true, path: result.filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Export video - receives frame data URLs one at a time
ipcMain.handle('export-video-start', async (event, { width, height, fps }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'output.mp4',
    filters: [
      { name: 'MP4 Video', extensions: ['mp4'] }
    ]
  });

  if (result.canceled) {
    return { success: false, cancelled: true };
  }

  // Create temp directory for frames
  const tempDir = path.join(os.tmpdir(), `disposable-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  return {
    success: true,
    exportId: tempDir,
    outputPath: result.filePath,
    fps: fps || 30
  };
});

// Receive individual frame
ipcMain.handle('export-video-frame', async (event, { exportId, frameIndex, frameDataUrl }) => {
  try {
    const base64Data = frameDataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    const framePath = path.join(exportId, `frame_${String(frameIndex).padStart(6, '0')}.png`);
    fs.writeFileSync(framePath, buffer);
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Finalize video export
ipcMain.handle('export-video-finish', async (event, { exportId, outputPath, fps }) => {
  return new Promise((resolve) => {
    console.log(`[FFMPEG] Starting encode: ${exportId} -> ${outputPath}`);
    
    ffmpeg()
      .input(path.join(exportId, 'frame_%06d.png'))
      .inputFPS(fps)
      .videoCodec('libx264')
      .outputOptions([
        '-pix_fmt yuv420p',
        '-crf 18',
        '-preset medium',
        '-movflags +faststart'
      ])
      .on('start', (cmd) => {
        console.log('[FFMPEG] Command:', cmd);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          mainWindow.webContents.send('export-progress', {
            percent: Math.round(progress.percent)
          });
        }
      })
      .on('end', () => {
        console.log('[FFMPEG] Encode complete');
        
        // Cleanup temp frames
        try {
          fs.rmSync(exportId, { recursive: true, force: true });
        } catch (e) {
          console.error('Cleanup error:', e);
        }
        
        resolve({ success: true, path: outputPath });
      })
      .on('error', (err) => {
        console.error('[FFMPEG] Error:', err);
        resolve({ success: false, error: err.message });
      })
      .save(outputPath);
  });
});

// Cancel export
ipcMain.handle('export-video-cancel', async (event, { exportId }) => {
  try {
    fs.rmSync(exportId, { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});