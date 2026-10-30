/**
 * Hand a generated file (invoice PDF, replication snapshot JSON) to the OS:
 * share sheet on device, browser download on web. Same approach as the
 * Reports screen (expo-file-system File API + expo-sharing), no new deps.
 */
import { Platform, Share } from 'react-native';

let Sharing = null;
try { Sharing = require('expo-sharing'); } catch { Sharing = null; } // eslint-disable-line global-require
let FS = null;
try { FS = require('expo-file-system'); } catch { FS = null; } // eslint-disable-line global-require

function b64ToBytes(b64) {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function safeFileName(name, ext) {
  const base = String(name || 'file').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'file';
  return `${base}.${ext}`;
}

/** `bytes` is a Uint8Array; pass `base64` or `text` instead for convenience. */
export async function shareFile({ base64, text, name, mime, uti }) {
  const bytes = base64 ? b64ToBytes(base64) : new TextEncoder().encode(String(text ?? ''));
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return 'downloaded';
  }
  if (!FS?.File || !FS?.Paths) throw new Error('File access is unavailable in this build.');
  const file = new FS.File(FS.Paths.cache, name);
  try { if (file.exists) file.delete(); } catch { /* stale */ }
  file.create();
  file.writeSync(bytes);
  if (Sharing && (await Sharing.isAvailableAsync())) {
    await Sharing.shareAsync(file.uri, { mimeType: mime, UTI: uti, dialogTitle: name });
    return 'shared';
  }
  await Share.share({ url: file.uri, title: name });
  return 'shared';
}
