// webphy/web/renderer-export.js

import { initGL, getCapabilities, createQuadBuffer, ensureFramebuffer } from './gl-context.js';
import { ExposureFlashModule } from './modules/exposure-flash.js';
import { ToneModule } from './modules/tone.js';
import { SplitCastModule } from './modules/split-cast.js';
import { BloomVignetteOpticsModule } from './modules/bloom-vignette-optics.js';
import { MotionBlurModule, sliderToShutterSeconds, shutterToPixels } from './modules/motion-blur.js';
import { HandheldCameraModule } from './modules/handheld-camera.js';
import { FilmGrainModule } from './modules/film-grain.js';

class HeadlessRenderer {
    constructor(width, height, params) {
        this.width = width;
        this.height = height;
        this.params = params;
        this.state = { ...params };
        this.frameSeed = 0;

        this.canvas = document.getElementById('gl-export');
        this.canvas.width = this.width;
        this.canvas.height = this.height;

        this.gl = initGL(this.canvas);
        if (!this.gl) throw new Error('WebGL failed in headless renderer');
        
        // CRITICAL FIX: Ensure the correct viewport size is set immediately
        this.gl.viewport(0, 0, this.width, this.height);

        this.caps = getCapabilities(this.gl);
        this.quad = createQuadBuffer(this.gl);
        
        this.exposureFlash = new ExposureFlashModule(this.gl, this.quad);
        this.tone = new ToneModule(this.gl, this.quad);
        this.splitCast = new SplitCastModule(this.gl, this.quad);
        this.bloomVignetteOptics = new BloomVignetteOpticsModule(this.gl, this.quad);
        this.motionBlur = new MotionBlurModule(this.gl, this.quad);
        this.handheldCamera = new HandheldCameraModule(this.gl, this.quad);
        this.filmGrain = new FilmGrainModule(this.gl, this.quad);

        this.sourceTexture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.sourceTexture);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        
        // Allocate texture memory once
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.width, this.height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);

        this.ensureRenderTargets();
    }

    ensureRenderTargets() {
        const W = this.width, H = this.height;
        this.rtA = ensureFramebuffer(this.rtA, this.gl, this.caps, W, H);
        this.rtB = ensureFramebuffer(this.rtB, this.gl, this.caps, W, H);
        this.rtH_A = ensureFramebuffer(this.rtH_A, this.gl, this.caps, W >> 1 || 1, H >> 1 || 1);
        this.rtH_B = ensureFramebuffer(this.rtH_B, this.gl, this.caps, W >> 1 || 1, H >> 1 || 1);
        this.rtQ_A = ensureFramebuffer(this.rtQ_A, this.gl, this.caps, W >> 2 || 1, H >> 2 || 1);
        this.rtQ_B = ensureFramebuffer(this.rtQ_B, this.gl, this.caps, W >> 2 || 1, H >> 2 || 1);
        this.rtE_A = ensureFramebuffer(this.rtE_A, this.gl, this.caps, W >> 3 || 1, H >> 3 || 1);
        this.rtE_B = ensureFramebuffer(this.rtE_B, this.gl, this.caps, W >> 3 || 1, H >> 3 || 1);
        this.rtBloom = ensureFramebuffer(this.rtBloom, this.gl, this.caps, W, H);
    }
    
    renderFrame(frameData) {
        const gl = this.gl;
        const W = this.width;
        const H = this.height;

        gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
        // CRITICAL: The data from FFmpeg is upside down (as are most image sources from the DOM)
        // However, FFmpeg rawvideo output is typically NOT upside down.
        // We will stick to the default for rawvideo which is to NOT flip.
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, frameData);

        const pxX = 1 / W, pxY = 1 / H;
        
        this.exposureFlash.applyExposure(this.sourceTexture, this.rtA, this.state.ev, W, H);
        let currentTex = this.rtA.tex;

        // Apply handheld camera shake
        const shakeDst = (currentTex === this.rtA.tex) ? this.rtB : this.rtA;
        this.handheldCamera.apply(currentTex, shakeDst, this.state, this.frameSeed, W, H);
        currentTex = shakeDst.tex;
        
        // Apply motion blur
        const sh = sliderToShutterSeconds(this.state.shutterUI), motionAmt = shutterToPixels(sh, this.state.shake);
        if (motionAmt > 0.05) {
            const motionDst = (currentTex === this.rtA.tex) ? this.rtB : this.rtA;
            this.motionBlur.apply(currentTex, motionDst, { amount: motionAmt, angle: this.state.motionAngle, shake: this.state.shake }, pxX, pxY, W, H);
            currentTex = motionDst.tex;
        }

        // Apply flash
        const flashDst = (currentTex === this.rtA.tex) ? this.rtB : this.rtA;
        this.exposureFlash.applyFlash(currentTex, flashDst, { centerX: this.state.flashCenterX, centerY: this.state.flashCenterY, strength: this.state.flashStrength, falloff: this.state.flashFalloff }, W, H);
        currentTex = flashDst.tex;

        // Bloom chain
        const brightDst = (currentTex === this.rtA.tex) ? this.rtB : this.rtA;
        this.bloomVignetteOptics.extractBright(currentTex, brightDst, this.state.bloomThreshold, this.state.bloomWarm, W, H);
        this.bloomVignetteOptics.downsample(brightDst.tex, brightDst.w, brightDst.h, this.rtH_A, W, H);
        this.bloomVignetteOptics.downsample(this.rtH_A.tex, this.rtH_A.w, this.rtH_A.h, this.rtQ_A, W, H);
        this.bloomVignetteOptics.downsample(this.rtQ_A.tex, this.rtQ_A.w, this.rtQ_A.h, this.rtE_A, W, H);
        this.bloomVignetteOptics.blurHorizontalVertical(this.rtE_A, this.rtE_B, this.state.bloomRadius * 0.6, W, H);
        this.bloomVignetteOptics.blurHorizontalVertical(this.rtQ_A, this.rtQ_B, this.state.bloomRadius * 0.8, W, H);
        this.bloomVignetteOptics.blurHorizontalVertical(this.rtH_A, this.rtH_B, this.state.bloomRadius * 1.0, W, H);
        this.bloomVignetteOptics.upsampleAdd(this.rtE_A.tex, this.rtQ_A.tex, this.rtQ_B, W, H);
        this.bloomVignetteOptics.upsampleAdd(this.rtQ_B.tex, this.rtH_A.tex, this.rtH_B, W, H);
        this.bloomVignetteOptics.upsampleAdd(this.rtH_B.tex, brightDst.tex, this.rtBloom, W, H);

        // Tone and Color
        const toneDst = (currentTex === this.rtA.tex) ? this.rtB : this.rtA;
        this.tone.apply(currentTex, toneDst, { scurve: this.state.scurve, blacks: this.state.blacks, knee: this.state.knee, blackLift: this.state.blackLift }, W, H);
        const splitDst = (toneDst === this.rtA) ? this.rtB : this.rtA;
        this.splitCast.applySplit(toneDst.tex, splitDst, { shadowCool: this.state.shadowCool, highlightWarm: this.state.highlightWarm }, W, H);
        const castDst = (splitDst === this.rtA) ? this.rtB : this.rtA;
        this.splitCast.applyCast(splitDst.tex, castDst, { greenShadows: this.state.greenShadows, magentaMids: this.state.magentaMids }, W, H);
        
        // Optics and Final Compositing
        const vigDst = (castDst === this.rtA) ? this.rtB : this.rtA;
        this.bloomVignetteOptics.applyVignette(castDst.tex, vigDst, this.state.vignette, this.state.vignettePower, W, H);
        
        const bloomCompDst = (vigDst === this.rtA) ? this.rtB : this.rtA;
        this.bloomVignetteOptics.compositeBloom(vigDst.tex, this.rtBloom.tex, bloomCompDst, this.state.bloomIntensity, this.state.halation, W, H);
        let currentFB = bloomCompDst;

        if (this.state.clarity > 0.001) {
            const clarDst = (currentFB === this.rtA) ? this.rtB : this.rtA;
            this.bloomVignetteOptics.applyClarity(currentFB.tex, clarDst, this.state.clarity, pxX, pxY, W, H);
            currentFB = clarDst;
        }
        
        const caDst = (currentFB === this.rtA) ? this.rtB : this.rtA;
        this.bloomVignetteOptics.applyChromaticAberration(currentFB.tex, caDst, this.state.ca, pxX, pxY, W, H);

        this.filmGrain.apply(caDst.tex, this.state, performance.now(), this.frameSeed, W, H);
        this.frameSeed++;

        const processedPixels = new Uint8Array(W * H * 4);
        // CRITICAL: We read the pixels from the default framebuffer (where filmGrain.apply rendered)
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, processedPixels);
        
        return processedPixels;
    }
}

let renderer;

window.electronAPI.onInitExport((config) => {
    try {
        renderer = new HeadlessRenderer(config.width, config.height, config.params);
        // CRITICAL: Signal that the GPU context is initialized and ready for frames
        window.electronAPI.sendExportReady();
    } catch (e) {
        window.electronAPI.sendExportError(e.message);
    }
});

window.electronAPI.onExportFrame((frameData) => {
    if (!renderer) return;

    try {
        // frameData.pixels is an ArrayBuffer from the main process
        const pixelBuffer = new Uint8Array(frameData.pixels);

        const processedPixels = renderer.renderFrame(pixelBuffer);
        
        window.electronAPI.sendExportResult({
            frameNumber: frameData.frameNumber,
            pixels: processedPixels.buffer // Send back the underlying ArrayBuffer
        });
    } catch (e) {
        window.electronAPI.sendExportError(e.message);
    }
});