/**
 * TTS Button Component - Speak agent responses through Robovoice
 *
 * Features:
 * - Click to play / pause / resume (robovoice.speech.tts, charged per reply)
 * - Right-click for the Robovoice voice picker (the org's real catalog)
 * - Visual feedback during playback; a "Connect Robovoice" / "Wallet empty —
 *   top up" hint when speaking isn't possible
 */

import { html, type TemplateResult } from "lit";
import { icons } from "../icons";
import {
  speakText,
  stopTTS,
  pauseTTS,
  resumeTTS,
  getMessageState,
  isMessagePlaying,
  isMessagePaused,
  onPlaybackChange,
  getTTSSettings,
  saveTTSSettings,
  getTTSCatalog,
  TtsUnavailableError,
} from "../controllers/tts";

const SPEAK_LABEL = "Speak aloud (Robovoice)";
const PAUSE_LABEL = "Pause";
const RESUME_LABEL = "Resume";
const ERROR_LABEL = "Robovoice read-aloud failed";
const ERROR_FOR_MS = 4000;

const mountedButtons = new Set<HTMLButtonElement>();

onPlaybackChange(() => {
  mountedButtons.forEach(btn => updateButtonState(btn));
});

function updateButtonState(btn: HTMLButtonElement) {
  const messageId = btn.dataset.messageId || '';
  const state = getMessageState(messageId);
  const playing = state === 'playing';
  const paused = state === 'paused';

  btn.dataset.playing = playing ? '1' : '';
  btn.dataset.paused = paused ? '1' : '';
  if (btn.dataset.error === '1') return;
  const label = playing ? PAUSE_LABEL : paused ? RESUME_LABEL : SPEAK_LABEL;
  btn.title = label;
  btn.setAttribute('aria-label', label);

  const playIcon = btn.querySelector('.tts-btn__icon-play') as HTMLElement;
  const pauseIcon = btn.querySelector('.tts-btn__icon-pause') as HTMLElement;
  if (playIcon) playIcon.style.display = playing ? 'none' : 'inline';
  if (pauseIcon) pauseIcon.style.display = playing ? 'inline' : 'none';
}

const esc = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function openRobovoicePage() {
  const app = document.querySelector("infinibot-app") as unknown as { setTab?: (t: string) => void } | null;
  app?.setTab?.("robovoice");
}

function placeMenu(menu: HTMLElement, event: MouseEvent) {
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 10}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 10}px`;
}

async function showContextMenu(event: MouseEvent, _text: string, messageId: string) {
  event.preventDefault();
  document.querySelector('.tts-context-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'tts-context-menu';
  menu.innerHTML = `<div class="tts-menu-header"><span class="tts-menu-title">Robovoice voice</span></div>
    <div class="tts-menu-section"><div class="tts-menu-category">Loading your Robovoice voices…</div></div>`;
  document.body.appendChild(menu);
  placeMenu(menu, event);

  const close = () => {
    menu.remove();
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKeyDown);
  };
  const onDocClick = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) close(); };
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
  document.addEventListener('keydown', onKeyDown);

  const stopRow = getMessageState(messageId) !== 'stopped'
    ? `<div class="tts-menu-divider"></div><button class="tts-menu-action tts-stop-btn">Stop playback</button>`
    : '';

  let body: string;
  try {
    const cat = await getTTSCatalog();
    const cur = getTTSSettings();
    if (cat.wallet.empty) {
      body = `<div class="tts-menu-section"><div class="tts-menu-category">Cloud voice is busy — switch to local voice on the Voice page.</div></div>`;
    } else if (!cat.tts.length) {
      body = `<div class="tts-menu-section"><div class="tts-menu-category">No text-to-speech provider on this Robovoice org.</div></div>`;
    } else {
      body = cat.tts.map((p) => {
        const models = p.models.length
          ? `<div class="tts-menu-category">${esc(p.label)} · model</div>` + p.models.map((m) => {
              const sel = p.id === cur.ttsProvider && m.id === cur.ttsModel;
              return `<button class="tts-voice-option ${sel ? 'selected' : ''}" data-provider="${esc(p.id)}" data-model="${esc(m.id)}">${esc(m.name)}${sel ? ' ✓' : ''}</button>`;
            }).join('')
          : '';
        const voices = p.voices.map((v) => {
          const sel = p.id === cur.ttsProvider && v.id === cur.ttsVoice;
          return `<button class="tts-voice-option ${sel ? 'selected' : ''}" data-provider="${esc(p.id)}" data-voice="${esc(v.id)}">${esc(v.name)}${sel ? ' ✓' : ''}</button>`;
        }).join('');
        return `<div class="tts-menu-section">${models}<div class="tts-menu-category">${esc(p.label)} · voice</div>${voices}</div>`;
      }).join('');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const connect = e instanceof TtsUnavailableError && e.reason === 'connect';
    body = `<div class="tts-menu-section"><div class="tts-menu-category">${esc(msg)}</div>
      ${connect ? '<button class="tts-menu-action tts-connect-btn">Connect Robovoice</button>' : ''}</div>`;
  }
  if (!menu.isConnected) return;
  menu.innerHTML = `<div class="tts-menu-header"><span class="tts-menu-title">Robovoice voice</span></div>${body}${stopRow}`;
  placeMenu(menu, event);

  menu.querySelectorAll<HTMLElement>('.tts-voice-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cur = getTTSSettings();
      const provider = btn.dataset.provider ?? null;
      const same = provider === cur.ttsProvider;
      if (btn.dataset.voice) {
        saveTTSSettings({ ttsProvider: provider, ttsVoice: btn.dataset.voice, ttsModel: same ? cur.ttsModel : null });
      } else if (btn.dataset.model) {
        saveTTSSettings({ ttsProvider: provider, ttsModel: btn.dataset.model, ttsVoice: same ? cur.ttsVoice : null });
      }
      close();
    });
  });
  menu.querySelector('.tts-connect-btn')?.addEventListener('click', () => { openRobovoicePage(); close(); });
  menu.querySelector('.tts-stop-btn')?.addEventListener('click', () => { stopTTS(messageId); close(); });
}

export function renderTTSButton(text: string, messageId: string): TemplateResult {
  return html`
    <button
      class="chat-tts-btn"
      type="button"
      title=${SPEAK_LABEL}
      aria-label=${SPEAK_LABEL}
      data-message-id=${messageId}
      @click=${async (e: Event) => {
        const btn = e.currentTarget as HTMLButtonElement;
        if (btn.dataset.loading === '1') return;

        if (isMessagePlaying(messageId)) {
          pauseTTS(messageId);
          return;
        }
        if (isMessagePaused(messageId)) {
          await resumeTTS(messageId);
          return;
        }

        btn.dataset.loading = '1';
        btn.disabled = true;

        try {
          await speakText(text, messageId);
        } catch (err) {
          console.error('[TTS] Error:', err);
          btn.dataset.error = '1';
          btn.title = err instanceof TtsUnavailableError ? err.message : ERROR_LABEL;

          setTimeout(() => {
            if (!btn.isConnected) return;
            delete btn.dataset.error;
            updateButtonState(btn);
          }, ERROR_FOR_MS);
        } finally {
          delete btn.dataset.loading;
          btn.disabled = false;
        }
      }}
      @contextmenu=${(e: MouseEvent) => void showContextMenu(e, text, messageId)}
      @connectedCallback=${(e: Event) => {
        const btn = e.target as HTMLButtonElement;
        mountedButtons.add(btn);
      }}
      @disconnectedCallback=${(e: Event) => {
        const btn = e.target as HTMLButtonElement;
        mountedButtons.delete(btn);
      }}
    >
      <span class="tts-btn__icon" aria-hidden="true">
        <span class="tts-btn__icon-play">${icons.volumeUp || '🔊'}</span>
        <span class="tts-btn__icon-pause" style="display:none">${icons.pause || '⏸'}</span>
      </span>
    </button>
  `;
}
