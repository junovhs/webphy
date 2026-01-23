// NITRATE WebGL Renderer
// GPU-accelerated film simulation

const Renderer = {
    gl: null,
    canvas: null,
    program: null,
    texture: null,
    uniforms: {
        exposure: 0.0,
        grain: 0.25,
        halation: 0.15
    },

    init(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            console.error('[Renderer] Canvas not found:', canvasId);
            return false;
        }

        this.gl = this.canvas.getContext('webgl2');
        if (!this.gl) {
            console.error('[Renderer] WebGL2 not supported');
            return false;
        }

        this.buildShaders();
        this.setupGeometry();
        console.log('[Renderer] Initialized');
        return true;
    },

    buildShaders() {
        const gl = this.gl;

        const vert = `#version 300 es
            in vec2 aPosition;
            in vec2 aTexCoord;
            out vec2 vUV;
            void main() {
                vUV = aTexCoord;
                gl_Position = vec4(aPosition, 0.0, 1.0);
            }
        `;

        // Passthrough for now - filters come Phase 3
        const frag = `#version 300 es
            precision highp float;
            in vec2 vUV;
            out vec4 fragColor;
            
            uniform sampler2D uTexture;
            uniform float uExposure;
            uniform float uGrain;
            uniform float uHalation;
            uniform float uTime;
            
            void main() {
                vec4 color = texture(uTexture, vUV);
                
                // Exposure (linear space)
                color.rgb *= exp2(uExposure);
                
                // Clamp and output
                fragColor = vec4(clamp(color.rgb, 0.0, 1.0), 1.0);
            }
        `;

        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vert);
        gl.compileShader(vs);

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, frag);
        gl.compileShader(fs);

        this.program = gl.createProgram();
        gl.attachShader(this.program, vs);
        gl.attachShader(this.program, fs);
        gl.linkProgram(this.program);
        gl.useProgram(this.program);
    },

    setupGeometry() {
        const gl = this.gl;

        const quad = new Float32Array([
            -1, -1,  0, 1,
             1, -1,  1, 1,
            -1,  1,  0, 0,
             1,  1,  1, 0,
        ]);

        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

        const aPosition = gl.getAttribLocation(this.program, 'aPosition');
        const aTexCoord = gl.getAttribLocation(this.program, 'aTexCoord');

        gl.enableVertexAttribArray(aPosition);
        gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 16, 0);

        gl.enableVertexAttribArray(aTexCoord);
        gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 16, 8);
    },

    loadImage(path) {
        const img = new Image();
        img.onload = () => {
            this.uploadTexture(img);
            this.resizeCanvas(img.width, img.height);
            this.render();
        };
        img.onerror = () => console.error('[Renderer] Failed to load:', path);
        img.src = path;
    },

    uploadTexture(img) {
        const gl = this.gl;

        if (this.texture) gl.deleteTexture(this.texture);

        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    },

    resizeCanvas(imgW, imgH) {
        const container = this.canvas.parentElement;
        const maxW = container.clientWidth;
        const maxH = container.clientHeight;
        const scale = Math.min(maxW / imgW, maxH / imgH, 1);

        this.canvas.width = Math.floor(imgW * scale);
        this.canvas.height = Math.floor(imgH * scale);
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    },

    setUniform(name, value) {
        this.uniforms[name] = value;
        this.render();
    },

    render() {
        if (!this.texture) return;

        const gl = this.gl;
        gl.useProgram(this.program);

        gl.uniform1f(gl.getUniformLocation(this.program, 'uExposure'), this.uniforms.exposure);
        gl.uniform1f(gl.getUniformLocation(this.program, 'uGrain'), this.uniforms.grain);
        gl.uniform1f(gl.getUniformLocation(this.program, 'uHalation'), this.uniforms.halation);
        gl.uniform1f(gl.getUniformLocation(this.program, 'uTime'), performance.now() / 1000);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
};

window.Renderer = Renderer;