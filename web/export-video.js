// webphy/web/export-video.js

export async function exportVideoFrameSequence(api, canvas, videoElement, overlayElement, textElement) {
  if (document.hidden) {
    console.warn("Export started while tab is in the background. It will continue, but performance may be impacted.");
  }

  // --- 1. Initialization ---
  overlayElement.classList.remove('hidden');
  textElement.textContent = 'Initializing Export...';

  const TARGET_FPS = 30;
  const totalFrames = Math.floor(videoElement.duration * TARGET_FPS);
  const gl = api.getGL();

  const initResult = await window.electronAPI.exportVideoInitialize();
  if (initResult.cancelled) throw new Error('Export cancelled');
  if (!initResult.success) throw new Error(initResult.error || 'Failed to initialize.');

  // Create our CPU workhorse
  const encoderWorker = new Worker('frame-encoder.worker.js');

  const wasPaused = videoElement.paused;
  const wasTime = videoElement.currentTime;
  videoElement.pause();
  videoElement.currentTime = 0;
  await new Promise(r => videoElement.addEventListener('seeked', r, { once: true }));

  const frameDurations = [];
  const ROLLING_AVERAGE_FRAMES = 30;

  return new Promise((resolve, reject) => {
    let currentFrame = 0;
    let framesInFlight = 0; // Track how many frames are being processed by the worker

    // This listener handles encoded frames coming BACK from the worker
    encoderWorker.onmessage = (event) => {
      const { frameIndex, arrayBuffer, error } = event.data;
      framesInFlight--;

      if (error) {
        reject(new Error(`Worker failed on frame ${frameIndex}: ${error}`));
        return;
      }

      // Send the finished WebP data to the main process for saving
      window.electronAPI.exportVideoWriteFrame({ frameIndex, frameBuffer: arrayBuffer });
    };

    const processSingleFrame = async () => {
      try {
        const frameStartTime = performance.now();

        videoElement.currentTime = currentFrame / TARGET_FPS;
        await new Promise(r => videoElement.addEventListener('seeked', r, { once: true }));

        await api.renderCurrentFrame();

        // This is the GPU -> CPU data transfer. It's fast.
        const pixelData = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixelData);

        // Offload the expensive encoding work to the worker.
        // The `[pixelData.buffer]` part transfers memory ownership instantly.
        encoderWorker.postMessage({
          frameIndex: currentFrame,
          width: canvas.width,
          height: canvas.height,
          pixelData: pixelData,
        }, [pixelData.buffer]);
        framesInFlight++;

        const frameTime = performance.now() - frameStartTime;
        frameDurations.push(frameTime);
        if (frameDurations.length > ROLLING_AVERAGE_FRAMES) frameDurations.shift();
        
        const avgFrameTime = frameDurations.reduce((a, b) => a + b, 0) / frameDurations.length;
        const fps = 1000 / avgFrameTime;
        const progress = Math.round(((currentFrame + 1) / totalFrames) * 100);
        const remainingFrames = totalFrames - (currentFrame + 1);
        const etaSeconds = Math.round(remainingFrames * (avgFrameTime / 1000));
        const eta = isFinite(etaSeconds) && etaSeconds > 0 ? `${Math.floor(etaSeconds / 60)}m ${etaSeconds % 60}s` : '...';

        textElement.textContent = `Rendering: ${progress}% (${currentFrame + 1}/${totalFrames}) | ${fps.toFixed(1)} FPS | ETA: ${eta}`;

        currentFrame++;
        if (currentFrame < totalFrames) {
          // If the worker is getting backed up, wait a moment. This acts as a 'backpressure'
          // system, preventing memory from exploding if encoding is slower than rendering.
          const delay = framesInFlight > 5 ? 16 : 0;
          setTimeout(processSingleFrame, delay);
        } else {
          // All frames have been SENT to the worker. Now we wait for it to finish.
          const waitForWorkers = setInterval(async () => {
            if (framesInFlight === 0) {
              clearInterval(waitForWorkers);
              encoderWorker.terminate(); // Clean up the worker
              
              textElement.textContent = 'Encoding video... This may take a few minutes.';
              const finalizeResult = await window.electronAPI.exportVideoFinalize({ fps: TARGET_FPS, totalFrames });
              
              videoElement.currentTime = wasTime;
              if (!wasPaused) videoElement.play();

              if (finalizeResult.success) resolve();
              else reject(new Error(finalizeResult.error || 'Encoding process failed.'));
            }
          }, 100);
        }
      } catch (err) {
        encoderWorker.terminate();
        videoElement.currentTime = wasTime;
        if (!wasPaused) videoElement.play();
        reject(err);
      }
    };

    setTimeout(processSingleFrame, 0); // Start the loop
  });
}