// The 6-minute InfiniBot setup-guide video, played in a modal from the setup
// screens. Never autoplays: it opens (and plays) only when the user presses
// a "Watch the setup guide" button.
//
// SETUP_GUIDE_VIDEO is the one place the video is configured in the app. The
// files are hosted on the infinibot-media Netlify site (deploy/infinibot-media);
// for a v2, upload under a new dated folder and change `base`.

import { html, type TemplateResult } from "lit";

export const SETUP_GUIDE_VIDEO = {
  version: "2026-10-26",
  base: "https://infinibot-media.netlify.app/setup-guide/2026-10-26/",
  files: {
    hd: "infinibot-setup-guide-1080p.mp4",
    sd: "infinibot-setup-guide-720p.mp4",
    poster: "infinibot-setup-guide-poster.jpg",
    captions: "infinibot-setup-guide.en.vtt",
    chapters: "infinibot-setup-guide.chapters.vtt",
  },
  /** Public page with the same video (fallback when the media can't load). */
  pageUrl: "https://infinibotos.com/setup-guide",
  durationSec: 372,
  chapters: [
    { t: 0, title: "Intro: what InfiniBot is" },
    { t: 24, title: "Download & install" },
    { t: 82, title: "First launch & the 8-step setup" },
    { t: 159, title: "AI brain & API keys" },
    { t: 232, title: "Getting started" },
    { t: 259, title: "Cloud route" },
    { t: 286, title: "npm route" },
    { t: 310, title: "Common issues & fixes" },
    { t: 357, title: "Get help" },
  ],
} as const;

type GuideFile = keyof typeof SETUP_GUIDE_VIDEO.files;
const url = (f: GuideFile) => SETUP_GUIDE_VIDEO.base + SETUP_GUIDE_VIDEO.files[f];

export function formatGuideTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const STYLE = `
.ibsg{padding:0;border:1px solid rgba(251,191,36,.38);border-radius:18px;background:#07070a;color:#f4f4f5;
  width:min(1180px,94vw);max-height:92vh;overflow:auto;box-shadow:0 40px 120px -30px rgba(251,191,36,.45),0 0 0 1px #000;
  font-family:var(--font-body,Manrope,Inter,system-ui,sans-serif)}
.ibsg::backdrop{background:rgba(2,2,4,.78);backdrop-filter:blur(6px)}
.ibsg__head{display:flex;align-items:center;gap:12px;padding:14px 16px 12px 20px;border-bottom:1px solid rgba(255,255,255,.07)}
.ibsg__eyebrow{font:700 11px/1 var(--font-mono,"JetBrains Mono",monospace);letter-spacing:.16em;text-transform:uppercase;color:#fbbf24}
.ibsg__title{margin:0;font-size:16px;font-weight:700;letter-spacing:-.01em}
.ibsg__spacer{flex:1}
.ibsg__link{font-size:12.5px;color:#a1a1aa;text-decoration:underline;text-underline-offset:3px}
.ibsg__link:hover{color:#fde68a}
.ibsg__close{all:unset;cursor:pointer;display:grid;place-items:center;width:34px;height:34px;border-radius:10px;
  color:#d4d4d8;border:1px solid rgba(255,255,255,.1);font-size:18px;line-height:1}
.ibsg__close:hover{border-color:rgba(251,191,36,.45);color:#fff}
.ibsg__close:focus-visible,.ibsg__chap:focus-visible{outline:2px solid #fbbf24;outline-offset:1px}
.ibsg__body{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:16px;padding:16px}
.ibsg__frame{position:relative;aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:#000;border:1px solid rgba(251,191,36,.25)}
.ibsg__frame video{position:absolute;inset:0;width:100%;height:100%;background:#000}
.ibsg__frame video[hidden]{display:none}
.ibsg__label{margin:2px 0 8px;font:700 11px/1 var(--font-mono,"JetBrains Mono",monospace);letter-spacing:.14em;text-transform:uppercase;color:#fbbf24}
.ibsg__chaps{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.ibsg__chap{all:unset;box-sizing:border-box;cursor:pointer;display:grid;grid-template-columns:24px 1fr auto;gap:8px;align-items:center;
  width:100%;min-height:36px;padding:7px 10px;border-radius:9px;font-size:13px;line-height:1.3;color:#a1a1aa;border:1px solid transparent}
.ibsg__chap:hover{background:rgba(255,255,255,.04);color:#fafafa}
.ibsg__chap.is-active{color:#fafafa;background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.38)}
.ibsg__n,.ibsg__t{font:600 11px/1 var(--font-mono,"JetBrains Mono",monospace);color:#71717a}
.ibsg__chap.is-active .ibsg__n,.ibsg__chap.is-active .ibsg__t{color:#fbbf24}
.ibsg__err{position:absolute;inset:0;display:grid;place-items:center;align-content:center;gap:10px;padding:24px;text-align:center;
  background:radial-gradient(ellipse at 50% 40%,rgba(251,191,36,.10),transparent 60%),#07070a}
.ibsg__err-ic{display:grid;place-items:center;width:52px;height:52px;border-radius:50%;color:#fbbf24;border:1px solid rgba(251,191,36,.38);background:rgba(251,191,36,.08)}
.ibsg__err-t{margin:0;font-size:17px;font-weight:700;color:#fafafa}
.ibsg__err-s{margin:0;max-width:42ch;font-size:13.5px;line-height:1.5;color:#a1a1aa}
.ibsg__err-a{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:6px}
.ibsg__err-b{all:unset;cursor:pointer;padding:9px 16px;border-radius:999px;font-size:13px;font-weight:700;color:#120c00;
  background:linear-gradient(135deg,#fef3c7,#fbbf24 55%,#d97706)}
.ibsg__err-l{padding:9px 16px;border-radius:999px;font-size:13px;font-weight:600;color:#fde68a;text-decoration:none;border:1px solid rgba(251,191,36,.38)}
.ibsg__err-b:focus-visible,.ibsg__err-l:focus-visible{outline:2px solid #fbbf24;outline-offset:2px}
.ibsg__frame.is-offline{aspect-ratio:auto;min-height:clamp(240px,40vw,420px)}
.ibsg__frame.is-offline .ibsg__err{position:relative;inset:auto;min-height:inherit}
@media (max-width:820px){.ibsg__body{grid-template-columns:1fr;padding:12px}.ibsg__chaps{grid-template-columns:1fr 1fr}.ibsg__link{display:none}
  .ibsg__chap{grid-template-columns:20px 1fr;row-gap:2px;padding:7px 8px}.ibsg__t{grid-column:2}.ibsg__title{font-size:15px}}
`;

let open: HTMLDialogElement | null = null;

/** Open the setup-guide player (optionally at a chapter) and start playing. */
export function openSetupGuideVideo(startAt = 0): void {
  if (open) {
    const v = open.querySelector("video");
    if (v) {
      v.currentTime = startAt;
      void v.play().catch(() => {});
    }
    return;
  }
  const g = SETUP_GUIDE_VIDEO;
  const dlg = document.createElement("dialog");
  dlg.className = "ibsg";
  dlg.setAttribute("aria-labelledby", "ibsg-title");
  dlg.innerHTML = `<style>${STYLE}</style>
    <div class="ibsg__head">
      <div><div class="ibsg__eyebrow">Setup guide · ${formatGuideTime(g.durationSec)}</div>
      <h2 class="ibsg__title" id="ibsg-title">Set up InfiniBot in 6 minutes</h2></div>
      <span class="ibsg__spacer"></span>
      <a class="ibsg__link" href="${g.pageUrl}" target="_blank" rel="noopener noreferrer">Open in browser</a>
      <button type="button" class="ibsg__close" aria-label="Close the setup guide">&#x2715;</button>
    </div>
    <div class="ibsg__body">
      <div class="ibsg__frame">
        <video controls playsinline preload="metadata" crossorigin="anonymous" poster="${url("poster")}"
          aria-label="InfiniBot setup guide video" src="${window.innerWidth < 900 ? url("sd") : url("hd")}">
          <track kind="captions" srclang="en" label="English" src="${url("captions")}">
          <track kind="chapters" srclang="en" label="Chapters" src="${url("chapters")}">
        </video>
      </div>
      <div>
        <p class="ibsg__label">Chapters</p>
        <ol class="ibsg__chaps">${g.chapters
          .map(
            (c, i) =>
              `<li><button type="button" class="ibsg__chap" data-t="${c.t}" aria-label="Play from ${formatGuideTime(c.t)}: ${c.title.replace(/&/g, "&amp;")}"><span class="ibsg__n" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span><span>${c.title.replace(/&/g, "&amp;")}</span><span class="ibsg__t">${formatGuideTime(c.t)}</span></button></li>`,
          )
          .join("")}</ol>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  open = dlg;

  const video = dlg.querySelector("video")!;
  const chaps = Array.from(dlg.querySelectorAll<HTMLButtonElement>(".ibsg__chap"));
  const mark = (t: number) => {
    let idx = 0;
    g.chapters.forEach((c, i) => {
      if (t + 0.25 >= c.t) idx = i;
    });
    chaps.forEach((b, i) => {
      b.classList.toggle("is-active", i === idx);
      if (i === idx) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    });
  };
  let target = startAt; // last requested position, kept across the 720p fallback
  const seek = (t: number) => {
    target = t;
    mark(t);
    if (video.readyState >= 1) video.currentTime = t;
    else video.addEventListener("loadedmetadata", () => (video.currentTime = t), { once: true });
    void video.play().catch(() => {});
  };
  video.addEventListener("timeupdate", () => mark(video.currentTime));
  video.addEventListener("error", () => {
    if (video.src !== url("sd")) {
      const at = video.currentTime > 0.5 ? video.currentTime : target;
      video.src = url("sd");
      seek(at);
      return;
    }
    // Offline / blocked: hide the broken player and offer a retry or the web page.
    if (dlg.querySelector(".ibsg__err")) return;
    const resumeAt = video.currentTime;
    video.hidden = true;
    const err = document.createElement("div");
    err.className = "ibsg__err";
    err.setAttribute("role", "alert");
    err.innerHTML = `<span class="ibsg__err-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.8a15 15 0 0 1 20 0M5 12.6a10 10 0 0 1 14 0M8.5 16.2a5 5 0 0 1 7 0M12 20h.01"/><path d="M3 3l18 18"/></svg></span>
      <p class="ibsg__err-t">Can't load the video right now</p>
      <p class="ibsg__err-s">The setup guide streams from the internet. Check your connection and try again, or watch it in your browser.</p>
      <div class="ibsg__err-a"><button type="button" class="ibsg__err-b">Try again</button>
      <a class="ibsg__err-l" href="${g.pageUrl}" target="_blank" rel="noopener noreferrer">Watch on infinibotos.com</a></div>`;
    err.querySelector("button")?.addEventListener("click", () => {
      err.remove();
      dlg.querySelector(".ibsg__frame")?.classList.remove("is-offline");
      video.hidden = false;
      video.src = window.innerWidth < 900 ? url("sd") : url("hd");
      seek(resumeAt);
    });
    const frame = dlg.querySelector(".ibsg__frame");
    frame?.classList.add("is-offline");
    frame?.appendChild(err);
  });
  chaps.forEach((b) => b.addEventListener("click", () => seek(Number(b.dataset.t) || 0)));

  const close = () => dlg.close();
  dlg.querySelector(".ibsg__close")?.addEventListener("click", close);
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) close(); // backdrop
  });
  dlg.addEventListener("close", () => {
    video.pause();
    video.removeAttribute("src");
    video.load();
    dlg.remove();
    open = null;
  });

  dlg.showModal();
  seek(startAt);
}

/** "Watch the 6-min setup guide" button for setup screens. */
export function renderSetupGuideButton(opts: { startAt?: number; label?: string; className?: string } = {}): TemplateResult {
  const { startAt = 0, label = "Watch the 6-min setup guide", className = "" } = opts;
  return html`<button
    type="button"
    class="ibsg-btn ${className}"
    data-testid="setup-guide-video-btn"
    @click=${() => openSetupGuideVideo(startAt)}
  >
    <style>
      .ibsg-btn{display:inline-flex;align-items:center;gap:9px;padding:8px 14px 8px 8px;border-radius:999px;cursor:pointer;
        font:600 13px/1 var(--font-body,Manrope,Inter,system-ui,sans-serif);color:#fde68a;background:rgba(251,191,36,.08);
        border:1px solid rgba(251,191,36,.38);transition:background .18s ease,border-color .18s ease,transform .18s ease}
      .ibsg-btn:hover{background:rgba(251,191,36,.14);border-color:rgba(251,191,36,.6);transform:translateY(-1px)}
      .ibsg-btn:focus-visible{outline:2px solid #fbbf24;outline-offset:2px}
      .ibsg-btn__play{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;color:#120c00;
        background:radial-gradient(circle at 35% 30%,#fff3c4,#fbbf24 55%,#d97706)}
      .ibsg-btn__dur{font:500 11.5px/1 var(--font-mono,"JetBrains Mono",monospace);color:#a1a1aa}
    </style>
    <span class="ibsg-btn__play" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg></span>
    <span>${label}</span>
    ${startAt ? html`<span class="ibsg-btn__dur">${formatGuideTime(startAt)}</span>` : html`<span class="ibsg-btn__dur">${formatGuideTime(SETUP_GUIDE_VIDEO.durationSec)}</span>`}
  </button>`;
}
