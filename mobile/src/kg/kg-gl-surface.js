/**
 * Adapt an expo-gl context (or the WebGL2 context the web export's GLView
 * makes) into the stage's GL surface: a canvas-like object three can hold,
 * the layout size, the drawing-buffer ratio, and `endFrameEXP` after each
 * frame. Native expo-gl lacks a few WebGL niceties; the shim fills them so
 * three.js runs unmodified.
 */

// three's RGBA half-float type id (THREE.HalfFloatType) / UnsignedByteType.
export const HALF_FLOAT_TYPE = 1016;
export const UNSIGNED_BYTE_TYPE = 1009;

const UNPACK_FLIP_Y_WEBGL = 0x9240;
const UNPACK_ALIGNMENT = 0x0cf5;

/**
 * Effects for a device tier. Bloom runs everywhere: on half-float render
 * targets at half res where the GPU supports them, otherwise (and on the low
 * tier) as the LDR fallback — 8-bit targets at quarter res, so low-end
 * phones still glow. The post chain (tone mapping, downscaled render) stays
 * on everywhere.
 */
export function effectsFor(halfFloat, tier) {
  const full = !!halfFloat && tier !== 'low';
  return {
    bloom: true,
    bloomMode: full ? 'hdr' : 'ldr',
    bloomDivisor: full ? 2 : 4,
    postChain: true,
    targetType: halfFloat ? HALF_FLOAT_TYPE : UNSIGNED_BYTE_TYPE,
  };
}

/** True when this GPU can render into RGBA16F (bloom + HDR post chain). */
export function probeHalfFloat(gl) {
  try {
    if (typeof gl.createFramebuffer !== 'function' || typeof gl.texStorage2D !== 'function') return false;
    const isNative = !(typeof HTMLCanvasElement !== 'undefined' && gl.canvas instanceof HTMLCanvasElement);
    if (!isNative) {
      // Browsers: WebGL2 renders to half float with EXT_color_buffer_float (or _half_float).
      return !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 4, 4);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    return ok;
  } catch {
    return false;
  }
}

/** Fill the WebGL bits expo-gl's native context doesn't provide (idempotent). */
export function shimNativeContext(gl, size) {
  if (gl.__kgShimmed) return gl;
  gl.__kgShimmed = true;
  const pixelStorei = gl.pixelStorei?.bind(gl);
  if (pixelStorei) {
    // expo-gl logs "doesn't support this parameter" for every other pname three sets per upload.
    gl.pixelStorei = (pname, value) => {
      if (pname === UNPACK_FLIP_Y_WEBGL || pname === UNPACK_ALIGNMENT) pixelStorei(pname, value);
    };
  }
  const getParameter = gl.getParameter?.bind(gl);
  if (getParameter) {
    gl.getParameter = (pname) => {
      const v = getParameter(pname);
      if ((pname === gl.VIEWPORT || pname === gl.SCISSOR_BOX) && !v) {
        return new Int32Array([0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight]);
      }
      return v;
    };
  }
  for (const name of ['invalidateFramebuffer', 'readBuffer']) {
    if (typeof gl[name] !== 'function') gl[name] = () => {};
  }
  if (typeof gl.getContextAttributes !== 'function') {
    gl.getContextAttributes = () => ({ alpha: true, depth: true, stencil: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  }
  if (typeof gl.makeXRCompatible !== 'function') gl.makeXRCompatible = () => Promise.resolve();
  void size;
  return gl;
}

/** A canvas-like object three.js can hold for a native context. */
function fakeCanvas(gl, sizeOf) {
  const listeners = {};
  return {
    get width() {
      return gl.drawingBufferWidth;
    },
    set width(_v) {},
    get height() {
      return gl.drawingBufferHeight;
    },
    set height(_v) {},
    get clientWidth() {
      return sizeOf().w;
    },
    get clientHeight() {
      return sizeOf().h;
    },
    style: {},
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    setAttribute() {},
    getContext: () => gl,
    getBoundingClientRect() {
      const s = sizeOf();
      return { left: 0, top: 0, x: 0, y: 0, width: s.w, height: s.h, right: s.w, bottom: s.h };
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
}

/**
 * Stage surface for a GL context. `opts`: size() (layout px), halfFloat,
 * bloom, bloomDivisor, pause, writeLabels(labels, leaders), obstacles().
 */
export function glSurfaceFor(gl, opts) {
  let override = null;
  const sizeOf = () => override || opts.size();
  const isWebCanvas = typeof HTMLCanvasElement !== 'undefined' && gl.canvas instanceof HTMLCanvasElement;
  if (!isWebCanvas) shimNativeContext(gl, sizeOf);
  const canvas = isWebCanvas ? gl.canvas : fakeCanvas(gl, sizeOf);
  return {
    context: gl,
    canvas,
    size: sizeOf,
    pixelRatio: () => {
      const s = sizeOf();
      // The drawing buffer's real ratio (expo-gl sizes it to the view × screen scale).
      if (!isWebCanvas && gl.drawingBufferWidth && s.w) return gl.drawingBufferWidth / s.w;
      return globalThis.devicePixelRatio || 1;
    },
    present: () => gl.endFrameEXP?.(),
    postChain: true,
    targetType: opts.halfFloat ? HALF_FLOAT_TYPE : UNSIGNED_BYTE_TYPE,
    bloom: !!opts.bloom,
    bloomDivisor: opts.bloomDivisor || 2,
    pause: opts.pause || null,
    writeLabels: opts.writeLabels,
    obstacles: opts.obstacles,
    setSize(w, h) {
      override = { w, h };
    },
  };
}
