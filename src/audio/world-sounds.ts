/**
 * world-sounds — vanilla WebAudio synth engine for the Agency World map.
 *
 * Zero dependencies, zero asset files: every sound is synthesised at runtime
 * with oscillators + filtered noise, so it ships without bundling audio blobs.
 * If you'd rather drop in real CC0 SFX, the file paths the engine *would* use
 * are exported as {@link WORLD_SOUND_ASSETS} — wire them via `loadAssets()`.
 *
 * The module is browser-only but safe to import from any bundle: it never
 * touches `window`/`AudioContext` until {@link WorldSounds.unlock} (called from
 * a user gesture, per autoplay policy). Until then it stays inert and muted.
 *
 * Consumed by the `<world-audio>` Lit element, which maps agency-world
 * `WorldEvent.kind`s onto these categories.
 */

export type WorldSoundCategory =
  | "ambient"
  | "complete"
  | "beam"
  | "error"
  | "spawn"
  | "achievement";

export const WORLD_SOUND_CATEGORIES: WorldSoundCategory[] = [
  "ambient",
  "complete",
  "beam",
  "error",
  "spawn",
  "achievement",
];

export const WORLD_SOUND_LABELS: Record<WorldSoundCategory, string> = {
  ambient: "Ambient hum",
  complete: "Task complete",
  beam: "Federation beam",
  error: "Error chime",
  spawn: "Agent spawn",
  achievement: "Achievement",
};

/**
 * Optional CC0 asset fallbacks. NOT shipped by default — the engine synthesises
 * everything. Drop matching files here and call `loadAssets()` to use samples.
 */
export const WORLD_SOUND_ASSETS: Record<WorldSoundCategory, string> = {
  ambient: "/assets/audio/world/ambient-hum.ogg",
  complete: "/assets/audio/world/complete.ogg",
  beam: "/assets/audio/world/beam.ogg",
  error: "/assets/audio/world/error.ogg",
  spawn: "/assets/audio/world/spawn.ogg",
  achievement: "/assets/audio/world/achievement.ogg",
};

export interface WorldSoundsSettings {
  /** Muted until the first user gesture (autoplay policy). */
  muted: boolean;
  /** Master volume, 0..1. */
  masterVolume: number;
  /** Per-category enable flags. */
  enabled: Record<WorldSoundCategory, boolean>;
}

const STORAGE_KEY = "infinibot-world-audio";

function defaultSettings(): WorldSoundsSettings {
  return {
    muted: true,
    masterVolume: 0.6,
    enabled: {
      ambient: true,
      complete: true,
      beam: true,
      error: true,
      spawn: true,
      achievement: true,
    },
  };
}

function loadSettings(): WorldSoundsSettings {
  const base = defaultSettings();
  if (typeof localStorage === "undefined") return base;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<WorldSoundsSettings>;
    return {
      muted: typeof parsed.muted === "boolean" ? parsed.muted : base.muted,
      masterVolume:
        typeof parsed.masterVolume === "number"
          ? Math.max(0, Math.min(1, parsed.masterVolume))
          : base.masterVolume,
      enabled: { ...base.enabled, ...parsed.enabled },
    };
  } catch {
    return base;
  }
}

type Ctor = typeof AudioContext;

export class WorldSounds {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambient: { stop: () => void } | null = null;
  private buffers: Partial<Record<WorldSoundCategory, AudioBuffer>> = {};
  private noiseBuffer: AudioBuffer | null = null;
  private settings: WorldSoundsSettings = loadSettings();
  private listeners = new Set<(s: WorldSoundsSettings) => void>();

  // ── settings ────────────────────────────────────────────────────────────

  getSettings(): WorldSoundsSettings {
    return {
      muted: this.settings.muted,
      masterVolume: this.settings.masterVolume,
      enabled: { ...this.settings.enabled },
    };
  }

  onChange(fn: (s: WorldSoundsSettings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private persist(): void {
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
      } catch {
        /* private mode / quota — non-fatal */
      }
    }
    const snap = this.getSettings();
    for (const fn of this.listeners) fn(snap);
  }

  setMuted(muted: boolean): void {
    this.settings.muted = muted;
    this.applyMasterGain();
    if (muted) this.stopAmbient();
    else if (this.settings.enabled.ambient) this.startAmbient();
    this.persist();
  }

  setMasterVolume(v: number): void {
    this.settings.masterVolume = Math.max(0, Math.min(1, v));
    this.applyMasterGain();
    this.persist();
  }

  setCategoryEnabled(cat: WorldSoundCategory, on: boolean): void {
    this.settings.enabled[cat] = on;
    if (cat === "ambient") {
      if (on && !this.settings.muted) this.startAmbient();
      else this.stopAmbient();
    }
    this.persist();
  }

  isMuted(): boolean {
    return this.settings.muted;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Resume / create the AudioContext. MUST be called from a user gesture. */
  async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    if (!this.settings.muted && this.settings.enabled.ambient) this.startAmbient();
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === "undefined") return null;
    const Ctx: Ctor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
    if (!Ctx) return null;
    try {
      this.ctx = new Ctx();
    } catch {
      return null;
    }
    this.master = this.ctx.createGain();
    this.applyMasterGain();
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  private applyMasterGain(): void {
    if (!this.master || !this.ctx) return;
    const target = this.settings.muted ? 0 : this.settings.masterVolume;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(target, t, 0.05);
  }

  destroy(): void {
    this.stopAmbient();
    this.listeners.clear();
    if (this.ctx) {
      try {
        void this.ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.ctx = null;
    this.master = null;
  }

  // ── playback ──────────────────────────────────────────────────────────────

  /** Play a one-shot event sound. No-op if muted / disabled / locked. */
  play(cat: Exclude<WorldSoundCategory, "ambient">): void {
    if (this.settings.muted || !this.settings.enabled[cat]) return;
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || ctx.state !== "running") return;

    // Sample override wins if loaded.
    const buf = this.buffers[cat];
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(master);
      src.start();
      return;
    }

    switch (cat) {
      case "complete":
        this.synthComplete(ctx, master);
        break;
      case "beam":
        this.synthBeam(ctx, master);
        break;
      case "error":
        this.synthError(ctx, master);
        break;
      case "spawn":
        this.synthSpawn(ctx, master);
        break;
      case "achievement":
        this.synthAchievement(ctx, master);
        break;
    }
  }

  // ── ambient drone ──────────────────────────────────────────────────────────

  startAmbient(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;
    if (this.settings.muted || !this.settings.enabled.ambient) return;
    if (this.ambient) return;
    if (ctx.state !== "running") return; // wait for unlock()

    const bus = ctx.createGain();
    bus.gain.value = 0.0;
    bus.gain.setTargetAtTime(0.16, ctx.currentTime, 1.5); // gentle fade-in
    bus.connect(this.master);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    lp.Q.value = 0.6;
    lp.connect(bus);

    const oscs: OscillatorNode[] = [];
    for (const [freq, detune, type] of [
      [55, -4, "sine"],
      [55, +5, "triangle"],
      [110, +2, "sine"],
      [82.4, -3, "sine"], // a perfect-fifth-ish to warm the drone
    ] as [number, number, OscillatorType][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(lp);
      o.start();
      oscs.push(o);
    }

    // slow tremolo LFO on the bus for "breathing"
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.05;
    lfo.connect(lfoGain).connect(bus.gain);
    lfo.start();

    this.ambient = {
      stop: () => {
        const t = ctx.currentTime;
        bus.gain.cancelScheduledValues(t);
        bus.gain.setTargetAtTime(0, t, 0.4);
        const dead = t + 1.2;
        for (const o of oscs) o.stop(dead);
        lfo.stop(dead);
      },
    };
  }

  stopAmbient(): void {
    if (this.ambient) {
      this.ambient.stop();
      this.ambient = null;
    }
  }

  // ── synth voices ───────────────────────────────────────────────────────────

  /** Soft, bright two-tone hit. */
  private synthComplete(ctx: AudioContext, out: AudioNode): void {
    const t = ctx.currentTime;
    this.blip(ctx, out, { freq: 660, type: "sine", at: t, dur: 0.18, peak: 0.5 });
    this.blip(ctx, out, { freq: 990, type: "sine", at: t + 0.005, dur: 0.14, peak: 0.28 });
  }

  /** Filtered-noise whoosh that sweeps up then fades — the federation beam. */
  private synthBeam(ctx: AudioContext, out: AudioNode): void {
    const t = ctx.currentTime;
    const dur = 0.45;
    const src = ctx.createBufferSource();
    src.buffer = this.noise(ctx);
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 6;
    bp.frequency.setValueAtTime(380, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + dur * 0.7);
    bp.frequency.exponentialRampToValueAtTime(900, t + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(bp).connect(g).connect(out);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** Two descending detuned tones — an alert chime. */
  private synthError(ctx: AudioContext, out: AudioNode): void {
    const t = ctx.currentTime;
    this.blip(ctx, out, { freq: 392, type: "triangle", at: t, dur: 0.16, peak: 0.4 });
    this.blip(ctx, out, { freq: 277, type: "triangle", at: t + 0.13, dur: 0.26, peak: 0.42 });
  }

  /** Quick pitch-rise pop. */
  private synthSpawn(ctx: AudioContext, out: AudioNode): void {
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(280, t);
    o.frequency.exponentialRampToValueAtTime(720, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.18);
  }

  /** Rising 4-note arpeggio — celebratory fanfare. */
  private synthAchievement(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((f, i) => {
      const at = t0 + i * 0.09;
      this.blip(ctx, out, { freq: f, type: "triangle", at, dur: 0.22, peak: 0.34 });
      this.blip(ctx, out, { freq: f * 2, type: "sine", at, dur: 0.16, peak: 0.1 });
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private blip(
    ctx: AudioContext,
    out: AudioNode,
    o: { freq: number; type: OscillatorType; at: number; dur: number; peak: number },
  ): void {
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.value = o.freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, o.at);
    g.gain.exponentialRampToValueAtTime(o.peak, o.at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, o.at + o.dur);
    osc.connect(g).connect(out);
    osc.start(o.at);
    osc.stop(o.at + o.dur + 0.02);
  }

  private noise(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    const len = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
    return buf;
  }

  /** Optionally replace synth voices with CC0 samples from WORLD_SOUND_ASSETS. */
  async loadAssets(only?: WorldSoundCategory[]): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx || typeof fetch === "undefined") return;
    const cats = only ?? WORLD_SOUND_CATEGORIES;
    await Promise.all(
      cats.map(async (cat) => {
        try {
          const res = await fetch(WORLD_SOUND_ASSETS[cat]);
          if (!res.ok) return;
          const arr = await res.arrayBuffer();
          this.buffers[cat] = await ctx.decodeAudioData(arr);
        } catch {
          /* keep synth fallback */
        }
      }),
    );
  }
}

/** Process-wide singleton — the `<world-audio>` element shares this. */
let singleton: WorldSounds | null = null;
export function getWorldSounds(): WorldSounds {
  if (!singleton) singleton = new WorldSounds();
  return singleton;
}
