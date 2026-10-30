/**
 * /glasses/live — browser-based glasses client.
 *
 * A self-contained, mobile-first web app the user opens on their phone
 * (typically by scanning the QR code in the Glasses panel). Skips the
 * native iOS/Android build entirely:
 *   - getUserMedia for camera + mic
 *   - Web Speech API for live speech-to-text (free, on-device)
 *   - SpeechSynthesis for text-to-speech response
 *   - Camera frame capture per request, sent as base64 image content
 *   - POST to /v1/chat/completions with multimodal payload
 *
 * Token comes from the URL query (?t=...) so the QR pairs in one scan.
 * The page lives behind the gateway's normal cross-origin defaults; no
 * separate auth screen.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendMethodNotAllowed } from "./http-common.js";

const ROUTE = "/glasses/live";

export async function handleGlassesLiveRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== ROUTE) return false;

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(buildHtml());
  return true;
}

function buildHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<meta name="theme-color" content="#000000" />
<title>InfiniBot Glasses</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; height: 100%; background: #000; color: #fff; font-family: -apple-system, system-ui, "Segoe UI", sans-serif; overflow: hidden; }
  body { display: flex; flex-direction: column; }
  #cam {
    position: fixed; inset: 0; width: 100%; height: 100%;
    object-fit: cover;
    background: #000;
    transform: scaleX(-1); /* selfie-mirror by default; user can flip via "Cam" button */
  }
  #overlay {
    position: fixed; inset: 0;
    background: linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.15) 30%, rgba(0,0,0,0.15) 70%, rgba(0,0,0,0.85) 100%);
    pointer-events: none;
  }
  #setup {
    position: fixed; inset: 0;
    background: #050510;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 24px; gap: 16px; z-index: 30;
    text-align: center;
  }
  #setup h1 { font-size: 28px; margin: 0; letter-spacing: -0.02em; }
  #setup p { color: #a1a1aa; font-size: 14px; margin: 0; max-width: 320px; line-height: 1.5; }
  #setup button {
    padding: 14px 28px;
    background: linear-gradient(135deg, #facc15, #fde047);
    color: #0a0a0a; border: none;
    border-radius: 999px;
    font-size: 16px; font-weight: 700;
    cursor: pointer;
    box-shadow: 0 8px 24px rgba(250,204,21,0.4);
  }
  #setup .err {
    color: #fca5a5; font-size: 13px;
    padding: 10px 14px;
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.3);
    border-radius: 8px;
    max-width: 320px;
  }
  #app {
    position: fixed; inset: 0;
    display: none; flex-direction: column;
    z-index: 20;
  }
  #app.on { display: flex; }
  #status {
    padding: 14px 18px;
    color: #facc15;
    font-size: 14px; font-weight: 600;
    letter-spacing: 0.04em;
    text-shadow: 0 1px 4px rgba(0,0,0,0.8);
  }
  #transcript {
    flex: 1;
    padding: 8px 18px 24px;
    overflow-y: auto;
    display: flex; flex-direction: column-reverse;
    gap: 12px;
  }
  .turn { padding: 12px 14px; border-radius: 14px; max-width: 85%; line-height: 1.4; font-size: 15px; backdrop-filter: blur(14px); }
  .turn.user { background: rgba(250,204,21,0.18); border: 1px solid rgba(250,204,21,0.35); align-self: flex-end; color: #fef3c7; }
  .turn.ai { background: rgba(8,8,16,0.7); border: 1px solid rgba(255,255,255,0.1); align-self: flex-start; color: #e4e4e7; }
  .turn.thinking { font-style: italic; color: #a1a1aa; }
  #controls {
    padding: 18px 18px calc(18px + env(safe-area-inset-bottom, 0px));
    display: flex; align-items: center; justify-content: center; gap: 18px;
  }
  #ptt {
    width: 96px; height: 96px;
    border-radius: 50%;
    background: linear-gradient(135deg, #facc15, #f97316);
    border: 4px solid rgba(255,255,255,0.2);
    color: #0a0a0a;
    font-size: 28px; font-weight: 700;
    cursor: pointer;
    box-shadow: 0 12px 32px rgba(250,204,21,0.5);
    user-select: none;
    touch-action: manipulation;
    display: flex; align-items: center; justify-content: center;
    transition: transform 0.1s, box-shadow 0.1s;
  }
  #ptt:active, #ptt.live {
    transform: scale(0.94);
    box-shadow: 0 0 0 6px rgba(250,204,21,0.3), 0 12px 32px rgba(250,204,21,0.7);
  }
  .iconbtn {
    width: 48px; height: 48px;
    border-radius: 50%;
    background: rgba(8,8,16,0.7);
    border: 1px solid rgba(255,255,255,0.15);
    color: #e4e4e7;
    font-size: 12px; font-weight: 600;
    cursor: pointer;
    backdrop-filter: blur(14px);
    display: flex; align-items: center; justify-content: center;
  }
  .iconbtn:active { background: rgba(8,8,16,0.85); }
  .hint {
    position: absolute; bottom: 130px; left: 0; right: 0;
    text-align: center;
    color: rgba(255,255,255,0.5);
    font-size: 12px; letter-spacing: 0.04em;
    pointer-events: none;
  }
  @media (orientation: landscape) {
    #ptt { width: 80px; height: 80px; }
  }
</style>
</head>
<body>
<video id="cam" playsinline autoplay muted></video>
<div id="overlay"></div>

<div id="setup">
  <h1>InfiniBot Glasses</h1>
  <p>Push to talk. The camera frame and your voice go to InfiniBot. Reply is spoken back.</p>
  <div class="err" id="setupErr" style="display:none"></div>
  <button id="startBtn">Start session</button>
  <p style="font-size:11px;color:#52525b">Token from URL ${(/* embedded for clarity */ "")}</p>
</div>

<div id="app">
  <div id="status">Idle — hold the button to talk.</div>
  <div id="transcript"></div>
  <div class="hint">Hold to talk · Release to send</div>
  <div id="controls">
    <button class="iconbtn" id="flipCam" title="Flip camera">FLIP</button>
    <button id="ptt">TALK</button>
    <button class="iconbtn" id="mute" title="Mute response speech">SPK</button>
  </div>
</div>

<script>
  const params = new URLSearchParams(location.search);
  const TOKEN = params.get("t") || params.get("token") || "";
  const AGENT = params.get("agent") || "visionclaw";
  const ENDPOINT = "/v1/chat/completions";

  const elCam       = document.getElementById("cam");
  const elSetup     = document.getElementById("setup");
  const elSetupErr  = document.getElementById("setupErr");
  const elStartBtn  = document.getElementById("startBtn");
  const elApp       = document.getElementById("app");
  const elStatus    = document.getElementById("status");
  const elTranscript= document.getElementById("transcript");
  const elPtt       = document.getElementById("ptt");
  const elFlip      = document.getElementById("flipCam");
  const elMute      = document.getElementById("mute");

  let stream = null;
  let facing = "environment"; // "user" | "environment"
  let muted = false;
  let recognition = null;
  let liveTranscript = "";
  let recording = false;

  function showErr(msg) { elSetupErr.style.display = "block"; elSetupErr.textContent = msg; }

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      elCam.srcObject = stream;
      // Selfie-mirror only for front camera.
      elCam.style.transform = facing === "user" ? "scaleX(-1)" : "scaleX(1)";
      return true;
    } catch (e) { showErr("Camera permission denied: " + e.message); return false; }
  }

  function setupRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { showErr("Speech recognition not supported. Use Safari (iOS 14.5+) or Chrome."); return false; }
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (e) => {
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t + " ";
        else liveTranscript = t;
      }
      if (final) liveTranscript = (liveTranscript + " " + final).trim();
      elStatus.textContent = "Listening… " + liveTranscript;
    };
    recognition.onerror = (e) => { elStatus.textContent = "Mic error: " + e.error; };
    recognition.onend = () => { if (recording) try { recognition.start(); } catch (_) {} };
    return true;
  }

  elStartBtn.addEventListener("click", async () => {
    if (!TOKEN) return showErr("No token in URL — re-scan QR from the InfiniBot Glasses panel.");
    const okCam = await startCamera();
    if (!okCam) return;
    if (!setupRecognition()) return;
    elSetup.style.display = "none";
    elApp.classList.add("on");
  });

  elFlip.addEventListener("click", async () => {
    facing = facing === "user" ? "environment" : "user";
    if (stream) stream.getTracks().forEach((t) => t.stop());
    await startCamera();
  });

  elMute.addEventListener("click", () => {
    muted = !muted;
    elMute.style.background = muted ? "rgba(239,68,68,0.3)" : "rgba(8,8,16,0.7)";
    if (muted) speechSynthesis.cancel();
  });

  function snapFrameDataUrl() {
    const w = elCam.videoWidth; const h = elCam.videoHeight;
    if (!w || !h) return null;
    const c = document.createElement("canvas");
    // Downscale to ~640px wide to keep payload small.
    const scale = Math.min(1, 640 / w);
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const ctx = c.getContext("2d");
    if (facing === "user") {
      ctx.translate(c.width, 0); ctx.scale(-1, 1);
    }
    ctx.drawImage(elCam, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7);
  }

  function appendTurn(role, text, klass) {
    const div = document.createElement("div");
    div.className = "turn " + role + (klass ? " " + klass : "");
    div.textContent = text;
    elTranscript.prepend(div);
  }

  function speak(text) {
    if (muted || !text) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05; u.pitch = 1.0; u.volume = 1.0;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (_) {}
  }

  async function send(prompt, frame) {
    elStatus.textContent = "Thinking…";
    appendTurn("user", prompt);
    const thinking = document.createElement("div");
    thinking.className = "turn ai thinking";
    thinking.textContent = "…";
    elTranscript.prepend(thinking);
    try {
      // Multimodal content: text + image (when we have a frame).
      const userContent = frame
        ? [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: frame } },
          ]
        : prompt;
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + TOKEN,
        },
        body: JSON.stringify({
          model: AGENT,
          messages: [{ role: "user", content: userContent }],
        }),
      });
      const body = await res.json();
      thinking.remove();
      if (!res.ok) {
        const msg = (body && body.error && body.error.message) ? body.error.message : ("HTTP " + res.status);
        appendTurn("ai", "Error: " + msg);
        elStatus.textContent = "Error: " + msg;
        return;
      }
      const reply = body?.choices?.[0]?.message?.content ?? "(no response)";
      appendTurn("ai", reply);
      speak(reply);
      elStatus.textContent = "Idle — hold the button to talk.";
    } catch (e) {
      thinking.remove();
      appendTurn("ai", "Network error: " + e.message);
      elStatus.textContent = "Network error.";
    }
  }

  function startRec() {
    if (recording) return;
    recording = true;
    liveTranscript = "";
    elPtt.classList.add("live");
    elStatus.textContent = "Listening…";
    try { recognition.start(); } catch (_) {}
  }

  function endRec() {
    if (!recording) return;
    recording = false;
    elPtt.classList.remove("live");
    try { recognition.stop(); } catch (_) {}
    const text = liveTranscript.trim();
    if (!text) { elStatus.textContent = "Didn't hear anything — try again."; return; }
    const frame = snapFrameDataUrl();
    send(text, frame);
  }

  // Push-to-talk: pointerdown/up + touch fallbacks.
  elPtt.addEventListener("pointerdown", (e) => { e.preventDefault(); startRec(); });
  elPtt.addEventListener("pointerup",   (e) => { e.preventDefault(); endRec(); });
  elPtt.addEventListener("pointercancel", endRec);
  elPtt.addEventListener("pointerleave", endRec);
</script>
</body>
</html>`;
}
