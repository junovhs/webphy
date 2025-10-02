// WebGL context setup and texture/framebuffer utilities

export function initGL(canvas) {
  const gl = canvas.getContext('webgl2', { 
    premultipliedAlpha: false, 
    preserveDrawingBuffer: true 
  }) || canvas.getContext('webgl', { 
    premultipliedAlpha: false, 
    preserveDrawingBuffer: true 
  });

  if (!gl) {
    alert('WebGL not supported');
    return null;
  }

  return gl;
}

export function getCapabilities(gl) {
  const gl2 = (typeof WebGL2RenderingContext !== 'undefined') && 
               (gl instanceof WebGL2RenderingContext);
  const extCBF = gl.getExtension('EXT_color_buffer_float') || 
                 gl.getExtension('EXT_color_buffer_half_float');
  const extHF = !gl2 && gl.getExtension('OES_texture_half_float');
  const extHFL = !gl2 && gl.getExtension('OES_texture_half_float_linear');
  const halfType = gl2 ? gl.HALF_FLOAT : (extHF && extHF.HALF_FLOAT_OES);
  const canFloatRT = !!(extCBF && (gl2 || extHF));
  const canLinear = gl2 || !!extHFL;

  return { gl2, canFloatRT, halfType, canLinear };
}

export function createQuadBuffer(gl) {
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1
  ]), gl.STATIC_DRAW);
  return quad;
}

export function createTexture(gl, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export function createRenderTexture(gl, caps, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  
  if (caps.canFloatRT) {
    if (caps.gl2) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, caps.halfType, null);
    }
    const filter = caps.canLinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }
  
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export function createFramebuffer(gl, caps, w, h) {
  const tex = createRenderTexture(gl, caps, w, h);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { fbo, tex, w, h };
}

export function ensureFramebuffer(rt, gl, caps, w, h) {
  if (!rt || rt.w !== w || rt.h !== h) {
    if (rt) {
      gl.deleteFramebuffer(rt.fbo);
      gl.deleteTexture(rt.tex);
    }
    return createFramebuffer(gl, caps, w, h);
  }
  return rt;
}

export function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  
  return shader;
}

export function bindProgram(gl, program, quad, canvasWidth, canvasHeight) {
  gl.useProgram(program);
  
  const posLoc = gl.getAttribLocation(program, 'a_pos');
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  
  const resLoc = gl.getUniformLocation(program, 'uRes');
  if (resLoc) {
    gl.uniform2f(resLoc, canvasWidth, canvasHeight);
  }
}