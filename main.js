// webphy/main.js

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// ---------- Debug / logging ----------
const DEBUG_PROBES = true; // flip to false to silence structured logs

function jlog(entry) {
  try {
    const e = {
      ts: new Date().toISOString(),
      level: entry.level || 'info',
      rid: entry.rid || null,
      subsystem: entry.subsystem || 'export',
      action: entry.action || null,
      code: entry.code || null,
      msg: entry.msg || '',
      context: entry.context || {}
    };
    console.log(JSON.stringify(e));
  } catch {
    // never throw from logger
  }
}

// ---------- App window ----------
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

// ---------- Small helper: fast audio detection (no ffprobe dep) ----------
function detectAudioStream(inputPath, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let found = false;
    let finished = false;

    // Use ffmpeg header parse; do not decode full file.
    const args = ['-hide_banner', '-i', inputPath];
    const p = spawn(ffmpegPath, args, { windowsHide: true });

    const done = (val) => {
      if (finished) return;
      finished = true;
      try { p.kill('SIGKILL'); } catch {}
      resolve(!!val);
    };

    const killTimer = setTimeout(() => {
      if (DEBUG_PROBES) jlog({ action: 'probe_timeout', msg: 'Audio probe timed out', context: { inputPath } });
      done(found);
    }, timeoutMs);

    p.stderr.on('data', (buf) => {
      const s = buf.toString();
      // Typical: "Stream #0:1: Audio: aac, 48000 Hz, stereo ..."
      if (s.includes('Audio:')) {
        found = true;
        if (DEBUG_PROBES) jlog({ action: 'probe_detect', msg: 'Audio stream detected', context: { inputPath } });
        clearTimeout(killTimer);
        done(true);
      }
    });

    p.on('close', () => {
      clearTimeout(killTimer);
      done(found);
    });

    p.on('error', (err) => {
      if (DEBUG_PROBES) jlog({ level: 'error', action: 'probe_spawn_error', code: 'EXP_PROBE_SPAWN', msg: String(err) });
      clearTimeout(killTimer);
      done(false);
    });
  });
}

// Expose probe to renderer
ipcMain.handle('probe-audio', async (_evt, inputPath) => {
  try {
    const hasAudio = await detectAudioStream(inputPath);
    return { success: true, hasAudio };
  } catch (err) {
    return { success: false, hasAudio: false, error: String(err) };
  }
});

// ---------- Still image export (unchanged) ----------
ipcMain.handle('export-frame', async (_event, dataUrl, suggestedName) => {
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

// ---------- Video export (GPU->readPixels -> rawpipe -> x264 [+ optional audio]) ----------
ipcMain.handle('export-video-start', async (_event, config) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'output.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });

  if (canceled) {
    return { success: false, cancelled: true };
  }

  const outputPath = filePath;
  const { inputPath, width, height, fps, duration, params, includeAudio } = config;
const audioVolume = (typeof config.audioVolume === 'number' && config.audioVolume >= 0 && config.audioVolume <= 1)
  ? config.audioVolume
  : 1.0;
  const totalFrames = Math.floor(duration * fps);

  // Enforce even dimensions for H.264
  const safeWidth  = Math.floor(width  / 2) * 2;
  const safeHeight = Math.floor(height / 2) * 2;

  jlog({
    action: 'export_start',
    msg: 'Begin export',
    context: { inputPath, outputPath, width, height, safeWidth, safeHeight, fps, duration, includeAudio: !!includeAudio, audioVolume }
  });


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

  return new Promise(async (resolve) => {
    let decoder, encoder;
    let frameCounter = 0;
    let rendererReady = false;
    let processing = false;

    // Decide audio plan up front (defense in depth: recheck)
    const sourceHasAudio = includeAudio ? await detectAudioStream(inputPath) : false;
    if (includeAudio && !sourceHasAudio) {
      jlog({ level: 'warn', action: 'audio_requested_but_missing', code: 'EXP_NO_AUDIO', msg: 'Include audio requested, but source has no audio' });
    }

    const encoderArgs = (() => {
      const baseIn = [
        // stdin raw RGBA
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba',
        '-s', `${safeWidth}x${safeHeight}`,
        '-r', String(fps),
        '-i', '-', // Input #0: raw video from our renderer
      ];

      if (includeAudio && sourceHasAudio) {
        return [
          ...baseIn,
          // Input #1: original media file (for audio only)
          '-i', inputPath,
          // mapping
          '-map', '0:v:0',
          '-map', '1:a:0',
          // audio volume filter (linear 0.0–1.0; identity at 1.0)
          '-filter:a', `volume=${audioVolume}`,
          // codecs
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '18',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', '192k',
          // container/flags
          '-movflags', '+faststart',
          // stop when video ends even if audio longer/shorter
          '-shortest',
          '-y',
          outputPath
        ];
      }

      // Video-only
      return [
        ...baseIn,
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y',
        outputPath
      ];
    })();

    const decoderArgs = [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-vf', `scale=${safeWidth}:${safeHeight}:flags=lanczos,fps=${fps}`,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      'pipe:1'
    ];

    const processNextFrame = () => {
      if (!rendererReady || processing) return;
      const frameSize = safeWidth * safeHeight * 4;
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
      jlog({ action: 'renderer_ready', msg: 'Headless renderer ready' });
      processNextFrame();
    });

    ipcMain.on('export-frame-result', (_evt, { frameNumber, pixels }) => {
      try {
        if (encoder?.stdin && !encoder.stdin.writableEnded) {
          encoder.stdin.write(Buffer.from(pixels));
        }
      } catch (err) {
        jlog({ level: 'error', action: 'encoder_write', code: 'EXP_ENCODER_WRITE', msg: String(err) });
      }
      processing = false;
      frameCounter++;

      const progress = Math.min(100, Math.round((frameCounter / totalFrames) * 100));
      mainWindow.webContents.send('export-progress', { progress, frameIndex: frameCounter, totalFrames });

      if (frameCounter >= totalFrames) {
        if (decoder && !decoder.killed) decoder.kill();
        if (encoder && encoder.stdin) encoder.stdin.end();
      } else {
        processNextFrame();
      }
    });

    ipcMain.once('export-error', (_evt, error) => {
      jlog({ level: 'error', action: 'renderer_error', code: 'EXP_RENDERER_ERR', msg: String(error) });
      if (decoder) decoder.kill();
      if (encoder) try { encoder.kill(); } catch {}
      if (exportWindow && !exportWindow.isDestroyed()) exportWindow.close();
      mainWindow.webContents.send('export-complete', { success: false, error: `Renderer Error: ${error}`, code: 'EXP_RENDERER_ERR' });
      resolve({ success: false, error: `Renderer Error: ${error}` });
    });

    // Spawn decoder
    try {
      decoder = spawn(ffmpegPath, decoderArgs, { windowsHide: true });
      if (DEBUG_PROBES) jlog({ action: 'spawn_decoder', msg: 'Decoder spawned', context: { args: decoderArgs } });
      decoder.stderr.on('data', d => jlog({ level: 'info', subsystem: 'ffmpeg-decoder', action: 'stderr', msg: d.toString().trim() }));
      decoder.stdout.on('readable', processNextFrame);

      // NEW: when decoder hits EOF, close the encoder stdin so ffmpeg can finish even if fewer frames arrived than estimated
      decoder.stdout.on('end', () => {
        jlog({ action: 'decoder_eof', msg: 'Decoder stdout ended' });
        try { if (encoder?.stdin && !encoder.stdin.writableEnded) encoder.stdin.end(); } catch {}
      });

      decoder.on('close', (code) => {
        jlog({ action: 'decoder_close', msg: 'Decoder closed', context: { code } });
        // Defense-in-depth: ensure stdin closed if not already
        try { if (encoder?.stdin && !encoder.stdin.writableEnded) encoder.stdin.end(); } catch {}
      });
    } catch (err) {
      jlog({ level: 'error', action: 'spawn_decoder_fail', code: 'EXP_DECODER_SPAWN', msg: String(err) });
      mainWindow.webContents.send('export-complete', { success: false, error: 'Failed to start decoder', code: 'EXP_DECODER_SPAWN' });
      return resolve({ success: false, error: 'Failed to start decoder' });
    }

    // Spawn encoder
    try {
      encoder = spawn(ffmpegPath, encoderArgs, { windowsHide: true });
      if (DEBUG_PROBES) jlog({ action: 'spawn_encoder', msg: 'Encoder spawned', context: { args: encoderArgs } });
      encoder.stderr.on('data', d => jlog({ level: 'info', subsystem: 'ffmpeg-encoder', action: 'stderr', msg: d.toString().trim() }));
      encoder.on('close', (code) => {
        ipcMain.removeAllListeners('export-frame-result');
        if (exportWindow && !exportWindow.isDestroyed()) exportWindow.close();

        if (code === 0) {
          jlog({ action: 'encoder_exit', msg: 'Encoder completed ok' });
          mainWindow.webContents.send('export-complete', { success: true, outputPath });
          resolve({ success: true, outputPath });
        } else {
          const msg = `Encoder exited with code ${code}.`;
          jlog({ level: 'error', action: 'encoder_exit', code: 'EXP_ENCODER_EXIT', msg, context: { code } });
          mainWindow.webContents.send('export-complete', { success: false, error: msg, code: 'EXP_ENCODER_EXIT' });
          resolve({ success: false, error: msg });
        }
      });
    } catch (err) {
      jlog({ level: 'error', action: 'spawn_encoder_fail', code: 'EXP_ENCODER_SPAWN', msg: String(err) });
      mainWindow.webContents.send('export-complete', { success: false, error: 'Failed to start encoder', code: 'EXP_ENCODER_SPAWN' });
      return resolve({ success: false, error: 'Failed to start encoder' });
    }

    // Initialize the renderer with SAFE dimensions
    exportWindow.webContents.once('dom-ready', () => {
      exportWindow.webContents.send('init-export', { width: safeWidth, height: safeHeight, params });
    });
  });
});
