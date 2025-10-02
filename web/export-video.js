// webphy/web/export-video.js

/**
 * Renders every frame of a video through the WebGL canvas and sends it
 * to the Electron main process for encoding. This new version uses a more
 * stable, single-frame processing loop to prevent browser/GPU crashes and slowdowns.
 */
export async function exportVideoFrameSequence(api, canvas, videoElement, overlayElement, textElement) {
  if (document.hidden) {
    throw new Error('Export cancelled: Page is not visible.');
  }

  // --- 1. Initialization Phase ---
  overlayElement.classList.remove('hidden');
  textElement.textContent = 'Initializing Export...';

  const TARGET_FPS = 30;
  const totalFrames = Math.floor(videoElement.duration * TARGET_FPS);

  const initResult = await window.electronAPI.exportVideoInitialize();
  if (initResult.cancelled) throw new Error('Export cancelled');
  if (!initResult.success) throw new Error(initResult.error || 'Failed to initialize export.');

  // Save video state
  const wasPaused = videoElement.paused;
  const wasTime = videoElement.currentTime;
  videoElement.pause();
  videoElement.currentTime = 0;
  await new Promise(resolve => videoElement.addEventListener('seeked', resolve, { once: true }));

  // For stable ETA calculation
  const frameDurations = [];
  const ROLLING_AVERAGE_FRAMES = 20;

  return new Promise((resolve, reject) => {
    let currentFrame = 0;

    // This function processes ONE frame and then schedules the next one.
    // This is the key to stability.
    const processSingleFrame = async () => {
      try {
        const frameStartTime = performance.now();

        // A. Set video time and wait for it to seek
        videoElement.currentTime = currentFrame / TARGET_FPS;
        await new Promise(r => videoElement.addEventListener('seeked', r, { once: true }));

        // B. Render the frame with all WebGL effects
        await api.renderCurrentFrame();
        await new Promise(r => requestAnimationFrame(r)); // Wait for paint

        // C. Get frame data as an efficient, asynchronous Blob
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        const frameBuffer = await blob.arrayBuffer();
        
        // D. Send the raw binary data to the main process
        window.electronAPI.exportVideoWriteFrame({ frameIndex: currentFrame, frameBuffer });

        // E. Update progress with a stable rolling-average ETA
        const frameTime = performance.now() - frameStartTime;
        frameDurations.push(frameTime);
        if (frameDurations.length > ROLLING_AVERAGE_FRAMES) {
          frameDurations.shift(); // Keep the array size fixed
        }
        
        const avgFrameTime = frameDurations.reduce((a, b) => a + b, 0) / frameDurations.length;
        const framesPerSecond = 1000 / avgFrameTime;
        const progress = Math.round(((currentFrame + 1) / totalFrames) * 100);
        const remainingFrames = totalFrames - (currentFrame + 1);
        const remainingMs = remainingFrames * avgFrameTime;
        const remainingSeconds = Math.round(remainingMs / 1000);
        const eta = isFinite(remainingSeconds) && remainingSeconds > 0 
            ? `${Math.floor(remainingSeconds / 60)}m ${remainingSeconds % 60}s` 
            : '...';

        textElement.textContent = `Rendering: ${progress}% (${currentFrame + 1}/${totalFrames}) | ${framesPerSecond.toFixed(1)} FPS | ETA: ${eta}`;

        // F. Check if done, or schedule the next frame
        currentFrame++;
        if (currentFrame < totalFrames) {
          // Schedule the next frame processing. This gives the browser
          // a chance to breathe and prevents resource exhaustion.
          requestAnimationFrame(processSingleFrame);
        } else {
          // All frames are sent, tell the main process to finalize.
          textElement.textContent = 'Encoding video... This may take a few minutes.';
          const finalizeResult = await window.electronAPI.exportVideoFinalize({ fps: TARGET_FPS, totalFrames });
          
          // Restore video state
          videoElement.currentTime = wasTime;
          if (!wasPaused) videoElement.play();

          if (finalizeResult.success) {
            resolve();
          } else {
            reject(new Error(finalizeResult.error || 'Encoding process failed.'));
          }
        }
      } catch (err) {
        // Restore video state on error
        videoElement.currentTime = wasTime;
        if (!wasPaused) videoElement.play();
        reject(err);
      }
    };

    // Start the process
    requestAnimationFrame(processSingleFrame);
  });
}