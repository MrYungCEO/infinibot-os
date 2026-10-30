import { Renderer, Camera, Transform, Mesh, Program, Sphere, Geometry } from 'ogl';
import type { OGLRenderingContext } from 'ogl';

// ============================================================
// PREMIUM VOICE BLOB — Style-aware WebGL renderer
// Five swappable styles, audio-reactive displacement, particles
// ============================================================

export type BlobState = 'idle' | 'listening' | 'speaking' | 'processing';
export type BlobStyle =
  | 'audio-wireframe'
  | 'dot-matrix'
  | 'molten-gold'
  | 'plasma-core'
  | 'liquid-mercury'
  | 'obsidian-glass'
  | 'aurora';

export const BLOB_STYLES: { id: BlobStyle; label: string; swatch: [string, string] }[] = [
  { id: 'audio-wireframe', label: 'Audio Wireframe', swatch: ['#0a0b13', '#bfc4cb'] },
  { id: 'dot-matrix',      label: 'Dot Matrix',      swatch: ['#020610', '#7cf5ff'] },
  { id: 'molten-gold',     label: 'Molten Gold',     swatch: ['#7a4d00', '#ffd866'] },
  { id: 'plasma-core',     label: 'Plasma Core',     swatch: ['#1a0033', '#9b3cff'] },
  { id: 'liquid-mercury',  label: 'Liquid Mercury',  swatch: ['#1f242b', '#d6e4f0'] },
  { id: 'obsidian-glass',  label: 'Obsidian',        swatch: ['#05060c', '#4a5cff'] },
  { id: 'aurora',          label: 'Aurora',          swatch: ['#0a1f33', '#7cffe3'] },
];

// True when this style draws the sphere as glowing points rather than a solid surface
export function isPointsStyle(style: BlobStyle): boolean {
    return style === 'dot-matrix';
}
export function isLinesStyle(style: BlobStyle): boolean {
    return style === 'audio-wireframe';
}

// ============================================================
// Shared simplex 3D noise + FBM (used by all vertex shaders)
// ============================================================
const NOISE_GLSL = /* glsl */ `
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

    float snoise(vec3 v) {
        const vec2 C = vec2(1.0/6.0, 1.0/3.0);
        const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
        vec3 i  = floor(v + dot(v, C.yyy));
        vec3 x0 = v - i + dot(i, C.xxx);
        vec3 g = step(x0.yzx, x0.xyz);
        vec3 l = 1.0 - g;
        vec3 i1 = min(g.xyz, l.zxy);
        vec3 i2 = max(g.xyz, l.zxy);
        vec3 x1 = x0 - i1 + C.xxx;
        vec3 x2 = x0 - i2 + C.yyy;
        vec3 x3 = x0 - D.yyy;
        i = mod289(i);
        vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
        float n_ = 0.142857142857;
        vec3 ns = n_ * D.wyz - D.xzx;
        vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
        vec4 x_ = floor(j * ns.z);
        vec4 y_ = floor(j - 7.0 * x_);
        vec4 x = x_ * ns.x + ns.yyyy;
        vec4 y = y_ * ns.x + ns.yyyy;
        vec4 h = 1.0 - abs(x) - abs(y);
        vec4 b0 = vec4(x.xy, y.xy);
        vec4 b1 = vec4(x.zw, y.zw);
        vec4 s0 = floor(b0) * 2.0 + 1.0;
        vec4 s1 = floor(b1) * 2.0 + 1.0;
        vec4 sh = -step(h, vec4(0.0));
        vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
        vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
        vec3 p0 = vec3(a0.xy, h.x);
        vec3 p1 = vec3(a0.zw, h.y);
        vec3 p2 = vec3(a1.xy, h.z);
        vec3 p3 = vec3(a1.zw, h.w);
        vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
        p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
        vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
        m = m * m;
        return 105.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
    }

    float fbm(vec3 p, int octaves) {
        float value = 0.0;
        float amplitude = 0.5;
        float frequency = 1.0;
        for (int i = 0; i < 6; i++) {
            if (i >= octaves) break;
            value += amplitude * snoise(p * frequency);
            frequency *= 2.0;
            amplitude *= 0.5;
        }
        return value;
    }
`;

// ============================================================
// Shared vertex shader — same displacement math for every style
// ============================================================
const VERTEX_SHADER = /* glsl */ `
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec2 uv;

    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    uniform mat3 normalMatrix;
    uniform float uTime;
    uniform float uAudio;
    uniform float uState;
    uniform float uDisplacementScale;

    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    varying vec3 vViewDir;
    varying float vDisplacement;
    varying float vNoise;

    ${NOISE_GLSL}

    void main() {
        vUv = uv;
        float t = uTime;
        float audio = uAudio;
        float activity = audio * audio * audio * audio;

        float stateActivity = activity;
        if (uState > 2.5) stateActivity = max(activity, 0.15);

        float baseSpeed = stateActivity * 0.3;
        vec3 noiseCoord = position * 1.5 + vec3(t * baseSpeed, t * baseSpeed * 0.66, t * baseSpeed * 0.83);
        float baseNoise = fbm(noiseCoord, 4);

        float detailNoise = 0.0;
        if (audio > 0.05) {
            vec3 detailCoord = position * 3.5 + vec3(t * 0.8, -t * 0.6, t * 0.9);
            detailNoise = fbm(detailCoord, 3) * audio;
        }

        float breathAmp = mix(0.003, 0.04, stateActivity);
        float breathRate = mix(0.15, 1.8, stateActivity);
        float breath = sin(t * breathRate) * breathAmp;

        float stateMultiplier = 1.0;
        if (uState > 1.5 && uState < 2.5) stateMultiplier = 1.5;
        else if (uState > 2.5) stateMultiplier = 1.0 + sin(t * 4.0) * 0.3;

        float baseDisp = baseNoise * stateActivity * 0.15;
        float detailDisp = detailNoise * 0.25 * stateMultiplier;
        float displacement = (baseDisp + detailDisp + breath) * uDisplacementScale;

        vec3 displaced = position + normal * displacement;
        vDisplacement = displacement;
        vNoise = baseNoise;

        vWorldPos = (modelViewMatrix * vec4(displaced, 1.0)).xyz;
        vNormal = normalize(normalMatrix * normal);
        vViewDir = normalize(-vWorldPos);

        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
    }
`;

// ============================================================
// Fragment shader pre-amble shared by every style
// ============================================================
const FRAG_PREAMBLE = /* glsl */ `
    precision highp float;

    uniform float uTime;
    uniform float uAudio;
    uniform float uState;

    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    varying vec3 vViewDir;
    varying float vDisplacement;
    varying float vNoise;

    float fresnelSchlick(float cosTheta, float F0) {
        return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
    }

    vec3 iridescence(float angle, float thickness) {
        float delta = thickness * angle * 8.0;
        return vec3(
            0.5 + 0.5 * cos(delta + 0.0),
            0.5 + 0.5 * cos(delta + 2.094),
            0.5 + 0.5 * cos(delta + 4.189)
        );
    }
`;

// ============================================================
// FRAGMENT SHADERS — one per style
// ============================================================

const FRAG_MOLTEN_GOLD = FRAG_PREAMBLE + /* glsl */ `
    void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(vViewDir);
        float NdotV = max(dot(N, V), 0.0);
        float audio = uAudio;
        float activity = audio * audio * audio * audio;

        vec3 goldDeep    = vec3(0.45, 0.30, 0.02);
        vec3 goldMid     = vec3(0.85, 0.65, 0.08);
        vec3 goldBright  = vec3(1.0, 0.88, 0.30);
        vec3 goldWhite   = vec3(1.0, 0.97, 0.85);
        vec3 ember       = vec3(1.0, 0.35, 0.05);
        vec3 amberGlow   = vec3(1.0, 0.55, 0.10);

        vec3 idleColor = mix(goldDeep, goldMid, 0.35);
        vec3 stateColor = idleColor;
        if (uState < 1.5) {
            stateColor = mix(idleColor, mix(goldMid, vec3(0.9, 0.80, 0.35), 0.3), activity);
        } else if (uState < 2.5) {
            stateColor = mix(idleColor, mix(goldBright, goldWhite, 0.4), activity);
        } else {
            float procActivity = max(activity, 0.15);
            float pulse = sin(uTime * 3.0) * 0.5 + 0.5;
            stateColor = mix(idleColor, mix(amberGlow, goldWhite, pulse * 0.5), procActivity);
        }

        vec3 lightDir1 = normalize(vec3(1.5, 2.0, 3.0));
        float diff1 = max(dot(N, lightDir1), 0.0);
        vec3 H1 = normalize(lightDir1 + V);
        float spec1 = pow(max(dot(N, H1), 0.0), 64.0);

        vec3 lightDir2 = normalize(vec3(-1.0, -0.5, 1.5));
        float diff2 = max(dot(N, lightDir2), 0.0) * 0.3;
        float rim = pow(1.0 - NdotV, 4.0);

        vec3 diffuse = mix(goldDeep, stateColor, diff1 * 0.8 + diff2 * 0.2);
        vec3 specColor = mix(goldBright, goldWhite, spec1);
        float specIntensity = mix(0.3, 1.5, activity);
        vec3 specular = specColor * spec1 * specIntensity;

        float fresnel = fresnelSchlick(NdotV, 0.04);
        float fresnelIntensity = mix(0.1, 0.4, activity);
        vec3 fresnelColor = mix(goldMid, goldWhite, fresnel) * fresnel * fresnelIntensity;

        vec3 iriContrib = vec3(0.0);
        if (activity > 0.01) {
            float iriTime = uTime * 0.1 * activity;
            vec3 iriColor = iridescence(NdotV, 1.2 + vDisplacement * 3.0 + iriTime);
            float iriMask = pow(1.0 - NdotV, 3.0) * 0.25 * activity;
            iriContrib = iriColor * goldBright * iriMask;
        }

        float sss = max(0.0, dot(N, -lightDir1) * 0.5 + 0.5);
        sss = pow(sss, 3.0) * 0.15;
        vec3 sssColor = ember * sss * mix(0.08, 1.3, activity);

        float rimIntensity = mix(0.15, 1.4, activity);
        vec3 rimColor = mix(goldMid, amberGlow, audio) * rim * rimIntensity;

        vec3 reflDir = reflect(-V, N);
        float envBright = smoothstep(-0.2, 0.8, reflDir.y);
        vec3 envColor = mix(goldDeep * 0.3, goldMid * 0.5, envBright);
        envColor += goldWhite * pow(max(reflDir.y, 0.0), 8.0) * 0.3;
        vec3 envContrib = envColor * fresnel * mix(0.1, 0.5, activity);

        float peakGlow = smoothstep(0.05, 0.25, vDisplacement) * 0.4 * activity;
        vec3 peakColor = mix(goldBright, goldWhite, peakGlow) * peakGlow;
        float valleyDark = smoothstep(0.05, -0.1, vDisplacement) * 0.3 * activity;

        float noiseDetail = vNoise * 0.15 * activity;
        vec3 surfaceVariation = mix(goldDeep, goldMid, noiseDetail + 0.5 * activity);
        float surfaceWeight = mix(0.0, 0.15, activity);

        vec3 color = diffuse * 0.5 + specular + fresnelColor + iriContrib + sssColor + rimColor + envContrib + peakColor;
        color += surfaceVariation * surfaceWeight;
        color -= vec3(valleyDark);
        color += goldBright * audio * 0.3 * (0.3 + fresnel * 0.5);

        color = color / (color + vec3(1.0));
        color.r = pow(color.r, 0.95);
        color.g = pow(color.g, 0.98);
        color = pow(color, vec3(1.0 / 2.2));
        gl_FragColor = vec4(color, 1.0);
    }
`;

const FRAG_PLASMA = FRAG_PREAMBLE + /* glsl */ `
    void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(vViewDir);
        float NdotV = max(dot(N, V), 0.0);
        float audio = uAudio;
        float activity = audio * audio * audio * audio;

        vec3 deepPurple = vec3(0.18, 0.04, 0.42);
        vec3 violet     = vec3(0.55, 0.20, 0.95);
        vec3 magenta    = vec3(0.95, 0.20, 0.85);
        vec3 cyan       = vec3(0.10, 0.85, 1.00);
        vec3 hotWhite   = vec3(0.95, 0.95, 1.0);

        // Electric arc patterns from noise
        float arc = pow(abs(vNoise), 0.5);
        float energy = mix(0.2, 1.0, activity);

        // Body color shifts with audio + state
        vec3 base = mix(deepPurple, violet, NdotV);
        if (uState > 1.5 && uState < 2.5) {
            base = mix(base, magenta, activity * 0.7);
        } else if (uState > 2.5) {
            float pulse = sin(uTime * 5.0) * 0.5 + 0.5;
            base = mix(base, mix(cyan, magenta, pulse), 0.4);
        }

        // Fresnel-driven cyan rim — electric edge
        float fres = fresnelSchlick(NdotV, 0.05);
        float rim = pow(1.0 - NdotV, 3.0);
        vec3 rimColor = mix(violet, cyan, fres) * rim * mix(0.6, 2.5, activity);

        // Lightning streaks: high-freq noise drives bright veins
        float vein = pow(arc, 6.0) * mix(0.3, 1.6, activity) * energy;
        vec3 veinColor = mix(magenta, hotWhite, vein) * vein;

        // Glowing peaks on displacement
        float peak = smoothstep(0.03, 0.2, vDisplacement);
        vec3 peakColor = mix(cyan, hotWhite, peak) * peak * activity * 1.2;

        // Inner glow — strong, plasma-y
        float coreGlow = pow(1.0 - rim, 2.0) * 0.4;
        vec3 core = mix(deepPurple, violet, coreGlow);

        vec3 color = core + base * 0.4 + rimColor + veinColor + peakColor;
        color += hotWhite * audio * 0.5 * fres;

        // Pulsing brightness on speaking state
        if (uState > 1.5 && uState < 2.5) {
            color *= 1.0 + sin(uTime * 8.0) * 0.08 * audio;
        }

        color = color / (color + vec3(0.8));
        color = pow(color, vec3(1.0 / 2.2));
        gl_FragColor = vec4(color, 1.0);
    }
`;

const FRAG_MERCURY = FRAG_PREAMBLE + /* glsl */ `
    void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(vViewDir);
        float NdotV = max(dot(N, V), 0.0);
        float audio = uAudio;
        float activity = audio * audio * audio * audio;

        // Chrome mercury — heavy reflection, near-white highlights
        vec3 reflDir = reflect(-V, N);

        // Procedural sky reflection (gradient + light bands)
        float skyT = reflDir.y * 0.5 + 0.5;
        vec3 skyHorizon = vec3(0.55, 0.62, 0.72);
        vec3 skyZenith  = vec3(0.85, 0.92, 1.00);
        vec3 skyGround  = vec3(0.10, 0.12, 0.16);
        vec3 sky = mix(skyGround, skyHorizon, smoothstep(0.0, 0.5, skyT));
        sky = mix(sky, skyZenith, smoothstep(0.5, 1.0, skyT));

        // Sun streak in reflection
        float sun = pow(max(dot(reflDir, normalize(vec3(0.6, 0.8, 0.4))), 0.0), 64.0);
        sky += vec3(1.0, 0.97, 0.92) * sun * 1.2;

        // Soft horizon band shifts with audio (chrome ripples)
        float band = sin(reflDir.y * 10.0 + uTime * 0.5 + vNoise * 4.0) * 0.05;
        sky += vec3(band);

        // Fresnel: chrome means very strong rim reflection
        float fres = fresnelSchlick(NdotV, 0.85);

        // Diffuse layer (slight, mercury has minimal diffuse)
        vec3 baseTint = mix(vec3(0.55, 0.60, 0.70), vec3(0.78, 0.84, 0.94), NdotV);

        // Subtle blue-tinged shadow band
        vec3 shadow = vec3(0.30, 0.34, 0.42);
        vec3 lit = mix(shadow, baseTint, smoothstep(0.0, 0.7, NdotV));

        vec3 color = mix(lit, sky, fres);

        // State accent — listening = neutral, speaking = warm tint, processing = cool ripple
        if (uState > 1.5 && uState < 2.5) {
            color = mix(color, color * vec3(1.10, 1.04, 0.96), activity * 0.6);
        } else if (uState > 2.5) {
            float ripple = sin(uTime * 4.0 + vDisplacement * 20.0) * 0.04;
            color += vec3(0.0, ripple * 0.5, ripple) * 0.4;
        }

        // Audio brightens highlights
        color += vec3(1.0) * fres * audio * 0.4;

        color = color / (color + vec3(0.9));
        color = pow(color, vec3(1.0 / 2.2));
        gl_FragColor = vec4(color, 1.0);
    }
`;

const FRAG_OBSIDIAN = FRAG_PREAMBLE + /* glsl */ `
    void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(vViewDir);
        float NdotV = max(dot(N, V), 0.0);
        float audio = uAudio;
        float activity = audio * audio * audio * audio;

        vec3 deepBlack = vec3(0.012, 0.013, 0.02);
        vec3 violet    = vec3(0.28, 0.18, 0.55);
        vec3 indigo    = vec3(0.18, 0.30, 0.95);
        vec3 teal      = vec3(0.20, 0.95, 0.85);
        vec3 white     = vec3(0.95, 0.96, 1.0);

        // Glass: dark body with bright fresnel + refraction-tinted interior
        float fres = fresnelSchlick(NdotV, 0.10);

        // Inner caustic — faked refraction using normal-perturbed noise
        vec3 refrDir = refract(-V, N, 1.0 / 1.5);
        float caustic = fbm(refrDir * 3.0 + vec3(uTime * 0.1, 0.0, 0.0), 3);
        caustic = pow(abs(caustic), 1.5);

        vec3 interior = mix(deepBlack, violet, caustic * 0.5);
        interior = mix(interior, indigo, pow(NdotV, 2.0) * 0.3);

        // Edge glow (fresnel-driven, color depends on state)
        vec3 edgeColor = indigo;
        if (uState < 0.5) edgeColor = indigo;
        else if (uState < 1.5) edgeColor = mix(indigo, teal, 0.4);
        else if (uState < 2.5) edgeColor = mix(indigo, violet, 0.6);
        else {
            float pulse = sin(uTime * 3.0) * 0.5 + 0.5;
            edgeColor = mix(indigo, teal, pulse);
        }
        vec3 rimGlow = edgeColor * fres * mix(0.6, 1.8, activity);

        // Crystalline highlight — sharp specular
        vec3 lightDir = normalize(vec3(0.6, 1.0, 0.8));
        vec3 H = normalize(lightDir + V);
        float spec = pow(max(dot(N, H), 0.0), 128.0);
        vec3 specular = white * spec * (1.0 + activity);

        // Internal sparkle at high displacement
        float sparkle = smoothstep(0.05, 0.15, vDisplacement) * activity;
        vec3 sparkleColor = mix(teal, white, sparkle) * sparkle * 0.8;

        vec3 color = interior * (0.6 + 0.4 * NdotV) + rimGlow + specular + sparkleColor;

        // Inner pulse: at processing state, faint heartbeat from center
        if (uState > 2.5) {
            float beat = sin(uTime * 2.5) * 0.5 + 0.5;
            color += edgeColor * pow(1.0 - NdotV, 6.0) * beat * 0.4;
        }

        color = color / (color + vec3(1.0));
        color = pow(color, vec3(1.0 / 2.2));
        gl_FragColor = vec4(color, 1.0);
    }
`;

const FRAG_AURORA = FRAG_PREAMBLE + /* glsl */ `
    void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(vViewDir);
        float NdotV = max(dot(N, V), 0.0);
        float audio = uAudio;
        float activity = audio * audio * audio * audio;

        vec3 nightBlue = vec3(0.05, 0.08, 0.20);
        vec3 auroraGreen = vec3(0.20, 0.95, 0.55);
        vec3 auroraTeal  = vec3(0.30, 0.90, 0.90);
        vec3 auroraPink  = vec3(0.95, 0.40, 0.75);
        vec3 auroraGold  = vec3(1.00, 0.85, 0.45);

        // Flowing bands from world-space noise
        float t = uTime * 0.15;
        float band1 = fbm(vec3(N * 2.5 + vec3(t, t * 0.7, 0.0)), 4);
        float band2 = fbm(vec3(N * 3.5 + vec3(-t * 0.9, t * 1.1, t * 0.5)), 3);
        float band3 = fbm(vec3(N * 1.5 + vec3(t * 0.4, -t, 0.0)), 2);

        // Mix aurora colors based on bands
        vec3 aurora = nightBlue;
        aurora = mix(aurora, auroraGreen, smoothstep(-0.3, 0.3, band1));
        aurora = mix(aurora, auroraTeal,  smoothstep(0.0, 0.5, band2) * 0.7);
        aurora = mix(aurora, auroraPink,  pow(max(band3, 0.0), 2.0) * 0.6);

        // Edge gives a soft fresnel halo
        float fres = fresnelSchlick(NdotV, 0.08);
        float rim = pow(1.0 - NdotV, 3.0);

        // Soft diffuse light from top
        vec3 lightDir = normalize(vec3(0.3, 1.0, 0.5));
        float diff = max(dot(N, lightDir), 0.0);

        vec3 color = aurora * (0.4 + diff * 0.4);

        // Rim aurora — colored by band1 at edge
        vec3 rimAurora = mix(auroraGreen, auroraPink, smoothstep(-0.3, 0.6, band1));
        color += rimAurora * rim * mix(0.4, 1.4, activity);

        // Specular: soft pearly
        vec3 H = normalize(lightDir + V);
        float spec = pow(max(dot(N, H), 0.0), 24.0);
        color += auroraGold * spec * (0.4 + activity * 1.0);

        // State accents
        if (uState > 1.5 && uState < 2.5) {
            // Speaking — slight golden bloom
            color += auroraGold * fres * 0.3 * activity;
        } else if (uState > 2.5) {
            // Processing — pink pulse
            float pulse = sin(uTime * 2.5) * 0.5 + 0.5;
            color += auroraPink * pulse * 0.2;
        }

        // Audio brightening
        color += auroraTeal * audio * 0.2 * fres;

        color = color / (color + vec3(1.1));
        color = pow(color, vec3(1.0 / 2.2));
        gl_FragColor = vec4(color, 1.0);
    }
`;

// Fragment shaders need their own noise helper too (for FBM in body)
const FRAG_PREAMBLE_NOISE = FRAG_PREAMBLE + NOISE_GLSL;
const FRAG_AURORA_FINAL = FRAG_PREAMBLE_NOISE + FRAG_AURORA.replace(FRAG_PREAMBLE, '');
const FRAG_OBSIDIAN_FINAL = FRAG_PREAMBLE_NOISE + FRAG_OBSIDIAN.replace(FRAG_PREAMBLE, '');

// ============================================================
// DOT MATRIX — glowing-dots renderer
// Uses the sphere vertices as points, displaces along normal,
// reactive size + glow based on audio + state.
// ============================================================
const DOT_VERTEX = /* glsl */ `
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec2 uv;

    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    uniform float uTime;
    uniform float uAudio;
    uniform float uState;
    uniform float uDisplacementScale;
    uniform float uPointBaseSize;

    varying float vAudio;
    varying float vFront;
    varying float vDisplacement;
    varying float vNoise;

    ${NOISE_GLSL}

    void main() {
        float t = uTime;
        float audio = uAudio;
        // Much less damped than the solid-surface styles — dots should clearly
        // react to even moderate mic levels (~0.3 audio).
        float activity = audio * audio;             // quadratic, not quartic
        float linearAct = audio;                    // linear contribution too

        float stateActivity = activity;
        if (uState > 2.5) stateActivity = max(activity, 0.20);

        float baseSpeed = max(stateActivity, 0.04) * 0.6; // gentle ambient drift at idle
        vec3 noiseCoord = position * 1.7 + vec3(t * baseSpeed, t * baseSpeed * 0.66, t * baseSpeed * 0.83);
        float baseNoise = snoise(noiseCoord);

        float detailNoise = 0.0;
        if (audio > 0.02) {
            vec3 detailCoord = position * 3.5 + vec3(t * 0.7, -t * 0.5, t * 0.8);
            detailNoise = snoise(detailCoord) * (0.4 + audio);
        }

        float breathAmp = mix(0.008, 0.08, stateActivity);
        float breathRate = mix(0.25, 2.0, stateActivity);
        float breath = sin(t * breathRate) * breathAmp;

        float baseDisp = baseNoise * max(stateActivity, 0.05) * 0.30;
        float detailDisp = detailNoise * 0.32;
        float displacement = (baseDisp + detailDisp + breath) * uDisplacementScale;

        vec3 displaced = position + normal * displacement;
        vec4 mvPos = modelViewMatrix * vec4(displaced, 1.0);

        // Front-facing dots are larger & brighter; back-facing dots fade
        vec3 viewDir = normalize(-mvPos.xyz);
        vec3 worldNormal = normalize(mat3(modelViewMatrix) * normal);
        float front = max(dot(worldNormal, viewDir), 0.0);
        vFront = front;
        vAudio = audio;
        vDisplacement = displacement;
        vNoise = baseNoise;

        // Audio-reactive size: idle = small but visible dots, speaking = big pulsing dots
        float sizePulse = 1.0 + linearAct * 1.2 + activity * 1.8 + max(0.0, displacement) * 5.0;
        // Per-dot twinkle: very organic at rest
        float twinkle = 0.80 + 0.45 * snoise(position * 5.0 + vec3(t * (0.5 + linearAct * 1.5)));
        float size = uPointBaseSize * sizePulse * twinkle;
        // Perspective scaling — minimum size floor so dots are visible at idle.
        // Hard ceiling at 40px so high-energy frames don't blow up fill rate
        // (each dot uses additive blending, so overdraw scales with point area).
        float perspSize = max(1.5, size * (300.0 / -mvPos.z)) * mix(0.55, 1.0, front);
        gl_PointSize = min(perspSize, 40.0);

        gl_Position = projectionMatrix * mvPos;
    }
`;

const DOT_FRAGMENT = /* glsl */ `
    precision highp float;

    uniform float uTime;
    uniform float uAudio;
    uniform float uState;
    uniform vec3  uCoolColor;   // idle / listening
    uniform vec3  uHotColor;    // speaking
    uniform vec3  uProcColor;   // processing
    uniform vec3  uCoreColor;   // hot center of each dot

    varying float vAudio;
    varying float vFront;
    varying float vDisplacement;
    varying float vNoise;

    void main() {
        // Render each point as a glowing dot with a hot core
        vec2 c = gl_PointCoord - vec2(0.5);
        float r = length(c);
        if (r > 0.5) discard;

        float core = smoothstep(0.5, 0.0, r);
        float halo = pow(1.0 - r * 2.0, 1.6); // wider, softer glow

        float audio = vAudio;
        float activity = audio * audio; // match vertex shader curve

        // Choose base color by state
        vec3 baseColor = uCoolColor;
        if (uState > 1.5 && uState < 2.5) {
            baseColor = mix(uCoolColor, uHotColor, 0.65 + 0.35 * activity);
        } else if (uState > 2.5) {
            float pulse = sin(uTime * 3.0) * 0.5 + 0.5;
            baseColor = mix(uCoolColor, uProcColor, 0.4 + 0.4 * pulse);
        } else if (uState > 0.5) {
            // listening — clearer cool->warm shift on user voice
            baseColor = mix(uCoolColor, uHotColor, audio * 0.8);
        }

        // Peaks (displaced outward) glow brighter
        float displaceBoost = smoothstep(0.0, 0.15, vDisplacement);
        baseColor = mix(baseColor, uHotColor, displaceBoost * 0.7);

        // Front facing = full color; backside dots remain visible at lower intensity
        float facing = mix(0.30, 1.0, vFront);

        // Strong base brightness even at idle so dots are clearly visible
        vec3 color = baseColor * (0.55 + halo * 1.1) * facing
                   + uCoreColor * core * (0.7 + activity * 1.2) * facing;

        // Add audio-driven boost
        color += uHotColor * audio * 0.55 * (core + halo * 0.4) * facing;

        float alpha = (halo * 1.0 + core * 0.85) * facing;
        alpha = min(alpha, 1.0);
        gl_FragColor = vec4(color, alpha);
    }
`;

// audio-wireframe and dot-matrix have their own shaders & programs; this map
// only matters for the surface (TRIANGLE-mode) styles.
const FRAGMENT_SHADERS: Record<BlobStyle, string> = {
    'audio-wireframe': FRAG_MOLTEN_GOLD, // placeholder — never used at runtime
    'dot-matrix':      FRAG_MOLTEN_GOLD, // placeholder — never used at runtime
    'molten-gold':     FRAG_MOLTEN_GOLD,
    'plasma-core':     FRAG_PLASMA,
    'liquid-mercury':  FRAG_MERCURY,
    'obsidian-glass':  FRAG_OBSIDIAN_FINAL,
    'aurora':          FRAG_AURORA_FINAL,
};

interface DotPalette {
    cool:  [number, number, number];
    hot:   [number, number, number];
    proc:  [number, number, number];
    core:  [number, number, number];
    pointBaseSize: number;
}

// ============================================================
// AUDIO WIREFRAME — Percobain-inspired wireframe icosphere
// Bass inflates the radius, treble warps with high-freq noise.
// ============================================================

const WF_VERTEX = /* glsl */ `
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec2 uv;

    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    uniform float uTime;
    uniform float uBass;     // 0..1 low-frequency energy
    uniform float uTreble;   // 0..1 high-frequency energy
    uniform float uDisplacementScale;

    varying float vAudio;
    varying float vDisplacement;
    varying vec3 vNormal;

    ${NOISE_GLSL}

    void main() {
        float t = uTime;
        // Direction from sphere center to vertex (unit vector since sphere is unit-radius)
        vec3 dir = normalize(position);

        // Bass-driven uniform inflation. Even tiny bass produces visible breathing.
        float inflation = 0.04 + uBass * 0.55;

        // Treble-driven high-frequency noise warp. Multiple octaves for organic edges.
        float rf = t * 0.7;
        float warp = snoise(dir * 2.5 + vec3(rf, rf * 0.8, rf * 0.6))
                   + 0.5 * snoise(dir * 5.0 + vec3(-rf, rf, rf * 1.3));
        warp *= (0.05 + uTreble * 0.55);

        // Subtle ambient breathing so the wireframe never sits perfectly still
        float breath = sin(t * 0.6) * 0.015;

        float displacement = (inflation + warp + breath) * uDisplacementScale;
        vec3 displaced = position * (1.0 + displacement);

        vDisplacement = displacement;
        vAudio = max(uBass, uTreble);
        vNormal = normal;

        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
    }
`;

const WF_FRAGMENT = /* glsl */ `
    precision highp float;
    uniform float uTime;
    uniform float uBass;
    uniform float uTreble;
    uniform float uState;
    uniform vec3 uColorCool;
    uniform vec3 uColorHot;
    uniform vec3 uColorProc;

    varying float vAudio;
    varying float vDisplacement;
    varying vec3 vNormal;

    void main() {
        float audio = vAudio;
        vec3 base = uColorCool;
        if (uState > 1.5 && uState < 2.5) {
            base = mix(uColorCool, uColorHot, 0.55 + 0.45 * audio);
        } else if (uState > 2.5) {
            float pulse = sin(uTime * 3.0) * 0.5 + 0.5;
            base = mix(uColorCool, uColorProc, 0.4 + 0.45 * pulse);
        } else if (uState > 0.5) {
            base = mix(uColorCool, uColorHot, audio * 0.6);
        }

        // Brighten peaks (positive displacement) — spikes glow
        float peak = smoothstep(0.0, 0.4, vDisplacement);
        vec3 color = mix(base, uColorHot, peak * 0.7);

        // Treble bloom — adds a halo of warmth that pulses with high frequencies
        color += uColorHot * uTreble * 0.4;

        // Output as additive light — full-bright lines that combine cleanly
        gl_FragColor = vec4(color, 1.0);
    }
`;

interface WireframePalette {
    cool: [number, number, number];
    hot:  [number, number, number];
    proc: [number, number, number];
    bgInner: [number, number, number];
    bgOuter: [number, number, number];
    halo: [number, number, number];
    displacementScale: number;
}

const WIREFRAME_PALETTE: WireframePalette = {
    cool: [0.65, 0.68, 0.72], // neutral grey-white at rest (matches Percobain reference)
    hot:  [1.00, 0.92, 0.65], // warm flare on speech / peaks
    proc: [0.55, 0.75, 1.00], // cool blue when processing
    bgInner: [0.02, 0.025, 0.04], bgOuter: [0.0, 0.0, 0.0],
    halo: [0.55, 0.60, 0.75],
    displacementScale: 1.0,
};

const DOT_PALETTE: DotPalette = {
    cool: [0.48, 0.88, 1.00], // brighter cyan
    hot:  [1.00, 0.95, 0.55], // warm gold-white when speaking
    proc: [0.90, 0.50, 1.00], // violet
    core: [1.00, 1.00, 1.00],
    pointBaseSize: 1.2,        // multiplied by perspective scale (≈67) → ~80px before clamp
};

// Per-style ambient/particle/background palettes
interface StylePalette {
    bgInner: [number, number, number];
    bgOuter: [number, number, number];
    halo: [number, number, number];
    particleDeep: [number, number, number];
    particleBright: [number, number, number];
    displacementScale: number;
}

const STYLE_PALETTES: Record<BlobStyle, StylePalette> = {
    'audio-wireframe': {
        bgInner: WIREFRAME_PALETTE.bgInner, bgOuter: WIREFRAME_PALETTE.bgOuter,
        halo: WIREFRAME_PALETTE.halo,
        particleDeep: [0.30, 0.32, 0.40], particleBright: [0.85, 0.90, 1.00],
        displacementScale: WIREFRAME_PALETTE.displacementScale,
    },
    'dot-matrix': {
        bgInner: [0.015, 0.025, 0.045], bgOuter: [0.0, 0.0, 0.0],
        halo: [0.30, 0.65, 0.95],
        particleDeep: [0.15, 0.35, 0.65], particleBright: [0.6, 0.95, 1.0],
        displacementScale: 1.1,
    },
    'molten-gold': {
        bgInner: [0.06, 0.04, 0.01], bgOuter: [0.0, 0.0, 0.0],
        halo: [0.8, 0.6, 0.1],
        particleDeep: [0.8, 0.6, 0.1], particleBright: [1.0, 0.95, 0.7],
        displacementScale: 1.0,
    },
    'plasma-core': {
        bgInner: [0.08, 0.02, 0.18], bgOuter: [0.0, 0.0, 0.02],
        halo: [0.6, 0.2, 0.9],
        particleDeep: [0.4, 0.1, 0.8], particleBright: [0.95, 0.6, 1.0],
        displacementScale: 1.15,
    },
    'liquid-mercury': {
        bgInner: [0.10, 0.12, 0.15], bgOuter: [0.0, 0.0, 0.0],
        halo: [0.6, 0.7, 0.85],
        particleDeep: [0.4, 0.45, 0.55], particleBright: [0.95, 0.97, 1.0],
        displacementScale: 0.7,
    },
    'obsidian-glass': {
        bgInner: [0.02, 0.02, 0.06], bgOuter: [0.0, 0.0, 0.0],
        halo: [0.3, 0.3, 0.7],
        particleDeep: [0.15, 0.2, 0.5], particleBright: [0.6, 0.8, 1.0],
        displacementScale: 0.85,
    },
    'aurora': {
        bgInner: [0.02, 0.05, 0.12], bgOuter: [0.0, 0.0, 0.02],
        halo: [0.2, 0.8, 0.6],
        particleDeep: [0.2, 0.7, 0.5], particleBright: [0.8, 1.0, 0.85],
        displacementScale: 1.0,
    },
};

// ============================================================
// Particle shaders (color comes via uniforms now)
// ============================================================
const PARTICLE_VERT = /* glsl */ `
    attribute vec3 position;
    attribute float aSize;
    attribute float aPhase;
    attribute float aBrightness;

    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    uniform float uTime;
    uniform float uAudio;

    varying float vBrightness;
    varying float vAlpha;

    void main() {
        float t = uTime;
        float phase = aPhase;
        float audio = uAudio;
        float activity = audio * audio * audio * audio;

        float homeAngle = phase * 6.28;
        float homeRadius = 1.8;
        float orbitAngle = homeAngle + t * (0.2 + phase * 0.15) * activity;
        float orbitRadius = homeRadius + sin(phase * 3.14 + t * 0.3 * activity) * 0.5 * activity;
        float homeY = sin(phase * 3.14) * 0.3;
        float activeY = sin(phase * 6.28 + t * 0.5 * activity) * 0.8 * activity;
        float secondaryY = sin(t * 0.7 * activity + phase * 4.0) * 0.3 * activity;

        float angle = mix(homeAngle, orbitAngle, activity);
        float radius = mix(homeRadius, orbitRadius, activity);
        float yPos = mix(homeY, activeY + secondaryY, activity);

        vec3 pos = vec3(cos(angle) * radius, yPos, sin(angle) * radius);
        pos *= 1.0 + audio * 0.4;

        vBrightness = aBrightness * mix(0.05, 1.0, activity);
        vAlpha = mix(0.03, 0.3, activity) + sin(t * 2.0 * activity + phase * 6.28) * 0.2 * activity;

        vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = aSize * (300.0 / -mvPos.z) * mix(0.15, 1.3, activity);
        gl_Position = projectionMatrix * mvPos;
    }
`;

const PARTICLE_FRAG = /* glsl */ `
    precision highp float;
    uniform vec3 uDeep;
    uniform vec3 uBright;
    varying float vBrightness;
    varying float vAlpha;
    void main() {
        vec2 center = gl_PointCoord - vec2(0.5);
        float dist = length(center);
        if (dist > 0.5) discard;
        float alpha = smoothstep(0.5, 0.1, dist) * vAlpha;
        vec3 color = mix(uDeep, uBright, vBrightness);
        gl_FragColor = vec4(color, alpha * 0.6);
    }
`;

// ============================================================
// Background — radial gradient + grain, palette-driven
// ============================================================
const BG_VERT = /* glsl */ `
    attribute vec2 position;
    attribute vec2 uv;
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = vec4(position, 0.0, 1.0);
    }
`;

const BG_FRAG = /* glsl */ `
    precision highp float;
    uniform float uTime;
    uniform float uAudio;
    uniform vec3 uInner;
    uniform vec3 uOuter;
    uniform vec3 uHalo;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
        vec2 center = vUv - 0.5;
        float dist = length(center);
        float audio = uAudio;
        float activity = audio * audio;
        float vignette = smoothstep(0.8, 0.1, dist);
        vec3 bgColor = mix(uOuter, uInner, vignette * mix(0.15, 0.8, activity));
        float grainSpeed = mix(1.0, 10.0, activity);
        float grain = hash(vUv * 500.0 + uTime * grainSpeed) * mix(0.01, 0.04, activity);
        bgColor += vec3(grain * 0.5, grain * 0.4, grain * 0.2);
        float halo = exp(-dist * dist * 8.0) * mix(0.02, 0.12, activity);
        bgColor += uHalo * halo;
        gl_FragColor = vec4(bgColor, 1.0);
    }
`;

// ============================================================
// Geometry helpers
// ============================================================
class ParticleGeometry {
    static create(gl: OGLRenderingContext, count: number) {
        const positions = new Float32Array(count * 3);
        const sizes = new Float32Array(count);
        const phases = new Float32Array(count);
        const brightness = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            const r = 1.5 + Math.random() * 0.5;
            positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
            positions[i * 3 + 2] = r * Math.cos(phi);
            sizes[i] = 1.0 + Math.random() * 3.0;
            phases[i] = Math.random();
            brightness[i] = 0.3 + Math.random() * 0.7;
        }
        return new Geometry(gl, {
            position: { size: 3, data: positions },
            aSize: { size: 1, data: sizes },
            aPhase: { size: 1, data: phases },
            aBrightness: { size: 1, data: brightness },
        });
    }
}

// Build edge indices for wireframe rendering from a triangle-indexed sphere.
// Returns a Geometry that draws as gl.LINES using the same position/normal data.
class WireframeSphereGeometry {
    static create(gl: OGLRenderingContext, widthSegments = 28, heightSegments = 18) {
        const src = new Sphere(gl, { radius: 1, widthSegments, heightSegments });
        const posData = (src.attributes as Record<string, { data: Float32Array }>).position.data;
        const normData = (src.attributes as Record<string, { data: Float32Array }>).normal.data;
        const uvData   = (src.attributes as Record<string, { data: Float32Array }>).uv.data;
        const triIdx   = (src.attributes as Record<string, { data: Uint16Array | Uint32Array }>).index.data;

        // Deduplicate edges using sorted (a,b) pairs
        const seen = new Set<number>();
        const lineIdx: number[] = [];
        const pushEdge = (a: number, b: number) => {
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            const key = lo * 0x10000 + hi;
            if (seen.has(key)) return;
            seen.add(key);
            lineIdx.push(a, b);
        };
        for (let i = 0; i < triIdx.length; i += 3) {
            const a = triIdx[i], b = triIdx[i + 1], c = triIdx[i + 2];
            pushEdge(a, b);
            pushEdge(b, c);
            pushEdge(c, a);
        }

        const useUint32 = posData.length / 3 > 65536;
        const indexArr = useUint32 ? new Uint32Array(lineIdx) : new Uint16Array(lineIdx);

        return new Geometry(gl, {
            position: { size: 3, data: posData },
            normal:   { size: 3, data: normData },
            uv:       { size: 2, data: uvData },
            index:    { data: indexArr },
        });
    }
}

class FullscreenQuadGeometry {
    static create(gl: OGLRenderingContext) {
        return new Geometry(gl, {
            position: { size: 2, data: new Float32Array([-1,-1, 1,-1, -1,1, 1,1]) },
            uv: { size: 2, data: new Float32Array([0,0, 1,0, 0,1, 1,1]) },
            index: { data: new Uint16Array([0,1,2, 2,1,3]) },
        });
    }
}

// ============================================================
// VoiceBlob — Premium Export
// ============================================================

export interface VoiceBlobOptions {
    style?: BlobStyle;
    // Hex strings ("#rrggbb"); tint the blob toward this color when the
    // corresponding audio lane (user mic / agent TTS) is dominant.
    userColor?: string;
    agentColor?: string;
    // HUD-only: when true, the user/agent color slots follow the active
    // appearance theme on every theme change (re-derived in
    // refreshThemePalette). Off by default so the regular terminal view
    // (voice-chat) keeps the user's picked blob colors — a theme mutation
    // must NOT wipe a color the user chose in the picker.
    themeFollowSlots?: boolean;
}

// Parse "#rrggbb" or "#rgb" → [r, g, b] in 0..1. Returns fallback on invalid.
function hexToRgb01(hex: string, fallback: [number, number, number]): [number, number, number] {
    if (!hex) return fallback;
    let s = hex.trim().replace(/^#/, '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    if (s.length !== 6) return fallback;
    const n = parseInt(s, 16);
    if (Number.isNaN(n)) return fallback;
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

// Parse a CSS color string into [r, g, b] in 0..1. Handles "#rgb" / "#rrggbb"
// and "rgb(r, g, b)" / "rgba(r, g, b, a)". hsl/oklch/color-mix forms are not
// parsed here — the caller falls through to the next fallback in the chain.
function parseCssColor(s: string): [number, number, number] | null {
    const t = s.trim();
    if (!t) return null;
    if (t.startsWith('#')) {
        let hex = t.slice(1);
        if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
        if (hex.length !== 6) return null;
        const n = parseInt(hex, 16);
        if (Number.isNaN(n)) return null;
        return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
    }
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(t);
    if (m) {
        return [
            Math.max(0, Math.min(1, parseFloat(m[1]) / 255)),
            Math.max(0, Math.min(1, parseFloat(m[2]) / 255)),
            Math.max(0, Math.min(1, parseFloat(m[3]) / 255)),
        ];
    }
    return null;
}

// Read the first CSS custom property in `varNames` that resolves to a
// parseable color. Falls back to `fallback` when nothing matches.
function readThemeRgb(varNames: string[], fallback: [number, number, number]): [number, number, number] {
    if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return fallback;
    const cs = getComputedStyle(document.documentElement);
    for (const name of varNames) {
        const raw = cs.getPropertyValue(name);
        if (!raw) continue;
        const parsed = parseCssColor(raw);
        if (parsed) return parsed;
    }
    return fallback;
}

// Map the blob's semantic slots (cool/hot/proc) onto whatever the active
// theme exposes. Fallback chain per slot:
//   --g-blob-<slot>  (explicit blob token — not emitted today, here for
//                     future per-blob customization without code change)
//   --g-<closest>    (existing master theme tokens shared with the rest
//                     of the app)
//   hardcoded constant from WIREFRAME_PALETTE.
function readThemePalette(): {
    cool: [number, number, number];
    hot:  [number, number, number];
    proc: [number, number, number];
} {
    return {
        cool: readThemeRgb(['--g-blob-cool', '--g-primary', '--c-accent'], WIREFRAME_PALETTE.cool),
        hot:  readThemeRgb(['--g-blob-hot',  '--g-accent'],                WIREFRAME_PALETTE.hot),
        proc: readThemeRgb(['--g-blob-proc', '--g-fg-dim'],                WIREFRAME_PALETTE.proc),
    };
}

function rgbToHex01(rgb: [number, number, number]): string {
    const c = (x: number) =>
        Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, '0');
    return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

/**
 * Theme-derived defaults for the blob's user/agent/proc color slots.
 * Exposed for host components (voice-chat) so the color picker's defaults
 * and Reset button track the active --g-* theme tokens instead of carrying
 * a stale hardcoded cyan/amber/blue forever. Reads the DOM on each call —
 * cheap because callers invoke it rarely (hydrate, reset, theme change).
 */
export function getThemeBlobDefaults(): { user: string; agent: string; proc: string } {
    const p = readThemePalette();
    return {
        user:  rgbToHex01(p.cool),
        agent: rgbToHex01(p.hot),
        proc:  rgbToHex01(p.proc),
    };
}

export class VoiceBlob {
    private renderer: Renderer;
    private gl: OGLRenderingContext;
    private scene: Transform;
    private camera: Camera;
    private blobMesh: Mesh;
    private blobProgram!: Program;
    private particleMesh: Mesh | null = null;
    private particleProgram: Program | null = null;
    private container: HTMLElement;
    private smoothVolume = 0;
    private targetVolume = 0;
    private smoothUser = 0;
    private smoothAgent = 0;
    private state: BlobState = 'idle';
    private style: BlobStyle;
    private mouseX = 0;
    private mouseY = 0;
    private mouseTargetX = 0;
    private mouseTargetY = 0;
    private resizeObserver: ResizeObserver | null = null;
    private intersectionObserver: IntersectionObserver | null = null;
    private visible = true;
    // 'full' = render every frame; 'reduced' = render every other frame
    // (~30fps); 'paused' = skip render entirely. The voice-chat host flips
    // between these based on window focus so non-focused tabs stop burning
    // GPU on a HUD nobody is looking at.
    private intensity: 'full' | 'reduced' | 'paused' = 'full';
    private frameToggle = 0;
    private mouseHandler: (e: MouseEvent) => void;
    private userRgb: [number, number, number];
    private agentRgb: [number, number, number];
    // "Processing" tint — kept as a separate slot because the shader uses it
    // when uState ≥ 3 regardless of who's speaking. It has no picker today;
    // it follows the theme via readThemePalette() and is re-derived on
    // theme change by refreshThemePalette().
    private procRgb: [number, number, number];
    private themeObserver: MutationObserver | null = null;
    private themeRefreshScheduled = false;
    // HUD-only opt-in: follow the active theme for the user/agent slots on
    // theme change. Terminal view leaves this false so picked colors stick.
    private themeFollowSlots: boolean;

    constructor(container: HTMLElement, opts: VoiceBlobOptions = {}) {
        this.container = container;
        this.style = opts.style ?? 'audio-wireframe';
        this.themeFollowSlots = opts.themeFollowSlots ?? false;
        const themePalette = readThemePalette();
        this.userRgb = hexToRgb01(opts.userColor ?? '', themePalette.cool);
        this.agentRgb = hexToRgb01(opts.agentColor ?? '', themePalette.hot);
        this.procRgb = themePalette.proc;

        // DPR clamped to 1.0. On a soft, glow-heavy blob the eye doesn't
        // resolve the difference between 1.0 and 1.5, but 1.0 cuts fragment
        // shader cost by ~2.25× — essential when the OS is running 5
        // instances across 5 monitors. Bump back to 1.25 if a high-DPI
        // user complains about pixelation.
        this.renderer = new Renderer({
            alpha: true,
            antialias: true,
            dpr: 1.0,
            powerPreference: 'high-performance',
        });

        this.gl = this.renderer.gl;
        this.gl.clearColor(0, 0, 0, 0);
        const canvas = this.gl.canvas as HTMLCanvasElement;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        this.container.appendChild(canvas);

        this.scene = new Transform();
        this.camera = new Camera(this.gl, { fov: 45 });
        this.camera.position.set(0, 0, 4.5);

        this.blobMesh = this.createBlobMesh(this.style);
        this.blobMesh.setParent(this.scene);
        this.createParticles();
        // Background mesh was created but never rendered (the canvas is
        // alpha:true and the host page paints the BG). Removed entirely
        // — saves a Program + Geometry + per-frame uniform updates.
        this.applyStylePalette(this.style);
        this.pushColorUniforms();

        // mousemove fires too often to do layout work per event; just store
        // the target and let the rAF tick smooth it (saves getBoundingClientRect
        // calls on every pointer sample).
        this.mouseHandler = (e: MouseEvent) => {
            const rect = this.container.getBoundingClientRect();
            this.mouseTargetX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouseTargetY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        };
        this.container.addEventListener('mousemove', this.mouseHandler, { passive: true });

        // ResizeObserver on the container catches sidebar drag + parent
        // resize without the window-resize listener (which misses internal
        // layout changes).
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.resize());
            this.resizeObserver.observe(this.container);
        }

        // Pause render loop when the canvas is off-screen (different tab,
        // scrolled away). RAF already pauses on hidden tabs, but this also
        // covers in-app navigation where the canvas is display:none'd.
        if (typeof IntersectionObserver !== 'undefined') {
            this.intersectionObserver = new IntersectionObserver((entries) => {
                this.visible = entries.some((e) => e.isIntersecting);
            }, { threshold: 0 });
            this.intersectionObserver.observe(canvas);
        }

        // Live theme tracking: the appearance system writes inline
        // styles + data-theme on <html> (no themechange event is
        // dispatched), so observe those attributes. Coalesce bursts of
        // mutations through an rAF so back-to-back token writes only
        // trigger one re-derive + uniform push.
        if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
            this.themeObserver = new MutationObserver(() => {
                if (this.themeRefreshScheduled) return;
                this.themeRefreshScheduled = true;
                requestAnimationFrame(() => {
                    this.themeRefreshScheduled = false;
                    this.refreshThemePalette();
                });
            });
            this.themeObserver.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['style', 'data-theme', 'data-theme-mode', 'class'],
            });
        }
        // First-frame refresh: at construction time the <html> may not yet
        // have the active palette inlined (firstUpdated fires before the
        // appearance controller's microtasks settle). Reading once more on
        // the next frame covers that race without waiting on a mutation.
        if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(() => this.refreshThemePalette());
        }

        this.resize();
    }

    isVisible(): boolean { return this.visible; }

    /**
     * Coarse render throttle for multi-instance scenarios:
     *   'full'    — render every frame (default)
     *   'reduced' — render every other frame (~30fps; still smooth)
     *   'paused'  — skip render entirely (uniform updates still flow if
     *               the host calls update(), but no GL draw is issued)
     * The host (voice-chat) sets this based on window focus so the
     * non-focused tabs on other monitors stop saturating the GPU.
     */
    setIntensity(level: 'full' | 'reduced' | 'paused') {
        this.intensity = level;
    }

    private createBlobMesh(style: BlobStyle): Mesh {
        if (isLinesStyle(style)) {
            // 36×24 = 864 verts, ~2.5k unique edges. Still trivially cheap on
            // the GPU but the denser silhouette makes individual frame drops
            // far less perceptible — the line drawing was the most jitter-
            // sensitive style because 1px edges show every missed frame.
            const geometry = WireframeSphereGeometry.create(this.gl, 36, 24);
            this.blobProgram = new Program(this.gl, {
                vertex: WF_VERTEX,
                fragment: WF_FRAGMENT,
                uniforms: {
                    uTime:  { value: 0 },
                    uBass:  { value: 0 },
                    uTreble: { value: 0 },
                    uState: { value: 0 },
                    uDisplacementScale: { value: STYLE_PALETTES[style].displacementScale },
                    uColorCool: { value: WIREFRAME_PALETTE.cool as unknown as number[] },
                    uColorHot:  { value: WIREFRAME_PALETTE.hot  as unknown as number[] },
                    uColorProc: { value: WIREFRAME_PALETTE.proc as unknown as number[] },
                },
                transparent: true,
                depthTest: false,
                depthWrite: false,
                cullFace: null as unknown as number,
            });
            this.blobProgram.setBlendFunc(this.gl.SRC_ALPHA, this.gl.ONE);
            return new Mesh(this.gl, {
                mode: this.gl.LINES,
                geometry,
                program: this.blobProgram,
            });
        }
        if (isPointsStyle(style)) {
            // Lower-res sphere so each vertex becomes one visible dot.
            // 64×42 ≈ 2.7k dots — still reads as a packed sphere of points
            // and shaves a quarter of the vertex-shader cost vs the previous
            // 72×48 grid.
            const geometry = new Sphere(this.gl, {
                radius: 1,
                widthSegments: 64,
                heightSegments: 42,
            });
            this.blobProgram = new Program(this.gl, {
                vertex: DOT_VERTEX,
                fragment: DOT_FRAGMENT,
                uniforms: {
                    uTime: { value: 0 },
                    uAudio: { value: 0 },
                    uState: { value: 0 },
                    uDisplacementScale: { value: STYLE_PALETTES[style].displacementScale },
                    uPointBaseSize: { value: DOT_PALETTE.pointBaseSize },
                    uCoolColor: { value: DOT_PALETTE.cool as unknown as number[] },
                    uHotColor:  { value: DOT_PALETTE.hot  as unknown as number[] },
                    uProcColor: { value: DOT_PALETTE.proc as unknown as number[] },
                    uCoreColor: { value: DOT_PALETTE.core as unknown as number[] },
                },
                transparent: true,
                depthTest: false,    // dots should not occlude each other
                depthWrite: false,
                cullFace: null as unknown as number,
            });
            // Additive blending so overlapping dots build up to a brighter glow
            this.blobProgram.setBlendFunc(this.gl.SRC_ALPHA, this.gl.ONE);
            return new Mesh(this.gl, {
                mode: this.gl.POINTS,
                geometry,
                program: this.blobProgram,
            });
        }

        // 96×64 ≈ 6.1k verts vs 128×128 = 16.4k. Each vertex runs a
        // 4-octave 3D simplex FBM, so the vertex-shader budget here is the
        // dominant cost — cutting verts ~2.7× scales linearly. Visually the
        // blob still reads as a smooth high-poly sphere because we're
        // re-tessellating with displacement and shading per-fragment.
        const geometry = new Sphere(this.gl, {
            radius: 1,
            widthSegments: 96,
            heightSegments: 64,
        });

        this.blobProgram = new Program(this.gl, {
            vertex: VERTEX_SHADER,
            fragment: FRAGMENT_SHADERS[style],
            uniforms: {
                uTime: { value: 0 },
                uAudio: { value: 0 },
                uState: { value: 0 },
                uDisplacementScale: { value: STYLE_PALETTES[style].displacementScale },
            },
            transparent: false,
            cullFace: this.gl.BACK,
            depthTest: true,
        });

        return new Mesh(this.gl, { geometry, program: this.blobProgram });
    }

    private createParticles() {
        try {
            const PARTICLE_COUNT = 120;
            const geometry = ParticleGeometry.create(this.gl, PARTICLE_COUNT);
            const palette = STYLE_PALETTES[this.style];
            this.particleProgram = new Program(this.gl, {
                vertex: PARTICLE_VERT,
                fragment: PARTICLE_FRAG,
                uniforms: {
                    uTime: { value: 0 },
                    uAudio: { value: 0 },
                    uDeep:   { value: palette.particleDeep },
                    uBright: { value: palette.particleBright },
                },
                transparent: true,
                depthWrite: false,
            });
            this.particleMesh = new Mesh(this.gl, {
                mode: this.gl.POINTS,
                geometry,
                program: this.particleProgram,
            });
            this.particleMesh.setParent(this.scene);
        } catch (e) {
            console.warn('VoiceBlob: particles failed', e);
        }
    }

    private applyStylePalette(style: BlobStyle) {
        const palette = STYLE_PALETTES[style];
        if (this.particleProgram) {
            (this.particleProgram.uniforms.uDeep.value as number[])   = palette.particleDeep as unknown as number[];
            (this.particleProgram.uniforms.uBright.value as number[]) = palette.particleBright as unknown as number[];
        }
        if (this.blobProgram) {
            this.blobProgram.uniforms.uDisplacementScale.value = palette.displacementScale;
        }
    }

    setStyle(style: BlobStyle) {
        if (style === this.style) return;
        const prevSpecial = isPointsStyle(this.style) || isLinesStyle(this.style);
        const nextSpecial = isPointsStyle(style) || isLinesStyle(style);
        // Whenever the rendering mode changes (TRIANGLES <-> POINTS/LINES) or
        // we move between two different "special" modes we must rebuild the
        // mesh entirely since each one uses different geometry and shaders.
        const needsRebuild = (this.style !== style) && (prevSpecial || nextSpecial);
        this.style = style;
        if (needsRebuild) {
            this.blobMesh.setParent(null);
            this.blobMesh = this.createBlobMesh(style);
            this.blobMesh.setParent(this.scene);
        } else {
            // Solid-to-solid: just recompile the fragment shader
            const palette = STYLE_PALETTES[style];
            this.blobProgram = new Program(this.gl, {
                vertex: VERTEX_SHADER,
                fragment: FRAGMENT_SHADERS[style],
                uniforms: {
                    uTime: { value: this.blobProgram?.uniforms.uTime.value ?? 0 },
                    uAudio: { value: this.blobProgram?.uniforms.uAudio.value ?? 0 },
                    uState: { value: this.blobProgram?.uniforms.uState.value ?? 0 },
                    uDisplacementScale: { value: palette.displacementScale },
                },
                transparent: false,
                cullFace: this.gl.BACK,
                depthTest: true,
            });
            this.blobMesh.program = this.blobProgram;
        }
        this.applyStylePalette(style);
        this.pushColorUniforms();
    }

    getStyle(): BlobStyle { return this.style; }

    setState(state: BlobState) { this.state = state; }

    setColors(userHex: string, agentHex: string) {
        this.userRgb = hexToRgb01(userHex, this.userRgb);
        this.agentRgb = hexToRgb01(agentHex, this.agentRgb);
        // Push immediately so on-screen pickers feel instant rather than
        // waiting for the next dominant-source switch in the tick.
        this.pushColorUniforms();
    }

    private pushColorUniforms() {
        const p = this.blobProgram;
        if (!p) return;
        if (p.uniforms.uUserColor)  (p.uniforms.uUserColor.value  as number[]) = this.userRgb as unknown as number[];
        if (p.uniforms.uAgentColor) (p.uniforms.uAgentColor.value as number[]) = this.agentRgb as unknown as number[];
        // Dot-matrix and wireframe have legacy hot/cool slots; keep them in
        // sync so the chosen colors apply even when uUser/uAgentColor isn't
        // referenced by that style.
        if (p.uniforms.uCoolColor)  (p.uniforms.uCoolColor.value  as number[]) = this.userRgb as unknown as number[];
        if (p.uniforms.uHotColor)   (p.uniforms.uHotColor.value   as number[]) = this.agentRgb as unknown as number[];
        if (p.uniforms.uColorCool)  (p.uniforms.uColorCool.value  as number[]) = this.userRgb as unknown as number[];
        if (p.uniforms.uColorHot)   (p.uniforms.uColorHot.value   as number[]) = this.agentRgb as unknown as number[];
        // Processing tint: theme-derived, NOT overwritten by the per-frame
        // update() crossfade (which only touches cool/hot). Without this
        // push the proc uniform stayed at its hardcoded shader-init value
        // forever — that's the "standard blue every time" the user sees
        // while the assistant is thinking.
        if (p.uniforms.uColorProc) (p.uniforms.uColorProc.value as number[]) = this.procRgb as unknown as number[];
        if (p.uniforms.uProcColor) (p.uniforms.uProcColor.value as number[]) = this.procRgb as unknown as number[];
    }

    /**
     * Re-read the active theme tokens and push them to the GPU. Called by
     * the MutationObserver on `<html>` whenever its style/data-theme/class
     * attributes change (theme picker / appearance overrides / mode swap).
     * Only proc is re-derived here by default — user/agent stay under host
     * control so the user's saved color picks aren't stomped by a theme
     * change. The host's Reset button is the path that refreshes user/agent
     * from theme. The HUD opts into live theme-following for the user/agent
     * slots via `themeFollowSlots` (it has no per-slot picker); the regular
     * terminal view leaves it off so picked colors survive theme mutations.
     */
    refreshThemePalette() {
        const p = readThemePalette();
        this.procRgb = p.proc;
        if (this.themeFollowSlots) {
            // HUD only: follow the active appearance theme for user/agent.
            // The host's picker still wins for the session via setColors().
            this.userRgb = p.cool;
            // HUD agent lane tracks the theme primary (scoped here, not in the
            // shared readThemePalette default which the terminal also reads).
            this.agentRgb = readThemeRgb(['--g-blob-hot', '--g-primary'], p.hot);
        }
        this.pushColorUniforms();
    }

    resize() {
        const { clientWidth, clientHeight } = this.container;
        if (clientWidth === 0 || clientHeight === 0) return;
        this.renderer.setSize(clientWidth, clientHeight);
        this.camera.perspective({ aspect: clientWidth / clientHeight });
    }

    private smoothBass = 0;
    private smoothTreble = 0;

    update(volume: number, time: number, bass?: number, treble?: number, userAudio?: number, agentAudio?: number) {
        // Bail out cheap when the canvas is off-screen: the rAF caller is
        // still running but we skip the GL draw + uniform writes. CPU side
        // we also skip the smoothing math; on re-entry it picks back up.
        if (!this.visible) return;

        const t = time * 0.001;
        this.targetVolume = volume;
        const attack = 0.18;
        const decay = 0.08;
        if (this.targetVolume > this.smoothVolume) {
            this.smoothVolume += (this.targetVolume - this.smoothVolume) * attack;
        } else {
            this.smoothVolume += (this.targetVolume - this.smoothVolume) * decay;
        }
        if (this.smoothVolume < 0.01) this.smoothVolume = 0;
        const v = this.smoothVolume;

        // Smoothed mouse — moved off the event listener so we skip a
        // getBoundingClientRect on every move event and still get the
        // same parallax feel via per-frame lerp.
        this.mouseX += (this.mouseTargetX - this.mouseX) * 0.1;
        this.mouseY += (this.mouseTargetY - this.mouseY) * 0.1;

        // Derive bass/treble: prefer explicit values when provided, else synthesize from volume
        const tgtBass = bass ?? v;
        const tgtTreble = treble ?? Math.pow(v, 1.4);
        this.smoothBass   += (tgtBass   - this.smoothBass)   * (tgtBass   > this.smoothBass   ? attack : decay);
        this.smoothTreble += (tgtTreble - this.smoothTreble) * (tgtTreble > this.smoothTreble ? attack : decay);

        // Smooth user/agent lanes independently so color crossfades feel
        // natural even when the raw levels jitter frame-to-frame.
        const tgtUser  = userAudio  ?? 0;
        const tgtAgent = agentAudio ?? 0;
        this.smoothUser  += (tgtUser  - this.smoothUser)  * (tgtUser  > this.smoothUser  ? attack : decay);
        this.smoothAgent += (tgtAgent - this.smoothAgent) * (tgtAgent > this.smoothAgent ? attack : decay);
        // Lane mix: 0 = fully user color, 1 = fully agent color.
        let laneMix: number;
        const sum = this.smoothUser + this.smoothAgent;
        if (sum < 1e-3) laneMix = this.state === 'speaking' ? 1 : 0;
        else laneMix = this.smoothAgent / sum;

        const stateNum = this.state === 'idle' ? 0
            : this.state === 'listening' ? 1
            : this.state === 'speaking' ? 2
            : 3;

        this.blobProgram.uniforms.uTime.value = t;
        if (this.blobProgram.uniforms.uAudio)  this.blobProgram.uniforms.uAudio.value  = v;
        if (this.blobProgram.uniforms.uBass)   this.blobProgram.uniforms.uBass.value   = this.smoothBass;
        if (this.blobProgram.uniforms.uTreble) this.blobProgram.uniforms.uTreble.value = this.smoothTreble;
        if (this.blobProgram.uniforms.uUserAudio)  this.blobProgram.uniforms.uUserAudio.value  = this.smoothUser;
        if (this.blobProgram.uniforms.uAgentAudio) this.blobProgram.uniforms.uAgentAudio.value = this.smoothAgent;
        if (this.blobProgram.uniforms.uLaneMix)    this.blobProgram.uniforms.uLaneMix.value    = laneMix;
        this.blobProgram.uniforms.uState.value = stateNum;
        // Live palette swap based on dominant lane. The shader's "hot"
        // accent crossfades between user/agent colors; the "cool" base
        // sits at a muted blend so the blob never looks fully off-color
        // at idle. Doing this in JS keeps the shaders agnostic.
        const aR = this.agentRgb[0], aG = this.agentRgb[1], aB = this.agentRgb[2];
        const uR = this.userRgb[0],  uG = this.userRgb[1],  uB = this.userRgb[2];
        const hotR = uR * (1 - laneMix) + aR * laneMix;
        const hotG = uG * (1 - laneMix) + aG * laneMix;
        const hotB = uB * (1 - laneMix) + aB * laneMix;
        const idleR = (uR + aR) * 0.28;
        const idleG = (uG + aG) * 0.28;
        const idleB = (uB + aB) * 0.28;
        if (this.blobProgram.uniforms.uHotColor)   (this.blobProgram.uniforms.uHotColor.value   as number[]) = [hotR, hotG, hotB];
        if (this.blobProgram.uniforms.uCoolColor)  (this.blobProgram.uniforms.uCoolColor.value  as number[]) = [idleR, idleG, idleB];
        if (this.blobProgram.uniforms.uColorHot)   (this.blobProgram.uniforms.uColorHot.value   as number[]) = [hotR, hotG, hotB];
        if (this.blobProgram.uniforms.uColorCool)  (this.blobProgram.uniforms.uColorCool.value  as number[]) = [idleR, idleG, idleB];
        if (this.blobProgram.uniforms.uTintColor)  (this.blobProgram.uniforms.uTintColor.value  as number[]) = [hotR, hotG, hotB];

        const vActivity = v * v * v * v;
        const rotSpeed = vActivity * 0.01;
        this.blobMesh.rotation.y += rotSpeed;
        this.blobMesh.rotation.x += rotSpeed * 0.4;
        if (vActivity > 0.001) {
            this.blobMesh.rotation.z += (this.mouseX * 0.02 - this.blobMesh.rotation.z) * vActivity * 0.05;
        } else {
            this.blobMesh.rotation.z *= 0.98;
        }

        if (this.particleProgram) {
            this.particleProgram.uniforms.uTime.value = t;
            this.particleProgram.uniforms.uAudio.value = v;
        }

        // Intensity gate: 'paused' skips the GL draw entirely (uniforms
        // and smoothing are still updated above, so we resume mid-stream
        // without a visual snap when the user refocuses); 'reduced'
        // renders every other frame for ~30fps on non-focused tabs.
        if (this.intensity === 'paused') return;
        if (this.intensity === 'reduced') {
            this.frameToggle ^= 1;
            if (this.frameToggle) return;
        }

        // OGL's renderer.render() already issues gl.clear() based on the
        // renderer's clear flags. The redundant gl.clear() we used to do
        // here just doubled the work — dropped.
        this.renderer.render({ scene: this.scene, camera: this.camera });
    }

    dispose() {
        if (this.resizeObserver) {
            try { this.resizeObserver.disconnect(); } catch { /* noop */ }
            this.resizeObserver = null;
        }
        if (this.intersectionObserver) {
            try { this.intersectionObserver.disconnect(); } catch { /* noop */ }
            this.intersectionObserver = null;
        }
        if (this.themeObserver) {
            try { this.themeObserver.disconnect(); } catch { /* noop */ }
            this.themeObserver = null;
        }
        this.container.removeEventListener('mousemove', this.mouseHandler);
        const canvas = this.gl.canvas as HTMLCanvasElement;
        if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
        // Drop the GL context so the driver can reclaim VRAM immediately
        // instead of waiting for the canvas to be GC'd.
        const lose = this.gl.getExtension('WEBGL_lose_context');
        if (lose) {
            try { lose.loseContext(); } catch { /* noop */ }
        }
    }
}
