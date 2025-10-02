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
  const t0 = performance.now();
  
  const temp = document.createElement('canvas');
  temp.width = canvas.width;
  temp.height = canvas.height;
  const ctx = temp.getContext('2d', { alpha: false, desynchronized: true });
  ctx.drawImage(canvas, 0, 0);
  
  const t1 = performance.now();
  
  const blob = await new Promise(r => temp.toBlob(r, 'image/webp', WEBP_QUALITY));
  const t2 = performance.now();
  
  const ab = await blob.arrayBuffer();
  
  temp.width = temp.height = 0;
  
  if (index % 10 === 0) {
    console.log(`[FRAME ${index}] ${(t2 - t0).toFixed(0)}ms total, ${(blob.size / 1024).toFixed(0)}KB`);
  }
  
  return {
    name: `frame_${String(index).padStart(6, '0')}.webp`,
    data: new Uint8Array(ab)
  };
}

// Stream frames directly to download using WritableStream
export async function exportPNGSequence(canvas, mediaTexture, videoElement, isVideo, renderFunc, overlayElement, textElement) {
  console.log('[EXPORT] Starting STREAMING export (no memory accumulation)');
  console.log(`[EXPORT] Canvas: ${canvas.width}x${canvas.height}`);
  
  if (document.hidden) {
    throw new Error('Cannot export from background tab - switch to this tab first');
  }
  
  overlayElement.classList.remove('hidden');
  textElement.textContent = 'Exporting frames… 0%';
  
  if (!isVideo) {
    // Single image fallback
    console.log('[EXPORT] Single image mode');
    await renderFunc();
    await new Promise(r => requestAnimationFrame(r));
    const result = await captureAndEncodeFrame(canvas, 0);
    
    // Minimal blob for single image
    const header = createTarHeader(result.name, result.data.length);
    const padding = new Uint8Array(padToBlock(result.data.length));
    const footer = new Uint8Array(1024); // Two 512-byte null blocks
    
    const totalSize = header.length + result.data.length + padding.length + footer.length;
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    
    combined.set(header, offset); offset += header.length;
    combined.set(result.data, offset); offset += result.data.length;
    combined.set(padding, offset); offset += padding.length;
    combined.set(footer, offset);
    
    overlayElement.classList.add('hidden');
    return new Blob([combined], { type: 'application/x-tar' });
  }
  
  // VIDEO: Stream using FileSystemWritableFileStream or fallback
  const supportsFileSystem = 'showSaveFilePicker' in window;
  
  if (supportsFileSystem) {
    return await streamingExportWithFilePicker(canvas, videoElement, renderFunc, overlayElement, textElement);
  } else {
    return await streamingExportWithChunks(canvas, videoElement, renderFunc, overlayElement, textElement);
  }
}

// Method 1: Direct file stream (Chrome/Edge)
async function streamingExportWithFilePicker(canvas, videoElement, renderFunc, overlayElement, textElement) {
  console.log('[EXPORT] Using File System Access API for zero-memory streaming');
  
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
    console.log('[EXPORT] User cancelled save dialog');
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
  
  await new Promise(resolve => {
    videoElement.addEventListener('seeked', resolve, { once: true });
  });
  
  let frameIndex = 0;
  
  await new Promise((resolve, reject) => {
    let vfcb;
    let aborted = false;
    
    // Detect tab visibility changes
    const visibilityHandler = () => {
      if (document.hidden && !aborted) {
        console.error('[EXPORT] Tab hidden - aborting export');
        aborted = true;
        cleanup();
        reject(new Error('Export cancelled - tab must stay visible'));
      }
    };
    
    document.addEventListener('visibilitychange', visibilityHandler);
    
    const cleanup = () => {
      document.removeEventListener('visibilitychange', visibilityHandler);
      if (videoElement.cancelVideoFrameCallback && vfcb) {
        try { videoElement.cancelVideoFrameCallback(vfcb); } catch (e) {}
      }
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
        
        // Capture and encode
        const { name, data } = await captureAndEncodeFrame(canvas, frameIndex);
        
        // Write header + data + padding directly to disk
        const header = createTarHeader(name, data.length);
        await writable.write(header);
        await writable.write(data);
        
        const padding = padToBlock(data.length);
        if (padding > 0) {
          await writable.write(new Uint8Array(padding));
        }
        
        frameIndex++;
        
        const progress = Math.round((videoElement.currentTime / dur) * 100);
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
        const fps = (frameIndex / (performance.now() - startTime) * 1000).toFixed(1);
        
        textElement.textContent = `Frame ${frameIndex} (${progress}%) • ${fps} fps`;
        
        if (frameIndex % YIELD_EVERY === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
        
        if (videoElement.ended || videoElement.currentTime >= dur - 1e-4) {
          // Write TAR footer
          await writable.write(new Uint8Array(1024));
          await writable.close();
          
          console.log(`[EXPORT] Complete - ${frameIndex} frames in ${elapsed}s`);
          cleanup();
          resolve();
          return;
        }
        
        vfcb = videoElement.requestVideoFrameCallback(onFrame);
        videoElement.play().catch(() => {});
        
      } catch (err) {
        console.error('[EXPORT] Error:', err);
        await writable.abort();
        cleanup();
        reject(err);
      }
    };
    
    vfcb = videoElement.requestVideoFrameCallback(onFrame);
    videoElement.addEventListener('ended', async () => {
      if (!aborted) {
        await writable.write(new Uint8Array(1024));
        await writable.close();
      }
      cleanup();
      resolve();
    }, { once: true });
    
    videoElement.play().catch(err => {
      cleanup();
      reject(err);
    });
  });
  
  overlayElement.classList.add('hidden');
  
  return null; // File already saved, no blob to return
}

// Method 2: Chunked blob building with periodic cleanup (fallback for Firefox/Safari)
async function streamingExportWithChunks(canvas, videoElement, renderFunc, overlayElement, textElement) {
  console.log('[EXPORT] Using chunked export with memory cleanup');
  
  const chunks = [];
  const CHUNK_SIZE = 50; // Encode 50 frames then build partial blob
  
  const dur = Math.max(0.01, videoElement.duration || 1);
  const startTime = performance.now();
  
  const wasLoop = videoElement.loop;
  const wasPaused = videoElement.paused;
  const wasRate = videoElement.playbackRate;
  
  videoElement.loop = false;
  videoElement.playbackRate = 1.0;
  videoElement.pause();
  videoElement.currentTime = 0;
  
  await new Promise(resolve => {
    videoElement.addEventListener('seeked', resolve, { once: true });
  });
  
  let frameIndex = 0;
  let tempEntries = [];
  
  await new Promise((resolve, reject) => {
    let vfcb;
    let aborted = false;
    
    // Detect tab visibility changes
    const visibilityHandler = () => {
      if (document.hidden && !aborted) {
        console.error('[EXPORT] Tab hidden - aborting export');
        aborted = true;
        cleanup();
        reject(new Error('Export cancelled - tab must stay visible'));
      }
    };
    
    document.addEventListener('visibilitychange', visibilityHandler);
    
    const cleanup = () => {
      document.removeEventListener('visibilitychange', visibilityHandler);
      if (videoElement.cancelVideoFrameCallback && vfcb) {
        try { videoElement.cancelVideoFrameCallback(vfcb); } catch (e) {}
      }
      videoElement.pause();
      videoElement.loop = wasLoop;
      videoElement.playbackRate = wasRate;
      if (wasPaused) videoElement.pause();
    };
    
    const flushChunk = () => {
      // Convert temp entries to blob parts
      const parts = [];
      for (const { name, data } of tempEntries) {
        const header = createTarHeader(name, data.length);
        parts.push(header, data);
        const padding = padToBlock(data.length);
        if (padding > 0) parts.push(new Uint8Array(padding));
      }
      
      chunks.push(new Blob(parts));
      console.log(`[CHUNK] Flushed ${tempEntries.length} frames, total chunks: ${chunks.length}`);
      tempEntries = []; // Clear for GC
    };
    
    const onFrame = async () => {
      try {
        if (aborted) return;
        
        videoElement.pause();
        
        await renderFunc();
        
        const encoded = await captureAndEncodeFrame(canvas, frameIndex);
        tempEntries.push(encoded);
        
        frameIndex++;
        
        // Flush every CHUNK_SIZE frames
        if (tempEntries.length >= CHUNK_SIZE) {
          flushChunk();
        }
        
        const progress = Math.round((videoElement.currentTime / dur) * 100);
        const fps = (frameIndex / (performance.now() - startTime) * 1000).toFixed(1);
        
        textElement.textContent = `Frame ${frameIndex} (${progress}%) • ${fps} fps`;
        
        if (frameIndex % YIELD_EVERY === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
        
        if (videoElement.ended || videoElement.currentTime >= dur - 1e-4) {
          // Flush remaining
          if (tempEntries.length > 0) {
            flushChunk();
          }
          
          console.log(`[EXPORT] Complete - ${frameIndex} frames`);
          cleanup();
          resolve();
          return;
        }
        
        vfcb = videoElement.requestVideoFrameCallback(onFrame);
        videoElement.play().catch(() => {});
        
      } catch (err) {
        console.error('[EXPORT] Error:', err);
        cleanup();
        reject(err);
      }
    };
    
    vfcb = videoElement.requestVideoFrameCallback(onFrame);
    videoElement.addEventListener('ended', () => {
      if (!aborted && tempEntries.length > 0) {
        flushChunk();
      }
      cleanup();
      resolve();
    }, { once: true });
    
    videoElement.play().catch(err => {
      cleanup();
      reject(err);
    });
  });
  
  textElement.textContent = 'Finalizing archive...';
  
  // Add footer
  chunks.push(new Blob([new Uint8Array(1024)]));
  
  const finalBlob = new Blob(chunks, { type: 'application/x-tar' });
  console.log(`[EXPORT] Final archive: ${(finalBlob.size / 1024 / 1024).toFixed(2)}MB`);
  
  overlayElement.classList.add('hidden');
  
  return finalBlob;
}