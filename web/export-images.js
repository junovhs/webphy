// STREAMING TAR export - never holds full archive in memory

const YIELD_EVERY = 3;
const WEBP_QUALITY = 0.95;

// TAR header generator (pure function, no state)
function createTarHeader(name, size) {
  const buf = new Uint8Array(512);
  
  function padOctal(n, len) {
    const s = n.toString(8);
    return ('000000000000'.slice(s.length) + s).slice(-len) + '\0';
  }
  
  function putString(buf, off, str) {
    for (let i = 0; i < str.length; i++) {
      buf[off + i] = str.charCodeAt(i) & 0xFF;
    }
  }
  
  putString(buf, 0, name.slice(0, 100));
  putString(buf, 100, '0000777\0');
  putString(buf, 108, '0000000\0');
  putString(buf, 116, '0000000\0');
  putString(buf, 124, padOctal(size, 11));
  putString(buf, 136, padOctal(Math.floor(Date.now() / 1000), 11));
  putString(buf, 156, '0');
  putString(buf, 257, 'ustar\0');
  putString(buf, 263, '00');
  putString(buf, 265, 'user');
  putString(buf, 297, 'user');
  
  for (let i = 148; i < 156; i++) buf[i] = 0x20;
  
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  
  const chk = (sum.toString(8).padStart(6, '0')).slice(-6) + '\0 ';
  putString(buf, 148, chk);
  
  return buf;
}

function padToBlock(size) {
  const remainder = size % 512;
  return remainder === 0 ? 0 : 512 - remainder;
}

async function captureAndEncodeFrame(canvas, index) {
  const temp = document.createElement('canvas');
  temp.width = canvas.width;
  temp.height = canvas.height;
  const ctx = temp.getContext('2d', { alpha: false, desynchronized: true });
  ctx.drawImage(canvas, 0, 0);
  
  const blob = await new Promise(r => temp.toBlob(r, 'image/webp', WEBP_QUALITY));
  const ab = await blob.arrayBuffer();
  
  temp.width = temp.height = 0;
  
  return {
    name: `frame_${String(index).padStart(6, '0')}.webp`,
    data: new Uint8Array(ab)
  };
}

// Stream frames directly to download using WritableStream
export async function exportPNGSequence(canvas, mediaTexture, videoElement, isVideo, renderFunc, overlayElement, textElement) {
  if (document.hidden) {
    throw new Error('Cannot export from background tab - switch to this tab first');
  }
  
  overlayElement.classList.remove('hidden');
  textElement.textContent = 'Exporting frames… 0%';
  
  if (!isVideo) {
    await renderFunc();
    await new Promise(r => requestAnimationFrame(r));
    const result = await captureAndEncodeFrame(canvas, 0);
    
    const header = createTarHeader(result.name, result.data.length);
    const padding = new Uint8Array(padToBlock(result.data.length));
    const footer = new Uint8Array(1024);
    
    const combined = new Uint8Array(header.length + result.data.length + padding.length + footer.length);
    let offset = 0;
    
    combined.set(header, offset); offset += header.length;
    combined.set(result.data, offset); offset += result.data.length;
    combined.set(padding, offset); offset += padding.length;
    combined.set(footer, offset);
    
    overlayElement.classList.add('hidden');
    return new Blob([combined], { type: 'application/x-tar' });
  }
  
  const supportsFileSystem = 'showSaveFilePicker' in window;
  
  if (supportsFileSystem) {
    return await streamingExportWithFilePicker(canvas, videoElement, renderFunc, overlayElement, textElement);
  } else {
    return await streamingExportWithChunks(canvas, videoElement, renderFunc, overlayElement, textElement);
  }
}

// Method 1: Direct file stream (Chrome/Edge)
async function streamingExportWithFilePicker(canvas, videoElement, renderFunc, overlayElement, textElement) {
  let fileHandle;
  try {
    fileHandle = await window.showSaveFilePicker({
      suggestedName: 'frames.tar',
      types: [{
        description: 'TAR Archive',
        accept: { 'application/x-tar': ['.tar'] }
      }]
    });
  } catch (e) {
    overlayElement.classList.add('hidden');
    throw new Error('Export cancelled');
  }
  
  const writable = await fileHandle.createWritable();
  const dur = Math.max(0.01, videoElement.duration || 1);
  const startTime = performance.now();
  
  const wasLoop = videoElement.loop;
  const wasPaused = videoElement.paused;
  const wasRate = videoElement.playbackRate;
  
  videoElement.loop = false;
  videoElement.playbackRate = 1.0;
  videoElement.pause();
  videoElement.currentTime = 0;
  
  await new Promise(resolve => videoElement.addEventListener('seeked', resolve, { once: true }));
  
  let frameIndex = 0;
  
  await new Promise((resolve, reject) => {
    let vfcb;
    let aborted = false;
    
    const visibilityHandler = () => {
      if (document.hidden && !aborted) {
        aborted = true;
        cleanup();
        reject(new Error('Export cancelled - tab must stay visible'));
      }
    };
    
    document.addEventListener('visibilitychange', visibilityHandler);
    
    const cleanup = () => {
      document.removeEventListener('visibilitychange', visibilityHandler);
      if (videoElement.cancelVideoFrameCallback && vfcb) try { videoElement.cancelVideoFrameCallback(vfcb); } catch (e) {}
      videoElement.pause();
      videoElement.loop = wasLoop;
      videoElement.playbackRate = wasRate;
      if (wasPaused) videoElement.pause();
    };
    
    const onFrame = async () => {
      try {
        if (aborted) return;
        
        videoElement.pause();
        await renderFunc();
        const { name, data } = await captureAndEncodeFrame(canvas, frameIndex);
        
        const header = createTarHeader(name, data.length);
        await writable.write(header);
        await writable.write(data);
        
        const padding = padToBlock(data.length);
        if (padding > 0) await writable.write(new Uint8Array(padding));
        
        frameIndex++;
        
        const progress = Math.round((videoElement.currentTime / dur) * 100);
        const fps = (frameIndex / (performance.now() - startTime) * 1000).toFixed(1);
        textElement.textContent = `Frame ${frameIndex} (${progress}%) • ${fps} fps`;
        
        if (frameIndex % YIELD_EVERY === 0) await new Promise(r => setTimeout(r, 0));
        
        if (videoElement.ended || videoElement.currentTime >= dur - 1e-4) {
          await writable.write(new Uint8Array(1024));
          await writable.close();
          cleanup();
          resolve();
          return;
        }
        
        vfcb = videoElement.requestVideoFrameCallback(onFrame);
        videoElement.play().catch(() => {});
        
      } catch (err) {
        await writable.abort();
        cleanup();
        reject(err);
      }
    };
    
    vfcb = videoElement.requestVideoFrameCallback(onFrame);
    videoElement.play().catch(reject);
  });
  
  overlayElement.classList.add('hidden');
  return null;
}

// Method 2: Chunked blob building
async function streamingExportWithChunks(canvas, videoElement, renderFunc, overlayElement, textElement) {
  const chunks = [];
  const CHUNK_SIZE = 50;
  const dur = Math.max(0.01, videoElement.duration || 1);
  const startTime = performance.now();
  
  const wasLoop = videoElement.loop;
  const wasPaused = videoElement.paused;
  const wasRate = videoElement.playbackRate;
  
  videoElement.loop = false;
  videoElement.playbackRate = 1.0;
  videoElement.pause();
  videoElement.currentTime = 0;
  
  await new Promise(resolve => videoElement.addEventListener('seeked', resolve, { once: true }));
  
  let frameIndex = 0;
  let tempEntries = [];
  
  await new Promise((resolve, reject) => {
    let vfcb;
    let aborted = false;

    const visibilityHandler = () => {
      if (document.hidden && !aborted) {
        aborted = true;
        cleanup();
        reject(new Error('Export cancelled - tab must stay visible'));
      }
    };
    
    document.addEventListener('visibilitychange', visibilityHandler);

    const cleanup = () => {
      document.removeEventListener('visibilitychange', visibilityHandler);
      if (videoElement.cancelVideoFrameCallback && vfcb) try { videoElement.cancelVideoFrameCallback(vfcb); } catch (e) {}
      videoElement.pause();
      videoElement.loop = wasLoop;
      videoElement.playbackRate = wasRate;
      if (wasPaused) videoElement.pause();
    };

    const flushChunk = () => {
      const parts = [];
      for (const { name, data } of tempEntries) {
        parts.push(createTarHeader(name, data.length), data);
        const padding = padToBlock(data.length);
        if (padding > 0) parts.push(new Uint8Array(padding));
      }
      chunks.push(new Blob(parts));
      tempEntries = [];
    };

    const onFrame = async () => {
      try {
        if (aborted) return;
        
        videoElement.pause();
        await renderFunc();
        
        tempEntries.push(await captureAndEncodeFrame(canvas, frameIndex));
        frameIndex++;
        
        if (tempEntries.length >= CHUNK_SIZE) flushChunk();
        
        const progress = Math.round((videoElement.currentTime / dur) * 100);
        const fps = (frameIndex / (performance.now() - startTime) * 1000).toFixed(1);
        textElement.textContent = `Frame ${frameIndex} (${progress}%) • ${fps} fps`;
        
        if (frameIndex % YIELD_EVERY === 0) await new Promise(r => setTimeout(r, 0));
        
        if (videoElement.ended || videoElement.currentTime >= dur - 1e-4) {
          if (tempEntries.length > 0) flushChunk();
          cleanup();
          resolve();
          return;
        }
        
        vfcb = videoElement.requestVideoFrameCallback(onFrame);
        videoElement.play().catch(() => {});
        
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    vfcb = videoElement.requestVideoFrameCallback(onFrame);
    videoElement.play().catch(reject);
  });
  
  textElement.textContent = 'Finalizing archive...';
  chunks.push(new Blob([new Uint8Array(1024)]));
  
  const finalBlob = new Blob(chunks, { type: 'application/x-tar' });
  overlayElement.classList.add('hidden');
  
  return finalBlob;
}