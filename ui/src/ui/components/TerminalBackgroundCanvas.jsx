/**
 * InfiniBot Black & Gold Terminal Background
 * Pure Canvas/WebGL - NO external dependencies
 * Self-contained with built-in shader compilation
 */

import { useEffect, useRef, useMemo, useCallback } from 'react';

const vertexShader = `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentShader = `
precision mediump float;
varying vec2 vUv;
uniform float iTime;
uniform vec3 iResolution;
uniform float uScale;
uniform vec2 uGridMul;
uniform float uDigitSize;
uniform float uScanlineIntensity;
uniform float uGlitchAmount;
uniform float uFlickerAmount;
uniform float uNoiseAmp;
uniform float uChromaticAberration;
uniform float uDither;
uniform float uCurvature;
uniform vec3 uTint;
uniform vec2 uMouse;
uniform float uMouseStrength;
uniform float uUseMouse;
uniform float uBrightness;

float time;

float hash21(vec2 p){
  p = fract(p * 234.56);
  p += dot(p, p + 34.56);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  return sin(p.x * 10.0) * sin(p.y * (3.0 + sin(time * 0.090909))) + 0.2;
}

mat2 rotate(float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c);
}

float fbm(vec2 p) {
  p *= 1.1;
  float f = 0.0;
  float amp = 0.5 * uNoiseAmp;
  mat2 modify0 = rotate(time * 0.02);
  f += amp * noise(p);
  p = modify0 * p * 2.0;
  amp *= 0.454545;
  mat2 modify1 = rotate(time * 0.02);
  f += amp * noise(p);
  p = modify1 * p * 2.0;
  amp *= 0.454545;
  mat2 modify2 = rotate(time * 0.08);
  f += amp * noise(p);
  return f;
}

float pattern(vec2 p, out vec2 q, out vec2 r) {
  vec2 offset1 = vec2(1.0);
  vec2 offset0 = vec2(0.0);
  mat2 rot01 = rotate(0.1 * time);
  mat2 rot1 = rotate(0.1);
  q = vec2(fbm(p + offset1), fbm(rot01 * p + offset1));
  r = vec2(fbm(rot1 * q + offset0), fbm(q + offset0));
  return fbm(p + r);
}

float digit(vec2 p){
  vec2 grid = uGridMul * 15.0;
  vec2 s = floor(p * grid) / grid;
  p = p * grid;
  vec2 q, r;
  float intensity = pattern(s * 0.1, q, r) * 1.3 - 0.03;
  
  if(uUseMouse > 0.5){
    vec2 mouseWorld = uMouse * uScale;
    float distToMouse = distance(s, mouseWorld);
    float mouseInfluence = exp(-distToMouse * 8.0) * uMouseStrength * 10.0;
    intensity += mouseInfluence;
    float ripple = sin(distToMouse * 20.0 - iTime * 5.0) * 0.1 * mouseInfluence;
    intensity += ripple;
  }
  
  p = fract(p);
  p *= uDigitSize;
  float px5 = p.x * 5.0;
  float py5 = (1.0 - p.y) * 5.0;
  float x = fract(px5);
  float y = fract(py5);
  float i = floor(py5) - 2.0;
  float j = floor(px5) - 2.0;
  float n = i * i + j * j;
  float f = n * 0.0625;
  float isOn = step(0.1, intensity - f);
  float brightness = isOn * (0.2 + y * 0.8) * (0.75 + x * 0.25);
  return step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0) * brightness;
}

float onOff(float a, float b, float c) {
  return step(c, sin(iTime + a * cos(iTime * b))) * uFlickerAmount;
}

float displace(vec2 look) {
  float y = look.y - mod(iTime * 0.25, 1.0);
  float window = 1.0 / (1.0 + 50.0 * y * y);
  return sin(look.y * 20.0 + iTime) * 0.0125 * onOff(4.0, 2.0, 0.8) * (1.0 + cos(iTime * 60.0)) * window;
}

vec3 getColor(vec2 p){
  float bar = step(mod(p.y + time * 20.0, 1.0), 0.2) * 0.4 + 1.0;
  bar *= uScanlineIntensity;
  
  float displacement = displace(p);
  p.x += displacement;
  
  if (uGlitchAmount != 1.0) {
    float extra = displacement * (uGlitchAmount - 1.0);
    p.x += extra;
  }
  
  float middle = digit(p);
  const float off = 0.002;
  float sum = digit(p + vec2(-off, -off)) + digit(p + vec2(0.0, -off)) + digit(p + vec2(off, -off)) +
              digit(p + vec2(-off, 0.0)) + digit(p + vec2(0.0, 0.0)) + digit(p + vec2(off, 0.0)) +
              digit(p + vec2(-off, off)) + digit(p + vec2(0.0, off)) + digit(p + vec2(off, off));
  
  vec3 baseColor = vec3(0.9) * middle + sum * 0.1 * vec3(1.0) * bar;
  return baseColor;
}

vec2 barrel(vec2 uv){
  vec2 c = uv * 2.0 - 1.0;
  float r2 = dot(c, c);
  c *= 1.0 + uCurvature * r2;
  return c * 0.5 + 0.5;
}

void main() {
  time = iTime * 0.333333;
  vec2 uv = vUv;
  
  uv = barrel(uv);
  
  vec2 p = uv * uScale;
  vec3 col = getColor(p);
  
  col *= uTint;
  col *= uBrightness;
  
  if(uDither > 0.0){
    float rnd = hash21(gl_FragCoord.xy);
    col += (rnd - 0.5) * (uDither * 0.003922);
  }
  
  gl_FragColor = vec4(col, 1.0);
}
`;

function hexToRgb(hex) {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const num = parseInt(h, 16);
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compilation error:', gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program linking error:', gl.getProgramInfoLog(program));
    return null;
  }
  return program;
}

export default function TerminalBackgroundCanvas({
  scale = 1.2,
  gridMul = [2, 1],
  digitSize = 1.5,
  timeScale = 0.3,
  scanlineIntensity = 0.3,
  glitchAmount = 1.1,
  flickerAmount = 0.5,
  noiseAmp = 0.3,
  chromaticAberration = 0,
  dither = 0.3,
  curvature = 0.1,
  tint = '#D4AF37',
  mouseReact = true,
  mouseStrength = 0.2,
  brightness = 0.75,
  className = '',
  style = {},
}) {
  const canvasRef = useRef(null);
  const glRef = useRef(null);
  const programRef = useRef(null);
  const mouseRef = useRef({ x: 0.5, y: 0.5 });
  const rafRef = useRef(null);
  const timeOffsetRef = useRef(Math.random() * 100);

  const tintVec = useMemo(() => hexToRgb(tint), [tint]);

  const handleMouseMove = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    mouseRef.current = {
      x: (e.clientX - rect.left) / rect.width,
      y: 1 - (e.clientY - rect.top) / rect.height,
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', { antialias: false });
    if (!gl) {
      console.error('WebGL not supported');
      return;
    }
    glRef.current = gl;

    gl.clearColor(0, 0, 0, 1);

    const program = createProgram(gl, vertexShader, fragmentShader);
    if (!program) return;
    programRef.current = program;

    // Set up geometry (full-screen triangle)
    const positions = new Float32Array([-1, -1, 3, -1, -1, 3]);
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const positionLoc = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    gl.useProgram(program);

    // Get uniform locations
    const uniforms = {
      iTime: gl.getUniformLocation(program, 'iTime'),
      iResolution: gl.getUniformLocation(program, 'iResolution'),
      uScale: gl.getUniformLocation(program, 'uScale'),
      uGridMul: gl.getUniformLocation(program, 'uGridMul'),
      uDigitSize: gl.getUniformLocation(program, 'uDigitSize'),
      uScanlineIntensity: gl.getUniformLocation(program, 'uScanlineIntensity'),
      uGlitchAmount: gl.getUniformLocation(program, 'uGlitchAmount'),
      uFlickerAmount: gl.getUniformLocation(program, 'uFlickerAmount'),
      uNoiseAmp: gl.getUniformLocation(program, 'uNoiseAmp'),
      uChromaticAberration: gl.getUniformLocation(program, 'uChromaticAberration'),
      uDither: gl.getUniformLocation(program, 'uDither'),
      uCurvature: gl.getUniformLocation(program, 'uCurvature'),
      uTint: gl.getUniformLocation(program, 'uTint'),
      uMouse: gl.getUniformLocation(program, 'uMouse'),
      uMouseStrength: gl.getUniformLocation(program, 'uMouseStrength'),
      uUseMouse: gl.getUniformLocation(program, 'uUseMouse'),
      uBrightness: gl.getUniformLocation(program, 'uBrightness'),
    };

    function resize() {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform3f(uniforms.iResolution, canvas.width, canvas.height, canvas.width / canvas.height);
    }

    const resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(canvas);
    resize();

    const update = (t) => {
      const elapsed = (t * 0.001 + timeOffsetRef.current) * timeScale;
      gl.uniform1f(uniforms.iTime, elapsed);
      gl.uniform1f(uniforms.uScale, scale);
      gl.uniform2f(uniforms.uGridMul, gridMul[0], gridMul[1]);
      gl.uniform1f(uniforms.uDigitSize, digitSize);
      gl.uniform1f(uniforms.uScanlineIntensity, scanlineIntensity);
      gl.uniform1f(uniforms.uGlitchAmount, glitchAmount);
      gl.uniform1f(uniforms.uFlickerAmount, flickerAmount);
      gl.uniform1f(uniforms.uNoiseAmp, noiseAmp);
      gl.uniform1f(uniforms.uChromaticAberration, chromaticAberration);
      gl.uniform1f(uniforms.uDither, dither);
      gl.uniform1f(uniforms.uCurvature, curvature);
      gl.uniform3f(uniforms.uTint, tintVec[0], tintVec[1], tintVec[2]);
      gl.uniform2f(uniforms.uMouse, mouseRef.current.x, mouseRef.current.y);
      gl.uniform1f(uniforms.uMouseStrength, mouseStrength);
      gl.uniform1f(uniforms.uUseMouse, mouseReact ? 1.0 : 0.0);
      gl.uniform1f(uniforms.uBrightness, brightness);

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      rafRef.current = requestAnimationFrame(update);
    };

    rafRef.current = requestAnimationFrame(update);

    if (mouseReact) {
      canvas.addEventListener('mousemove', handleMouseMove);
    }

    return () => {
      cancelAnimationFrame(rafRef.current);
      resizeObserver.disconnect();
      if (mouseReact) canvas.removeEventListener('mousemove', handleMouseMove);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      timeOffsetRef.current = Math.random() * 100;
    };
  }, [scale, gridMul, digitSize, timeScale, scanlineIntensity, glitchAmount, flickerAmount, noiseAmp, chromaticAberration, dither, curvature, tintVec, mouseReact, mouseStrength, brightness, handleMouseMove]);

  return (
    <canvas
      ref={canvasRef}
      className={`terminal-background-canvas ${className}`}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        ...style,
      }}
    />
  );
}
