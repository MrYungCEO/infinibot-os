/* InfiniBot setup-guide player. Enhances the static markup rendered by
 * scripts/setup-guide-video.mjs (sources live in data-* attributes, so the
 * only place the video URL is configured is that module).
 * - the <video> is created only when someone presses play or a chapter (no autoplay)
 * - 720p on small screens / Save-Data, 1080p otherwise
 * - captions + chapters tracks, chapter list seeks and highlights the current one
 * - ?t=<seconds> pre-selects a start point (used by chapter deep links)
 */
(function () {
  "use strict";
  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function pickSrc(root) {
    var conn = navigator.connection || {};
    var small = window.innerWidth < 900;
    return conn.saveData || small ? root.dataset.srcSd : root.dataset.srcHd;
  }

  function mount(root) {
    var frame = root.querySelector(".sg-frame");
    var poster = root.querySelector(".sg-poster");
    var chaps = Array.prototype.slice.call(root.querySelectorAll(".sg-chap"));
    var times = chaps.map(function (b) { return Number(b.dataset.t) || 0; });
    var video = null;
    var pendingT = null;
    var lastT = 0; // last requested start point, kept across the 720p fallback

    var qs = new URLSearchParams(location.search);
    if (qs.has("t") && (location.hash === "#" + root.id || !location.hash)) {
      var t0 = Number(qs.get("t"));
      if (isFinite(t0) && t0 > 0) {
        pendingT = t0;
        var label = root.querySelector(".sg-badge__label");
        if (label) label.textContent = "Play from " + fmt(t0);
        mark(t0);
      }
    }

    function mark(t) {
      var idx = 0;
      for (var i = 0; i < times.length; i++) if (t + 0.25 >= times[i]) idx = i;
      chaps.forEach(function (b, i) {
        b.classList.toggle("is-active", i === idx);
        if (i === idx) b.setAttribute("aria-current", "true");
        else b.removeAttribute("aria-current");
      });
    }

    function ensureVideo() {
      if (video) return video;
      video = document.createElement("video");
      video.className = "sg-video";
      video.controls = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.crossOrigin = "anonymous";
      video.setAttribute("poster", poster.querySelector("img").currentSrc || poster.querySelector("img").src);
      video.setAttribute("aria-label", "InfiniBot setup guide video");
      video.src = pickSrc(root);
      var cap = document.createElement("track");
      cap.kind = "captions"; cap.srclang = "en"; cap.label = "English"; cap.src = root.dataset.captions;
      var ch = document.createElement("track");
      ch.kind = "chapters"; ch.srclang = "en"; ch.label = "Chapters"; ch.src = root.dataset.chapters;
      video.appendChild(cap);
      video.appendChild(ch);
      video.addEventListener("timeupdate", function () { mark(video.currentTime); });
      video.addEventListener("error", function () {
        // 720p fallback if the 1080p file fails to load
        // (keeps the position / requested chapter)
        if (video.src !== root.dataset.srcSd) {
          var at = video.currentTime > 0.5 ? video.currentTime : lastT;
          video.src = root.dataset.srcSd;
          video.addEventListener("loadedmetadata", function () { video.currentTime = at; }, { once: true });
          video.play().catch(function () {});
        }
      });
      frame.appendChild(video);
      poster.hidden = true;
      root.classList.add("is-playing");
      return video;
    }

    function playFrom(t) {
      var v = ensureVideo();
      if (t != null) {
        lastT = t;
        mark(t);
        if (v.readyState >= 1) v.currentTime = t;
        else v.addEventListener("loadedmetadata", function () { v.currentTime = t; }, { once: true });
      }
      // play() stays inside the click handler so mobile Safari allows sound
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
      v.focus({ preventScroll: true });
    }

    poster.addEventListener("click", function () { playFrom(pendingT); pendingT = null; });
    chaps.forEach(function (b) {
      b.addEventListener("click", function () {
        playFrom(Number(b.dataset.t) || 0);
        if (frame.getBoundingClientRect().top < 0) frame.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
    root.setupGuide = { playFrom: playFrom, get video() { return video; } };
  }

  function init() {
    document.querySelectorAll("[data-setup-guide]").forEach(function (el) {
      if (!el.dataset.sgReady) { el.dataset.sgReady = "1"; mount(el); }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
