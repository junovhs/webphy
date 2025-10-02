// webphy/main.js

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

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('export-frame', async (event, dataUrl, suggestedName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName || 'frame.webp',
    filters: [{ name: 'WebP Image', extensions: ['webp'] }],
  });
  if (canceled || !filePath) return { success: false, cancelled: true };
  try {
    const base64Data = dataUrl.replace(/^data:image\/webp;base64,/, "");
    fs.writeFileSync(filePath, base64Data, 'base64');
    return { success: true, path: filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Main export handler
ipcMain.handle('export-video-start', async (event, config) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'output.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });

  if (canceled) {
    return { success: false, cancelled: true };
  }

  const outputPath = filePath;
  const { inputPath, width, height, fps, duration, params } = config;
  const totalFrames = Math.floor(duration * fps);
  
  // --- CRITICAL FIX: Sanitize dimensions for H.264 compatibility ---
  // Ensure width and height are even numbers by rounding down.
  const safeWidth = Math.floor(width / 2) * 2;
  const safeHeight = Math.floor(height / 2) * 2;
  console.log(`[EXPORT] Original dimensions: ${width}x${height}. Sanitized for encoder: ${safeWidth}x${safeHeight}`);

  const exportWindow = new BrowserWindow({
    show: false,
    width: safeWidth,
    height: safeHeight,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,
    },
  });
  exportWindow.loadFile(path.join(__dirname, 'web/export.html'));
  
  return new Promise((resolve) => {
    let decoder, encoder;
    let frameCounter = 0;
    let rendererReady = false;
    let processing = false;

    const processNextFrame = () => {
      if (!rendererReady || processing) return;
      
      const frameSize = safeWidth * safeHeight * 4; // Use safe dimensions
      const frameBuffer = decoder.stdout.read(frameSize);

      if (frameBuffer) {
        processing = true;
        exportWindow.webContents.send('export-frame-data', {
          frameNumber: frameCounter,
          pixels: frameBuffer.buffer
        }, [frameBuffer.buffer]);
      }
    };

    ipcMain.once('export-renderer-ready', () => {
      rendererReady = true;
      console.log("[EXPORT] Renderer is ready. Starting video pipeline.");
      processNextFrame();
    });

    ipcMain.on('export-frame-result', (event, { frameNumber, pixels }) => {
      encoder.stdin.write(Buffer.from(pixels));
      processing = false;
      frameCounter++;
      
      const progress = Math.min(100, Math.round((frameCounter / totalFrames) * 100));
      mainWindow.webContents.send('export-progress', { progress, frameIndex: frameCounter, totalFrames });
      
      if (frameCounter >= totalFrames) {
        if(decoder && !decoder.killed) decoder.kill();
        if(encoder && encoder.stdin) encoder.stdin.end();
      } else {
        processNextFrame();
      }
    });

    ipcMain.once('export-error', (event, error) => {
      console.error("[EXPORT] Renderer error:", error);
      if (decoder) decoder.kill();
      if (encoder) encoder.kill();
      if (exportWindow && !exportWindow.isDestroyed()) exportWindow.close();
      resolve({ success: false, error: `Renderer Error: ${error}` });
    });

    // 1. FFmpeg DECODER: Use SAFE dimensions for scaling
    const decoderArgs = [
      '-i', inputPath,
      '-r', String(fps),
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-vf', `scale=${safeWidth}:${safeHeight}`, // Use safe dimensions
      '-'
    ];
    decoder = spawn(ffmpegPath, decoderArgs);
    decoder.stdout.on('readable', processNextFrame);
    decoder.stderr.on('data', data => console.log(`[DECODER]: ${data.toString()}`));
    decoder.on('close', (code) => { 
        if (code !== 0 && frameCounter < totalFrames) console.error(`[DECODER] Exited unexpectedly with code ${code}`);
    });

    // 2. FFmpeg ENCODER: Use SAFE dimensions for input stream
    const encoderArgs = [
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${safeWidth}x${safeHeight}`, // Use safe dimensions
      '-r', String(fps),
      '-i', '-',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y',
      outputPath
    ];
    encoder = spawn(ffmpegPath, encoderArgs);
    encoder.stderr.on('data', data => console.log(`[ENCODER]: ${data.toString()}`));
    encoder.on('close', (code) => {
      ipcMain.removeAllListeners('export-frame-result');
      if (exportWindow && !exportWindow.isDestroyed()) exportWindow.close();
      
      if (code === 0) {
        mainWindow.webContents.send('export-complete', { success: true });
        resolve({ success: true });
      } else {
        const msg = `Encoder exited with code ${code}. Check logs for details.`;
        mainWindow.webContents.send('export-complete', { success: false, error: msg });
        resolve({ success: false, error: msg });
      }
    });

    // Initialize the renderer with the SAFE dimensions
    exportWindow.webContents.once('dom-ready', () => {
      exportWindow.webContents.send('init-export', { width: safeWidth, height: safeHeight, params });
    });
  });
});