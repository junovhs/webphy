// MP4 export using FFmpeg.wasm

let ffmpegCache = null;

export async function initFFmpeg() {
  if (ffmpegCache) return ffmpegCache;
  
  if (!window.FFmpeg || !window.FFmpeg.createFFmpeg) {
    throw new Error('FFmpeg script not loaded.');
  }
  
  const { createFFmpeg } = window.FFmpeg;
  const ffmpeg = createFFmpeg({
    log: true,
    corePath: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/ffmpeg-core.js'
  });
  
  await ffmpeg.load();
  ffmpegCache = { ffmpeg };
  return ffmpegCache;
}

export async function exportMP4(canvas, videoElement, renderFunc, overlayElement, textElement) {
  const { ffmpeg } = await initFFmpeg();
  
  overlayElement.classList.remove('hidden');
  textElement.textContent = 'Export: grabbing frames… 0%';
  
  let i = 0;
  const dur = Math.max(0.01, videoElement.duration || 1);
  const wasLoop = videoElement.loop;
  const wasPaused = videoElement.paused;
  const prevRate = videoElement.playbackRate;
  
  videoElement.loop = false;
  videoElement.playbackRate = 1.0;
  videoElement.pause();
  videoElement.currentTime = 0;
  
  await new Promise(resolve => {
    videoElement.addEventListener('seeked', resolve, { once: true });
  });
  
  const pngOfCanvas = () => new Promise(r => canvas.toBlob(r, 'image/png'));
  const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  
  const grabOne = async () => {
    await renderFunc();
    await raf2();
    const blob = await pngOfCanvas();
    const ab = await blob.arrayBuffer();
    const name = `f_${String(i).padStart(6, '0')}.png`;
    ffmpeg.FS('writeFile', name, new Uint8Array(ab));
    i++;
    textElement.textContent = `Export: grabbing frames… ${Math.round((videoElement.currentTime / dur) * 100)}%`;
  };
  
  await new Promise(resolve => {
    let vfcb;
    
    const cleanup = () => {
      if (videoElement.cancelVideoFrameCallback && vfcb) {
        try {
          videoElement.cancelVideoFrameCallback(vfcb);
        } catch (e) {}
      }
    };
    
    const onFrame = async () => {
      videoElement.pause();
      await grabOne();
      
      if (videoElement.ended || videoElement.currentTime >= dur - 1e-4) {
        cleanup();
        resolve();
        return;
      }
      
      vfcb = videoElement.requestVideoFrameCallback(onFrame);
      videoElement.play().catch(() => {});
    };
    
    vfcb = videoElement.requestVideoFrameCallback(onFrame);
    videoElement.addEventListener('ended', () => {
      cleanup();
      resolve();
    }, { once: true });
    
    videoElement.play().catch(() => {});
  });
  
  textElement.textContent = 'Export: encoding…';
  
  ffmpeg.setLogger(({ message }) => {
    const m = /frame=\s*(\d+)/.exec(message);
    if (m) textElement.textContent = `Export: encoding… frame ${+m[1]}`;
  });
  
  let outName = 'export.mp4';
  let outMime = 'video/mp4';
  
  try {
    await ffmpeg.run(
      '-framerate', '30', '-i', 'f_%06d.png',
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12',
      '-preset', 'veryslow', '-movflags', '+faststart', outName
    );
  } catch (e1) {
    try {
      await ffmpeg.run(
        '-framerate', '30', '-i', 'f_%06d.png',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:v', 'mpeg4', '-q:v', '1', '-movflags', '+faststart', outName
      );
    } catch (e2) {
      outName = 'export.webm';
      outMime = 'video/webm';
      await ffmpeg.run(
        '-framerate', '30', '-i', 'f_%06d.png',
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', '18', outName
      );
    }
  }
  
  const data = ffmpeg.FS('readFile', outName);
  const blob = new Blob([data.buffer], { type: outMime });
  
  // Cleanup
  for (let k = 0; k < i; k++) {
    try {
      ffmpeg.FS('unlink', `f_${String(k).padStart(6, '0')}.png`);
    } catch (e) {}
  }
  try {
    ffmpeg.FS('unlink', outName);
  } catch (e) {}
  
  overlayElement.classList.add('hidden');
  
  videoElement.loop = wasLoop;
  videoElement.playbackRate = prevRate;
  if (wasPaused) videoElement.pause();
  
  return { blob, filename: outName };
}