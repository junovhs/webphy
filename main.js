// webphy/main.js

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
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


// ---------- Performant grain kit writer ----------
function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(v) || 0));
}

function grainTileSize(params) {
  const idx = Math.round(Number(params.performantGrainTile) || 1);
  return [128, 256, 512][Math.max(0, Math.min(2, idx))] || 256;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function signedPow(value, power) {
  return Math.sign(value) * Math.pow(Math.abs(value), power);
}

function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}

const CRC32_TABLE = makeCrc32Table();

function crc32(buffers) {
  let c = 0xFFFFFFFF;
  for (const buffer of buffers) {
    for (let i = 0; i < buffer.length; i++) c = CRC32_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([typeBuffer, data]), 0);
  return Buffer.concat([len, typeBuffer, data, crc]);
}

function makePngRgba(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makePerformantGrainTexture(params) {
  const size = grainTileSize(params);
  const contrast = clamp(params.performantGrainContrast ?? 1.1, 0.05, 3);
  const prickliness = clamp01(params.performantGrainPrickliness ?? 0.38);
  const softness = clamp01(params.performantGrainSoftness ?? 0.18);
  const power = (1.85 * (1 - prickliness) + 0.48 * prickliness) * (1 - softness) + 2.5 * softness;
  const saltThreshold = 0.9992 * (1 - prickliness) + 0.979 * prickliness;
  const seed = Math.round(100000 + prickliness * 3371 + contrast * 6151 + softness * 7919 + size * 13);
  const rand = mulberry32(seed);
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let n = ((rand() + rand() + rand() + rand()) - 2) * 0.75;
      if (rand() > saltThreshold) n += (rand() > 0.5 ? 1 : -1) * 1.75;
      n = signedPow(n, 1.35 * (1 - prickliness) + 0.52 * prickliness);

      const a = Math.pow(Math.min(1, Math.abs(n) * contrast), power);
      const ink = n >= 0 ? 255 : 0;
      rgba[i + 0] = ink;
      rgba[i + 1] = ink;
      rgba[i + 2] = ink;
      rgba[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
  }

  return { size, buffer: makePngRgba(size, size, rgba) };
}

function cssIdent(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function writePerformantGrainKit(outputPath, params) {
  const amount = clamp(params.performantGrainAmount ?? 0, 0, 0.35);
  if (Math.round(Number(params.grainMode) || 0) !== 1 || amount <= 0.0005) return null;

  const parsed = path.parse(outputPath);
  const base = cssIdent(parsed.name || 'nitrate-output');
  const textureName = `${base}.grain-texture.png`;
  const cssName = `${base}.grain.css`;
  const rustName = `${base}.grain.dioxus.rs`;
  const jsonName = `${base}.grain.json`;

  const { size, buffer } = makePerformantGrainTexture(params);
  fs.writeFileSync(path.join(parsed.dir, textureName), buffer);

  const fps = Math.round(clamp(params.performantGrainFps ?? 12, 1, 30));
  const scale = clamp(params.performantGrainScale ?? 1.15, 0.5, 4);
  const motion = clamp01(params.performantGrainMotion ?? 0.65);
  const durationMs = Math.round((1000 / fps) * 8);
  const tilePx = Math.max(1, Math.round(size * scale));
  const driftPx = Math.round(size * (0.12 + motion * 0.55));

  const css = `/* Generated by Nitrate performant grain export.\n   Use the exported MP4 as the video source, put this CSS and ${textureName} beside it,\n   and add <div class="nitrate-grain-overlay" aria-hidden="true"></div> above the video. */\n\n.nitrate-grain-host {\n  position: relative;\n  overflow: hidden;\n  isolation: isolate;\n}\n\n.nitrate-grain-host > video,\n.nitrate-grain-video {\n  display: block;\n  width: 100%;\n  height: 100%;\n  object-fit: cover;\n}\n\n.nitrate-grain-overlay {\n  position: absolute;\n  inset: -18%;\n  z-index: 2;\n  pointer-events: none;\n  background-image: url("./${textureName}");\n  background-repeat: repeat;\n  background-size: ${tilePx}px ${tilePx}px;\n  opacity: ${amount.toFixed(4)};\n  transform: translate3d(0, 0, 0);\n  animation: nitrate-grain-jitter ${durationMs}ms steps(1, end) infinite;\n}\n\n@keyframes nitrate-grain-jitter {\n  0% { transform: translate3d(0, 0, 0); }\n  12.5% { transform: translate3d(${-driftPx}px, ${Math.round(driftPx * 0.37)}px, 0); }\n  25% { transform: translate3d(${Math.round(driftPx * 0.61)}px, ${-driftPx}px, 0); }\n  37.5% { transform: translate3d(${-Math.round(driftPx * 0.29)}px, ${Math.round(driftPx * 0.82)}px, 0); }\n  50% { transform: translate3d(${driftPx}px, ${Math.round(driftPx * 0.18)}px, 0); }\n  62.5% { transform: translate3d(${-Math.round(driftPx * 0.78)}px, ${-Math.round(driftPx * 0.54)}px, 0); }\n  75% { transform: translate3d(${Math.round(driftPx * 0.33)}px, ${Math.round(driftPx * 0.93)}px, 0); }\n  87.5% { transform: translate3d(${Math.round(driftPx * 0.91)}px, ${-Math.round(driftPx * 0.42)}px, 0); }\n  100% { transform: translate3d(0, 0, 0); }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .nitrate-grain-overlay { animation: none; }\n}\n`;

  const rust = `// Generated by Nitrate performant grain export.\n// Copy ${cssName} and ${textureName} into your Dioxus asset bundle.\n// Then wrap your hero video with this structure or adapt the classes.\n\nuse dioxus::prelude::*;\n\n#[component]\npub fn NitrateHeroVideo(src: String) -> Element {\n    rsx! {\n        div { class: "nitrate-grain-host",\n            video {\n                class: "nitrate-grain-video",\n                src: "{src}",\n                autoplay: true,\n                muted: true,\n                loop: true,\n                plays_inline: true,\n            }\n            div { class: "nitrate-grain-overlay", aria_hidden: "true" }\n        }\n    }\n}\n`;

  const preset = {
    kind: 'nitrate-performant-grain',
    version: 1,
    video: path.basename(outputPath),
    css: cssName,
    texture: textureName,
    dioxusExample: rustName,
    settings: {
      amount,
      textureScale: scale,
      textureSize: size,
      textureContrast: clamp(params.performantGrainContrast ?? 1.1, 0.05, 3),
      prickliness: clamp01(params.performantGrainPrickliness ?? 0.38),
      softness: clamp01(params.performantGrainSoftness ?? 0.18),
      motionJitter: motion,
      animationFps: fps,
    },
    note: 'The MP4 intentionally excludes this grain. Apply the CSS overlay in-app using the generated texture.',
  };

  fs.writeFileSync(path.join(parsed.dir, cssName), css, 'utf8');
  fs.writeFileSync(path.join(parsed.dir, rustName), rust, 'utf8');
  fs.writeFileSync(path.join(parsed.dir, jsonName), JSON.stringify(preset, null, 2), 'utf8');

  return {
    css: path.join(parsed.dir, cssName),
    texture: path.join(parsed.dir, textureName),
    dioxus: path.join(parsed.dir, rustName),
    preset: path.join(parsed.dir, jsonName),
  };
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
  const { inputPath, width, height, fps, duration, params, includeAudio, exportPerformantGrainKit, grainKitParams } = config;
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
          let grainKit = null;
          try {
            if (exportPerformantGrainKit) grainKit = writePerformantGrainKit(outputPath, grainKitParams || params || {});
          } catch (err) {
            jlog({ level: 'error', action: 'grain_kit_write', code: 'EXP_GRAIN_KIT', msg: String(err) });
          }
          mainWindow.webContents.send('export-complete', { success: true, outputPath, grainKit });
          resolve({ success: true, outputPath, grainKit });
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
