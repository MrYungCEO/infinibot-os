/**
 * voice-client — the phone's side of a LOCAL InfiniBot voice call.
 *
 * Same protocol as the web Voice page's local engine
 * (ui/src/ui/views/voice-robovoice/local-call-session.ts), no fork:
 *
 *   recorded utterance ─▶ POST /api/voice/stt   local Whisper (multipart "file")
 *                      ─▶ POST /api/voice/turn  SSE {delta}… {done,text,updates,timings} | {error}
 *                                               (the gateway's voice-turn seam: direct CLI
 *                                               routing or the selected gateway agent)
 *   reply sentences    ─▶ POST /api/voice/tts   local Kokoro → mp3
 *
 * Every route is a protected gateway HTTP route: the active connection
 * profile's credential rides as `Authorization: Bearer …`.
 *
 * The SSE stream is read with XMLHttpRequest progress events, which stream on
 * React Native (fetch has no readable body there) and in browsers alike.
 */

import { Platform } from 'react-native';
import { gatewayHttpOrigin } from '../utils/gatewayHost';
import { getGatewayAuthHeaders, getGatewayUrl } from '../utils/storage';

/** Resolve the gateway HTTP origin + auth headers once per request. */
export async function gatewayHttp() {
  const [url, headers] = await Promise.all([getGatewayUrl(), getGatewayAuthHeaders()]);
  let base = gatewayHttpOrigin(url);
  // The web export served by the gateway itself (/mobile-web) may run with a
  // relative or empty gateway URL: fall back to the page origin.
  if (!base && Platform.OS === 'web' && typeof window !== 'undefined') base = window.location.origin;
  if (!base) throw new Error('No gateway configured — set one in Settings › Connections.');
  return { base, headers: headers || {} };
}

/**
 * Incremental SSE parser: feed it raw text chunks, it calls `onEvent` with
 * each parsed `data: {json}` payload. Partial lines wait for the next chunk.
 */
export function createSseParser(onEvent) {
  let pending = '';
  return (chunk) => {
    pending += chunk;
    let cut;
    while ((cut = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, cut);
      pending = pending.slice(cut + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch {
          /* partial / foreign line */
        }
      }
    }
  };
}

/** Sentence chunker for streamed reply text: returns [readyPieces, rest]. */
export function takeSentences(buffer, { minChars = 12, maxChars = 220 } = {}) {
  const out = [];
  let rest = buffer;
  for (;;) {
    const m = rest.match(/[.!?…](?:["')\]]*)\s+|\n+/);
    if (m && m.index !== undefined && m.index + m[0].length >= minChars) {
      const end = m.index + m[0].length;
      out.push(rest.slice(0, end).trim());
      rest = rest.slice(end);
      continue;
    }
    if (rest.length > maxChars) {
      const space = rest.lastIndexOf(' ', maxChars);
      const end = space > minChars ? space : maxChars;
      out.push(rest.slice(0, end).trim());
      rest = rest.slice(end);
      continue;
    }
    break;
  }
  return [out.filter(Boolean), rest];
}

/**
 * POST /api/voice/turn and stream its SSE events.
 * @returns {{ promise: Promise<void>, abort: () => void }}
 */
export function streamVoiceTurn(http, body, onEvent, { xhrFactory } = {}) {
  const xhr = xhrFactory ? xhrFactory() : new XMLHttpRequest();
  let seen = 0;
  const parse = createSseParser(onEvent);
  const pump = () => {
    const text = xhr.responseText || '';
    if (text.length > seen) {
      parse(text.slice(seen));
      seen = text.length;
    }
  };
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', `${http.base}/api/voice/turn`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Accept', 'text/event-stream');
    for (const [k, v] of Object.entries(http.headers || {})) xhr.setRequestHeader(k, v);
    xhr.onprogress = pump;
    xhr.onload = () => {
      pump();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let msg = `voice turn HTTP ${xhr.status}`;
        try {
          msg = errorText(JSON.parse(xhr.responseText), msg);
        } catch {
          /* not JSON */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Network error — is the gateway reachable?'));
    xhr.onabort = () => reject(Object.assign(new Error('aborted'), { aborted: true }));
    xhr.send(JSON.stringify(body));
  });
  return { promise, abort: () => xhr.abort() };
}

/**
 * A readable message from a gateway / Speaches error body: `{error: "…"}`,
 * `{error: {message, type}}` (gateway auth) or `{detail: "…"}` (Speaches).
 */
export function errorText(data, fallback) {
  if (!data) return fallback;
  const e = data.error ?? data.detail;
  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object') {
    const m = e.message || e.reason || e.type;
    if (m) return e.type === 'unauthorized' || /unauthori[sz]ed/i.test(m) ? `401 Unauthorized (${e.reason || m})` : String(m);
  }
  return fallback;
}

/**
 * Speech-to-text of one recorded utterance (local Whisper through the gateway).
 * @param {{uri: string, mimeType?: string}} clip  file:// (native) or blob: (web) URI
 */
export async function transcribeClip(http, clip, { signal } = {}) {
  const form = new FormData();
  const mime = clip.mimeType || (Platform.OS === 'web' ? 'audio/webm' : 'audio/m4a');
  const ext = /webm/.test(mime) ? 'webm' : /wav/.test(mime) ? 'wav' : /ogg/.test(mime) ? 'ogg' : 'm4a';
  if (Platform.OS === 'web') {
    const blob = clip.blob || (await (await fetch(clip.uri)).blob());
    form.append('file', blob, `utterance.${ext}`);
  } else {
    form.append('file', { uri: clip.uri, name: `utterance.${ext}`, type: mime });
  }
  form.append('response_format', 'json');
  const url = `${http.base}/api/voice/stt`;
  // Native: the global fetch is expo/fetch, which rejects RN-style { uri } parts
  // ("Unsupported FormDataPart implementation"). RN's XHR still uploads them.
  const { status, data } =
    Platform.OS === 'web' ? await postFormFetch(url, http.headers, form, signal) : await postFormXhr(url, http.headers, form, signal);
  if (status < 200 || status >= 300) throw new Error(errorText(data, `speech-to-text HTTP ${status}`));
  return typeof data?.text === 'string' ? data.text.trim() : '';
}

async function postFormFetch(url, headers, form, signal) {
  const res = await fetch(url, { method: 'POST', headers, body: form, signal });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function postFormXhr(url, headers, form, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error('Network error — is the gateway reachable?'));
    xhr.onabort = () => reject(Object.assign(new Error('aborted'), { aborted: true }));
    if (signal) {
      if (signal.aborted) return xhr.abort();
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
}

let ttsSeq = 0;

/** Text-to-speech (local Kokoro) → a URI an expo-audio player can play. */
export async function synthesize(http, text, { signal } = {}) {
  const res = await fetch(`${http.base}/api/voice/tts`, {
    method: 'POST',
    headers: { ...http.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, response_format: 'mp3' }),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(errorText(data, `text-to-speech HTTP ${res.status}`));
  }
  if (Platform.OS === 'web') return URL.createObjectURL(await res.blob());
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { File, Paths } = require('expo-file-system');
  ttsSeq = (ttsSeq + 1) % 32; // a small ring of files, reused
  const file = new File(Paths.cache, `infini-tts-${ttsSeq}.mp3`);
  file.create({ overwrite: true });
  file.writeSync(bytes);
  return file.uri;
}

/** Free a synthesized clip URI (web blob URLs). */
export function releaseClip(uri) {
  if (Platform.OS === 'web' && typeof uri === 'string' && uri.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(uri);
    } catch {
      /* fine */
    }
  }
}

/** Delete a finished recording (native clip files pile up in the cache otherwise). */
export function deleteClipFile(uri) {
  if (!uri) return;
  if (Platform.OS === 'web') return releaseClip(uri);
  try {
    // eslint-disable-next-line global-require
    const { File } = require('expo-file-system');
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    /* best effort */
  }
}

/** Whisper's stock hallucinations on breath / silence (same list as the web engine). */
export const NOISE = /^(?:you|thank you\.?|thanks for watching!?|\.+|bye\.?|uh+|um+|hmm+)$/i;

export function newCallKey() {
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
