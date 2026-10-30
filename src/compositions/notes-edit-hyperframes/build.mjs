#!/usr/bin/env node
/**
 * Generate index.html for a Hyperframes Studio project that loads our
 * notes-edit cut as ONE CLIP PER KEEP SPAN — so every span is an
 * adjustable timeline clip in the studio (drag edges, nudge, delete).
 *
 * Layout:
 *   <video muted>  per keep — picture (track 0)
 *   <audio>        per keep — sound   (track 1)
 *
 *   Each element points at its source clip's proxy.mp4 with a query
 *   `?s=<sceneNum>` cache-buster so the parent-media proxy dedup
 *   (parent-media.ts:245) doesn't collapse all 93 elements into one
 *   audio entry. The browser still serves them from one cached file via
 *   Range requests.
 *
 *   data-start         — position on the cut timeline (seconds)
 *   data-media-start   — where in the source proxy to start (seconds)
 *   data-duration      — keep span length
 *
 *   Stable id="scene-N-video" / "scene-N-audio" for studio edit targets.
 *
 *   window.__timelines["root"] is registered with a paused GSAP timeline
 *   (required by the runtime even without animated properties).
 *
 * Symlinks expected next to this file (managed by install.ts):
 *   <slug>-source.mp4   → workspace/jobs/<slug>/proxy.mp4
 *
 * Run:  node build.mjs
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKSPACE = process.env.NOTES_EDIT_WORKSPACE ?? join(homedir(), "Infini", ".notes-edit");

const slugs = readdirSync(join(WORKSPACE, "jobs"))
  .filter((s) => existsSync(join(WORKSPACE, "jobs", s, "manifest.json")))
  .sort();

if (!slugs.length) {
  console.error("No jobs found at", WORKSPACE);
  process.exit(1);
}

let cutTime = 0;
let sceneNum = 1;
const videoTags = [];
const audioTags = [];

for (const slug of slugs) {
  const sourceFile = `${slug}-source.mp4`;
  if (!existsSync(join(import.meta.dirname, sourceFile))) {
    console.warn(`Skipping ${slug}: ${sourceFile} missing`);
    continue;
  }
  const edlPath = join(WORKSPACE, "jobs", slug, "edl.json");
  const edl = JSON.parse(readFileSync(edlPath, "utf-8"));
  const keeps = (edl.entries ?? []).filter((e) => e.action === "keep" && e.end - e.start > 0.01);

  for (const k of keeps) {
    const dur = +(k.end - k.start).toFixed(3);
    const mediaStart = +k.start.toFixed(3);
    const trackStart = +cutTime.toFixed(3);
    // First scene pre-buffers fully so the preview isn't black at boot;
    // the rest only load metadata until the runtime promotes them.
    const preload = sceneNum === 1 ? "auto" : "metadata";
    // Unique cache-buster per scene so each <audio> gets its own decoder
    // (the browser still serves the underlying file from one HTTP cache
    // via Range requests). Same-URL audio elements share playback state
    // and leak overlapping playback across the boundary on transition.
    const url = `${sourceFile}?s=${sceneNum}`;
    const textPreview = (k.text ?? "").replace(/"/g, "&quot;").slice(0, 60);
    videoTags.push(
      `      <video id="scene-${sceneNum}-video" class="clip"
             src="${url}"
             muted playsinline preload="${preload}"
             data-start="${trackStart}"
             data-duration="${dur}"
             data-media-start="${mediaStart}"
             data-source-duration="${(edl.entries.at(-1)?.end ?? 0).toFixed(3)}"
             data-track-index="0"
             data-label="${textPreview}"></video>`,
    );
    audioTags.push(
      `      <audio id="scene-${sceneNum}-audio"
             src="${url}"
             preload="${preload}"
             data-start="${trackStart}"
             data-duration="${dur}"
             data-media-start="${mediaStart}"
             data-source-duration="${(edl.entries.at(-1)?.end ?? 0).toFixed(3)}"
             data-track-index="1"
             data-volume="1"></audio>`,
    );
    cutTime += dur;
    sceneNum++;
  }
}

const totalDuration = +cutTime.toFixed(3);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>notes-edit · ${sceneNum - 1} adjustable scenes</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  html, body { margin:0; padding:0; background:#000; }
  [data-composition-id="root"] { position:relative; width:100%; height:100%; overflow:hidden; background:#000; }
  .clip { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; background:#000; }
</style>
</head>
<body>
  <div id="root"
       data-composition-id="root"
       data-start="0"
       data-duration="${totalDuration}"
       data-width="1920"
       data-height="1080"
       data-fps="30"
       data-background="#000000">
${videoTags.join("\n")}
${audioTags.join("\n")}
    <script>
      // Required by Hyperframes runtime even when nothing is animated.
      (() => {
        window.__timelines = window.__timelines || {};
        const tl = gsap.timeline({ paused: true });
        tl.set({}, {}, ${totalDuration});
        window.__timelines["root"] = tl;
      })();

      // ── Shared clip model + decode manager + ripple reflow ─────────
      // One ordered, indexed model of every scene clip, built once and
      // rebuilt ONLY when clips are added/removed (not on every attribute
      // mutation). Both the playback decode-window manager and the
      // editing-path ripple reflow read from this model, so neither
      // re-queries the DOM or re-sorts the (93+) clips on every event —
      // the old per-frame / per-event hot-path cost.
      (() => {
        const root = document.getElementById("root");
        if (!root) return;

        const LOOKAHEAD = 2;   // scenes kept fully buffered ahead of playhead
        const LOOKBEHIND = 1;  // scenes kept warm behind (scrub-back)

        let ordered = [];               // [{ video, audio, idx }] sorted by data-start
        const idxById = new Map();      // video.id -> index in ordered[]

        function rebuildModel() {
          const vids = Array.from(root.querySelectorAll("video.clip"))
            .filter((v) => v.isConnected)
            .sort((a, b) => parseFloat(a.dataset.start) - parseFloat(b.dataset.start));
          ordered = vids.map((video, idx) => ({
            video,
            audio: document.getElementById(video.id.replace("-video", "-audio")),
            idx,
          }));
          idxById.clear();
          for (const c of ordered) idxById.set(c.video.id, c.idx);
        }
        rebuildModel();

        // Sliding-window decode manager. The previous preloader only ever
        // ESCALATED preload to "auto" and never released it, so after a
        // full play-through all 93 video pipelines were buffering at once
        // — memory + decoder contention that drops frames the longer you
        // play. Keep a bounded window at "auto" and demote the rest to
        // "metadata" so the browser can reclaim forward buffers. We never
        // clear src or drop below "metadata", so the runtime can always
        // re-activate a clip without a black frame.
        let applyScheduled = false;
        let center = 0;
        function applyWindow() {
          applyScheduled = false;
          const lo = center - LOOKBEHIND;
          const hi = center + LOOKAHEAD;
          for (const c of ordered) {
            const want = c.idx >= lo && c.idx <= hi ? "auto" : "metadata";
            if (c.video.preload !== want) c.video.preload = want;
            if (c.audio && c.audio.preload !== want) c.audio.preload = want;
          }
        }
        function focusScene(idx) {
          center = idx;
          if (applyScheduled) return;
          applyScheduled = true;
          requestAnimationFrame(applyWindow);
        }
        // One delegated listener instead of N per-element listeners.
        // 'playing' does not bubble, but capture phase still reaches the
        // ancestor on the way to the target.
        root.addEventListener(
          "playing",
          (e) => {
            const t = e.target;
            if (t && t.classList && t.classList.contains("clip")) {
              const idx = idxById.get(t.id);
              if (idx !== undefined) focusScene(idx);
            }
          },
          true,
        );

        // Auto-ripple: when a clip is trimmed (data-duration changes) or
        // deleted (removed from DOM), reflow every subsequent clip's
        // data-start so there are no gaps/overlaps, and match the paired
        // audio. Reads the cached model; rebuilds it only on add/remove.
        let suppressed = false;
        let scheduled = false;
        function reflow() {
          if (suppressed) return;
          suppressed = true;
          try {
            let cursor = 0;
            for (const c of ordered) {
              const v = c.video;
              if (!v.isConnected) continue;
              const dur = parseFloat(v.dataset.duration || "0");
              if (!isFinite(dur) || dur <= 0) continue;
              const cs = cursor.toFixed(3);
              if (v.dataset.start !== cs) v.dataset.start = cs;
              const audio = c.audio;
              if (audio) {
                if (audio.dataset.start !== cs) audio.dataset.start = cs;
                const ds = dur.toFixed(3);
                if (audio.dataset.duration !== ds) audio.dataset.duration = ds;
                const vMedia = v.dataset.mediaStart || "0";
                if (audio.dataset.mediaStart !== vMedia) audio.dataset.mediaStart = vMedia;
              }
              cursor += dur;
            }
            const cur = cursor.toFixed(3);
            if (root.dataset.duration !== cur) root.dataset.duration = cur;
            const tl = window.__timelines && window.__timelines["root"];
            if (tl && typeof tl.duration === "function") tl.duration(cursor);
          } finally {
            queueMicrotask(() => { suppressed = false; });
          }
        }
        function schedule() {
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrame(() => { scheduled = false; reflow(); });
        }

        const obs = new MutationObserver((records) => {
          let structural = false;
          let attr = false;
          for (const rec of records) {
            if (rec.type === "childList" && (rec.removedNodes.length || rec.addedNodes.length)) {
              structural = true;
            } else if (rec.type === "attributes") {
              attr = true;
            }
          }
          if (structural) {
            // Drop orphan audios whose video was removed, then rebuild
            // the cached model before reflowing.
            for (const a of root.querySelectorAll('audio[id$="-audio"]')) {
              if (!document.getElementById(a.id.replace("-audio", "-video"))) a.remove();
            }
            rebuildModel();
            schedule();
          } else if (attr) {
            schedule();
          }
        });
        obs.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-start", "data-duration"],
        });

        // Opt-in FPS probe: set window.__notesEditPerf = true before play
        // to log avg fps + worst (longest) frame each second via
        // performance.now() deltas. Zero overhead when disabled.
        if (window.__notesEditPerf) {
          let last = performance.now();
          let frames = 0, worst = 0, acc = 0, t0 = last;
          (function probe(now) {
            const dt = now - last; last = now;
            if (dt > 0) { frames++; acc += dt; if (dt > worst) worst = dt; }
            if (now - t0 >= 1000) {
              console.log("[notes-edit perf] avg " + ((frames * 1000) / acc).toFixed(1) +
                " fps, worst frame " + worst.toFixed(1) + "ms over " + frames + " frames");
              frames = 0; acc = 0; worst = 0; t0 = now;
            }
            requestAnimationFrame(probe);
          })(last);
        }
      })();
    </script>
  </div>
</body>
</html>
`;

writeFileSync(join(import.meta.dirname, "index.html"), html);
console.log(
  `Wrote index.html: ${sceneNum - 1} adjustable scenes, ${totalDuration.toFixed(2)}s total cut`,
);
