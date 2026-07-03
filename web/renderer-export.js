import { initGL, getCapabilities, createQuadBuffer } from './gl-context.js';
import { RenderPipeline } from './render-pipeline.js';

class HeadlessRenderer {
  constructor(width, height, params) {
    this.width = width;
    this.height = height;
    this.state = { ...params, isVideo: true };
    this.frameSeed = 0;

    this.canvas = document.getElementById('gl-export');
    this.canvas.width = this.width;
    this.canvas.height = this.height;

    this.gl = initGL(this.canvas);
    if (!this.gl) throw new Error('WebGL failed in headless renderer');
    this.gl.viewport(0, 0, this.width, this.height);

    this.caps = getCapabilities(this.gl);
    this.quad = createQuadBuffer(this.gl);
    this.pipeline = new RenderPipeline(this.gl, this.quad, this.caps);

    this.sourceTexture = this.gl.createTexture();
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.sourceTexture);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.width, this.height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);

    this.pipeline.ensure(this.width, this.height);
  }

  renderFrame(frameData) {
    const gl = this.gl;
    const W = this.width;
    const H = this.height;

    gl.viewport(0, 0, W, H);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, frameData);

    this.pipeline.render(this.sourceTexture, this.state, {
      width: W,
      height: H,
      timeMs: this.frameSeed * (1000 / 30),
      frameSeed: this.frameSeed,
      target: null,
    });

    this.frameSeed++;

    const processedPixels = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, processedPixels);
    return processedPixels;
  }
}

let renderer;

window.electronAPI.onInitExport(config => {
  try {
    renderer = new HeadlessRenderer(config.width, config.height, config.params);
    window.electronAPI.sendExportReady();
  } catch (e) {
    window.electronAPI.sendExportError(e.message);
  }
});

window.electronAPI.onExportFrame(frameData => {
  if (!renderer) return;

  try {
    const pixelBuffer = new Uint8Array(frameData.pixels);
    const processedPixels = renderer.renderFrame(pixelBuffer);

    window.electronAPI.sendExportResult({
      frameNumber: frameData.frameNumber,
      pixels: processedPixels.buffer,
    });
  } catch (e) {
    window.electronAPI.sendExportError(e.message);
  }
});
