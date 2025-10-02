// webphy/web/frame-encoder.worker.js

// This script runs in a separate thread.
// It has no access to the DOM, the window, or Electron APIs.
// Its only job is to receive raw pixel data, encode it, and send it back.

self.onmessage = async (event) => {
  const { frameIndex, width, height, pixelData } = event.data;

  try {
    // We use an OffscreenCanvas because there is no visible <canvas> in a worker.
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // The pixel data from WebGL is upside down, so we need to flip it.
    // This is a CPU-bound task, perfect for a worker.
    const flippedData = new Uint8ClampedArray(pixelData.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIndex = (y * width + x) * 4;
        const destIndex = ((height - 1 - y) * width + x) * 4;
        flippedData[destIndex] = pixelData[srcIndex];     // R
        flippedData[destIndex + 1] = pixelData[srcIndex + 1]; // G
        flippedData[destIndex + 2] = pixelData[srcIndex + 2]; // B
        flippedData[destIndex + 3] = pixelData[srcIndex + 3]; // A
      }
    }

    // Create an ImageData object and put it onto the offscreen canvas.
    const imageData = new ImageData(flippedData, width, height);
    ctx.putImageData(imageData, 0, 0);

    // Asynchronously convert the canvas to a WebP Blob at 90% quality.
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.90 });
    
    // Convert the Blob to an ArrayBuffer, which is transferable.
    const arrayBuffer = await blob.arrayBuffer();

    // Send the final, encoded data back to the main thread.
    // The second argument [arrayBuffer] is a "transferable object,"
    // which means ownership is transferred instantly with zero copying.
    self.postMessage({ frameIndex, arrayBuffer }, [arrayBuffer]);

  } catch (error) {
    // If something goes wrong, notify the main thread.
    self.postMessage({ frameIndex, error: error.message });
  }
};