"use strict";
(() => {
  // src/ui/views/agent-ops/iso/camera-easing.ts
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function omegaForSettle(settleMs) {
    const settleSec = Math.max(1e-4, settleMs / 1e3);
    return 6 / settleSec;
  }
  function criticallyDampedStep(state, target, omega, dtMs, maxSpeed = Infinity) {
    const dt = Math.max(0, dtMs) / 1e3;
    if (dt === 0 || omega <= 0) return { x: state.x, v: state.v };
    let v0 = state.v;
    if (Number.isFinite(maxSpeed)) v0 = clamp(v0, -maxSpeed, maxSpeed);
    const d = state.x - target;
    const e = Math.exp(-omega * dt);
    const c = v0 + omega * d;
    const x = target + (d + c * dt) * e;
    let v = (v0 - c * omega * dt) * e;
    if (Number.isFinite(maxSpeed)) v = clamp(v, -maxSpeed, maxSpeed);
    return { x, v };
  }

  // src/ui/views/agent-ops/iso/cinematic-camera.ts
  var DEFAULT_CINEMATIC_CONFIG = {
    quietMs: 3e4,
    orbitRadiusFrac: 0.22,
    orbitSpeed: 0.18,
    droneScale: 1.05,
    establishScale: 0.55,
    closeScale: 1.9,
    revealScale: 1.25,
    subjectHoldMs: 11e3,
    pollMs: 1500,
    orbitTickMs: 90
  };
  var USER_INPUT_EVENTS = ["pointerdown", "wheel", "keydown", "touchstart"];
  var ORBIT_TICK_CAP_MS = 64;
  var CinematicCamera = class {
    constructor(deps, config) {
      this.droneActive = false;
      this.autoEnabled = false;
      this.recording = false;
      /** While now() < this, auto-drone won't engage — an explicit shot owns the camera. */
      this.manualHoldUntil = 0;
      // Auto-engage poll + orbit rAF
      this.pollTimer = null;
      this.rafId = null;
      // Orbit state
      this.orbitAngle = 0;
      this.orbitCenter = { x: 0, y: 0 };
      this.orbitRadius = 200;
      this.subjectId = null;
      this.subjectPickedAt = 0;
      this.lastOrbitTickAt = 0;
      this.lastFrameAt = 0;
      // Critically-damped springs so the orbit center glides between subjects.
      this.springX = { x: 0, v: 0 };
      this.springY = { x: 0, v: 0 };
      this.springSeeded = false;
      // Bound listeners (so we can remove them)
      this.onUserInput = () => {
        if (this.droneActive) this.exitDroneMode();
        this.lastUserInputAt = this.deps.now();
      };
      this.lastUserInputAt = 0;
      this.deps = deps;
      this.cfg = { ...DEFAULT_CINEMATIC_CONFIG, ...config };
    }
    // ── Lifecycle ──────────────────────────────────────────────────────────────
    /** Publish window.cinematicCamera and start the auto-drone poll. */
    install() {
      try {
        window.cinematicCamera = {
          enterDroneMode: () => this.enterDroneMode(),
          exitDroneMode: () => this.exitDroneMode(),
          toggleDrone: () => this.toggleDrone(),
          isDroneMode: () => this.isDroneMode(),
          panTo: (x, y, scale) => this.panTo(x, y, scale),
          cinematicShot: (ids, opts) => this.cinematicShot(ids, opts),
          recordCinematic: (opts) => this.recordCinematic(opts)
        };
      } catch {
      }
      this.startAuto();
    }
    /** Begin auto-engaging drone mode during quiet periods. */
    startAuto() {
      if (this.autoEnabled) return;
      this.autoEnabled = true;
      for (const ev of USER_INPUT_EVENTS) {
        window.addEventListener(ev, this.onUserInput, { passive: true });
      }
      this.pollTimer = setInterval(() => this.pollQuiet(), this.cfg.pollMs);
    }
    /** Stop auto-engaging (manual shots/drone still work). */
    stopAuto() {
      this.autoEnabled = false;
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      for (const ev of USER_INPUT_EVENTS) {
        window.removeEventListener(ev, this.onUserInput);
      }
    }
    destroy() {
      this.exitDroneMode();
      this.stopAuto();
      try {
        if (window.cinematicCamera) delete window.cinematicCamera;
      } catch {
      }
    }
    // ── Quiet detection / auto-engage ────────────────────────────────────────────
    pollQuiet() {
      if (!this.autoEnabled || this.recording) return;
      const now = this.deps.now();
      const quietFor = now - this.deps.lastActivityAt();
      const sinceUserInput = now - this.lastUserInputAt;
      if (this.droneActive) {
        if (quietFor < this.cfg.quietMs * 0.5) this.exitDroneMode();
        return;
      }
      if (now < this.manualHoldUntil) return;
      if (quietFor >= this.cfg.quietMs && sinceUserInput >= this.cfg.quietMs) {
        this.enterDroneMode();
      }
    }
    // ── Drone mode ────────────────────────────────────────────────────────────────
    isDroneMode() {
      return this.droneActive;
    }
    toggleDrone() {
      this.droneActive ? this.exitDroneMode() : this.enterDroneMode();
    }
    enterDroneMode() {
      if (this.droneActive) return;
      this.droneActive = true;
      this.subjectId = null;
      this.subjectPickedAt = 0;
      this.springSeeded = false;
      this.lastFrameAt = this.deps.now();
      this.lastOrbitTickAt = 0;
      this.pickSubject(this.deps.now());
      if (this.reducedMotion()) {
        const c = this.orbitCenter;
        this.driveCamera(c.x, c.y, this.cfg.droneScale, 1400);
        return;
      }
      this.startRaf();
    }
    exitDroneMode() {
      if (!this.droneActive) return;
      this.droneActive = false;
      this.stopRaf();
      this.deps.director?.setUserOverride?.(0);
    }
    startRaf() {
      if (this.rafId != null) return;
      const loop = () => {
        this.rafId = requestAnimationFrame(loop);
        this.orbitFrame();
      };
      this.rafId = requestAnimationFrame(loop);
    }
    stopRaf() {
      if (this.rafId != null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    }
    /** One drone frame: glide orbit center toward the subject and dolly around it. */
    orbitFrame() {
      if (!this.droneActive) return;
      const now = this.deps.now();
      const dt = Math.min(ORBIT_TICK_CAP_MS, Math.max(0, now - this.lastFrameAt));
      this.lastFrameAt = now;
      if (now - this.subjectPickedAt > this.cfg.subjectHoldMs) this.pickSubject(now);
      const target = this.subjectPos();
      if (!this.springSeeded) {
        this.springX = { x: target.x, v: 0 };
        this.springY = { x: target.y, v: 0 };
        this.springSeeded = true;
      }
      const omega = omegaForSettle(900);
      this.springX = criticallyDampedStep(this.springX, target.x, omega, dt);
      this.springY = criticallyDampedStep(this.springY, target.y, omega, dt);
      this.orbitCenter = { x: this.springX.x, y: this.springY.x };
      this.orbitAngle += this.cfg.orbitSpeed * (dt / 1e3);
      if (now - this.lastOrbitTickAt < this.cfg.orbitTickMs) return;
      this.lastOrbitTickAt = now;
      const breathe = 1 + 0.12 * Math.sin(this.orbitAngle * 0.5);
      const r = this.orbitRadius * breathe;
      const x = this.orbitCenter.x + Math.cos(this.orbitAngle) * r;
      const y = this.orbitCenter.y + Math.sin(this.orbitAngle) * r * 0.6;
      const scale = this.cfg.droneScale * (1 + 0.06 * Math.cos(this.orbitAngle * 0.5));
      this.driveCamera(x, y, scale, Math.max(140, this.cfg.orbitTickMs * 2));
    }
    // ── Subject selection ────────────────────────────────────────────────────────
    pickSubject(now) {
      this.subjectPickedAt = now;
      const agents2 = this.safeAgents();
      const bounds2 = this.deps.worldBounds();
      const span = bounds2 ? Math.hypot(bounds2.maxX - bounds2.minX, bounds2.maxY - bounds2.minY) : agents2.length ? this.spread(agents2) : 1600;
      this.orbitRadius = Math.max(120, span * this.cfg.orbitRadiusFrac);
      if (agents2.length === 0) {
        this.subjectId = null;
        this.orbitCenter = bounds2 ? { x: (bounds2.minX + bounds2.maxX) / 2, y: (bounds2.minY + bounds2.maxY) / 2 } : { x: 800, y: 600 };
        return;
      }
      const cx = agents2.reduce((s, a) => s + a.x, 0) / agents2.length;
      const cy = agents2.reduce((s, a) => s + a.y, 0) / agents2.length;
      let best = agents2[0];
      let bestD = Infinity;
      for (const a of agents2) {
        const d = Math.hypot(a.x - cx, a.y - cy);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
      if (this.subjectId && agents2.length > 1) {
        const others = agents2.filter((a) => a.id !== this.subjectId);
        best = others[Math.floor(now / 1e3) % others.length] ?? best;
      }
      this.subjectId = best.id;
    }
    subjectPos() {
      if (this.subjectId) {
        const a = this.safeAgents().find((p) => p.id === this.subjectId);
        if (a) return { x: a.x, y: a.y };
      }
      return this.orbitCenter;
    }
    // ── Composed shots ────────────────────────────────────────────────────────────
    /**
     * Compose a cinematic shot over a set of targets.
     * Resolves when the move's nominal duration elapses.
     */
    cinematicShot(targetIds, opts) {
      const type = opts?.type ?? "establish";
      if (this.droneActive) this.exitDroneMode();
      const agents2 = this.safeAgents();
      const targets = targetIds.map((id) => agents2.find((a) => a.id === id)).filter((a) => !!a);
      const pts = targets.length ? targets : agents2;
      const center = this.centroid(pts);
      const span = pts.length ? this.spread(pts) : 800;
      switch (type) {
        case "close": {
          const c = pts[0] ?? center;
          return this.shotMove(c.x, c.y, this.cfg.closeScale, 1100);
        }
        case "orbit": {
          this.orbitCenter = center;
          this.orbitRadius = Math.max(140, span * 0.5);
          this.subjectId = pts[0]?.id ?? null;
          this.subjectPickedAt = this.deps.now() + 1e9;
          this.orbitAngle = 0;
          this.lastFrameAt = this.deps.now();
          this.lastOrbitTickAt = 0;
          this.springSeeded = false;
          this.droneActive = true;
          if (!this.reducedMotion()) this.startRaf();
          else this.driveCamera(center.x, center.y, this.cfg.droneScale, 1400);
          const loopMs = Math.max(2e3, 2 * Math.PI / this.cfg.orbitSpeed * 1e3);
          return this.wait(loopMs);
        }
        case "reveal": {
          const offX = center.x - span * 0.9;
          const offY = center.y - span * 0.6;
          this.holdManual(3400);
          this.driveCamera(offX, offY, this.cfg.establishScale, 700);
          return this.wait(720).then(
            () => this.shotMove(center.x, center.y, this.cfg.revealScale, 2600)
          );
        }
        case "establish":
        default: {
          const fit = clamp(900 / Math.max(300, span), 0.4, 1.2) * this.cfg.establishScale + 0.2;
          return this.shotMove(center.x, center.y, fit, 2400);
        }
      }
    }
    /** Pan the main camera to a world point (minimap click target). Breaks drone mode. */
    panTo(x, y, scale = 1.25) {
      if (this.droneActive) this.exitDroneMode();
      this.holdManual(700);
      this.driveCamera(x, y, scale, 700);
    }
    shotMove(x, y, scale, timeMs) {
      this.holdManual(timeMs);
      this.driveCamera(x, y, scale, timeMs);
      return this.wait(timeMs);
    }
    /** Suppress auto-drone re-engage until a manual move (plus a small grace) finishes. */
    holdManual(durationMs) {
      this.manualHoldUntil = Math.max(this.manualHoldUntil, this.deps.now() + durationMs + 1500);
    }
    // ── Recording ────────────────────────────────────────────────────────────────
    /**
     * Record the engine canvas to a WebM Blob via MediaRecorder.
     * Requires deps.recordElement to return an HTMLCanvasElement that supports
     * captureStream (all modern Chromium/Firefox builds do).
     */
    recordCinematic(opts) {
      const fps = opts.fps ?? 30;
      const durationMs = Math.max(200, opts.durationMs);
      return new Promise((resolve, reject) => {
        const el = this.deps.recordElement?.();
        const canvas2 = el;
        if (!canvas2 || typeof canvas2.captureStream !== "function") {
          reject(new Error("cinematic: recordElement() did not return a captureStream-capable canvas"));
          return;
        }
        if (typeof MediaRecorder === "undefined") {
          reject(new Error("cinematic: MediaRecorder API unavailable in this environment"));
          return;
        }
        let stream;
        try {
          stream = canvas2.captureStream(fps);
        } catch (e) {
          reject(new Error(`cinematic: captureStream failed: ${e.message}`));
          return;
        }
        const mime = this.pickMimeType();
        let recorder;
        try {
          recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : void 0);
        } catch (e) {
          reject(new Error(`cinematic: MediaRecorder init failed: ${e.message}`));
          return;
        }
        const chunks = [];
        this.recording = true;
        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) chunks.push(ev.data);
        };
        recorder.onerror = (ev) => {
          this.recording = false;
          reject(new Error(`cinematic: MediaRecorder error: ${String(ev)}`));
        };
        recorder.onstop = () => {
          this.recording = false;
          for (const t of stream.getTracks()) t.stop();
          resolve(new Blob(chunks, { type: mime || "video/webm" }));
        };
        recorder.start();
        setTimeout(() => {
          if (recorder.state !== "inactive") recorder.stop();
        }, durationMs);
      });
    }
    pickMimeType() {
      if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return null;
      const candidates = [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm"
      ];
      for (const c of candidates) {
        if (MediaRecorder.isTypeSupported(c)) return c;
      }
      return null;
    }
    // ── Helpers ────────────────────────────────────────────────────────────────────
    /** Drive the engine camera, asking the director to yield for the move's duration. */
    driveCamera(x, y, scale, timeMs) {
      this.deps.director?.setUserOverride?.(timeMs + 300);
      try {
        this.deps.flyTo(x, y, scale, timeMs);
      } catch {
      }
    }
    safeAgents() {
      try {
        const a = this.deps.agentPositions();
        return Array.isArray(a) ? a.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
      } catch {
        return [];
      }
    }
    centroid(pts) {
      if (!pts.length) {
        const b = this.deps.worldBounds();
        return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 800, y: 600 };
      }
      const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      return { x, y };
    }
    spread(pts) {
      if (pts.length < 2) return 600;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      return Math.hypot(maxX - minX, maxY - minY);
    }
    reducedMotion() {
      if (this.deps.prefersReducedMotion) {
        try {
          return !!this.deps.prefersReducedMotion();
        } catch {
        }
      }
      try {
        return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      } catch {
        return false;
      }
    }
    wait(ms) {
      return new Promise((res) => setTimeout(res, ms));
    }
  };

  // src/ui/views/agent-ops/iso/__cinematic_test_entry.ts
  var W = 960;
  var H = 600;
  var canvas = document.getElementById("world");
  canvas.width = W;
  canvas.height = H;
  var ctx = canvas.getContext("2d");
  var bounds = { minX: 0, minY: 0, maxX: 1600, maxY: 1e3 };
  var sectors = [
    { id: "build", x: 300, y: 250 },
    { id: "deploy", x: 1200, y: 300 },
    { id: "research", x: 800, y: 750 }
  ];
  var agents = [
    { id: "a1", x: 360, y: 280 },
    { id: "a2", x: 420, y: 230 },
    { id: "a3", x: 1180, y: 320 },
    { id: "a4", x: 820, y: 720 },
    { id: "a5", x: 760, y: 790 }
  ];
  var cam = { x: 800, y: 500, scale: 0.7, tx: 800, ty: 500, ts: 0.7, t: 0 };
  var lastActivity = performance.now();
  function flyTo(x, y, scale, timeMs) {
    cam.tx = x;
    cam.ty = y;
    cam.ts = scale;
    cam.t = timeMs;
    window.__lastFly = { x, y, scale, timeMs };
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function render() {
    cam.x = lerp(cam.x, cam.tx, 0.12);
    cam.y = lerp(cam.y, cam.ty, 0.12);
    cam.scale = lerp(cam.scale, cam.ts, 0.12);
    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, W, H);
    const s = cam.scale;
    const ox = W / 2 - cam.x * s;
    const oy = H / 2 - cam.y * s;
    const toS = (wx, wy) => ({ x: wx * s + ox, y: wy * s + oy });
    ctx.strokeStyle = "rgba(232,192,96,0.25)";
    const tl = toS(bounds.minX, bounds.minY);
    const br = toS(bounds.maxX, bounds.maxY);
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    for (const sec of sectors) {
      const p = toS(sec.x, sec.y);
      ctx.fillStyle = "rgba(232,192,96,0.12)";
      ctx.strokeStyle = "rgba(232,192,96,0.4)";
      ctx.fillRect(p.x - 60 * s, p.y - 60 * s, 120 * s, 120 * s);
      ctx.strokeRect(p.x - 60 * s, p.y - 60 * s, 120 * s, 120 * s);
      ctx.fillStyle = "rgba(232,192,96,0.7)";
      ctx.font = "12px monospace";
      ctx.fillText(sec.id, p.x - 24, p.y - 66 * s);
    }
    for (const a of agents) {
      const p = toS(a.x, a.y);
      ctx.fillStyle = "#6ee7a8";
      ctx.shadowColor = "#6ee7a8";
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7 * s + 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.fillStyle = "#e8c060";
    ctx.font = "13px monospace";
    ctx.fillText(`cam(${cam.x.toFixed(0)},${cam.y.toFixed(0)}) s=${cam.scale.toFixed(2)}  drone=${window.cinematicCamera?.isDroneMode?.()}`, 12, 22);
    requestAnimationFrame(render);
  }
  render();
  var cinematic = new CinematicCamera({
    now: () => performance.now(),
    flyTo,
    worldBounds: () => bounds,
    agentPositions: () => agents,
    lastActivityAt: () => lastActivity,
    recordElement: () => canvas,
    director: { setUserOverride() {
    }, setEnabled() {
    }, isEnabled: () => false }
  }, { quietMs: 1500, pollMs: 500 });
  cinematic.install();
  window.__cinematic = cinematic;
  window.__bumpActivity = () => {
    lastActivity = performance.now();
  };
})();
