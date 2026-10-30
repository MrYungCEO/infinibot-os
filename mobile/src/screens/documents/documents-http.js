// documents-http — the binary half of the Documents workspace (uploads,
// original files), mirroring ui/src/ui/views/documents/api.ts. Metadata goes
// over WS RPCs; bytes go over the gateway's HTTP routes with the same
// credential the rest of the app uses (getGatewayAuthHeaders) plus a
// short-lived documents.ticket that scopes the request to the right workspace.

import { Platform, Share } from 'react-native';
import { getGatewayAuthHeaders, getGatewayUrl } from '../../utils/storage';
import { gatewayHttpOrigin } from '../../utils/gatewayHost';
import { exportFileName, fileUrl, uploadQuery } from './documents-model';

const TICKET_REFRESH_MS = 60 * 60_000;
let ticketCache = null; // { value, at, key }

export async function httpBase() {
  const ws = await getGatewayUrl();
  const base = gatewayHttpOrigin(ws);
  if (!base) throw new Error('No gateway URL set');
  return base;
}

export async function getTicket(sendReq) {
  const base = await httpBase();
  if (ticketCache && ticketCache.key === base && Date.now() - ticketCache.at < TICKET_REFRESH_MS) return ticketCache.value;
  const r = await sendReq('documents.ticket', {});
  if (!r || !r.ticket) throw new Error('No documents ticket');
  ticketCache = { value: r.ticket, at: Date.now(), key: base };
  return r.ticket;
}

/** { uri, headers } for an <Image> of a file node (inline preview). */
export async function fileSource(sendReq, id) {
  const [base, ticket, headers] = await Promise.all([httpBase(), getTicket(sendReq), getGatewayAuthHeaders()]);
  return { uri: fileUrl(base, id, ticket), headers };
}

/** Upload one image-picker asset into `parentId`. Returns the gateway's JSON ({ node }). */
export async function uploadAsset(sendReq, asset, { parentId, name, maxBytes }) {
  if (maxBytes && asset.fileSize && asset.fileSize > maxBytes) {
    throw new Error(`File too large (limit ${Math.round(maxBytes / (1024 * 1024))} MB)`);
  }
  const [base, ticket, headers] = await Promise.all([httpBase(), getTicket(sendReq), getGatewayAuthHeaders()]);
  const blob = await (await fetch(asset.uri)).blob();
  const res = await fetch(`${base}/api/documents/upload?${uploadQuery({ name, ticket, parentId })}`, {
    method: 'POST',
    body: blob,
    headers: { ...headers, 'Content-Type': asset.mimeType || blob.type || 'application/octet-stream' },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = { ok: false, error: `HTTP ${res.status}` };
  }
  if (!res.ok || (json && json.ok === false)) throw new Error((json && json.error) || `Upload failed (HTTP ${res.status})`);
  return json;
}

/** Download a file node's original and hand it to the share sheet (web: browser download). */
export async function shareOriginal(sendReq, node) {
  const [base, ticket, headers] = await Promise.all([httpBase(), getTicket(sendReq), getGatewayAuthHeaders()]);
  const url = fileUrl(base, node.id, ticket, true);
  const name = (node.file && node.file.name) || exportFileName(node.title, 'bin');
  if (Platform.OS === 'web') {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
    const blobUrl = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    return 'downloaded';
  }
  const FS = require('expo-file-system');
  const Sharing = require('expo-sharing');
  const dest = new FS.File(FS.Paths.cache, name);
  try {
    if (dest.exists) dest.delete();
  } catch {
    /* stale cache entry */
  }
  const file = await FS.File.downloadFileAsync(url, dest, { headers });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, { mimeType: (node.file && node.file.mime) || undefined, dialogTitle: node.title });
    return 'shared';
  }
  await Share.share({ url: file.uri, title: node.title });
  return 'shared';
}

/** Export a doc's markdown (share sheet on device, a .md download on web). */
export async function shareMarkdown(title, markdown) {
  const name = exportFileName(title, 'md');
  if (Platform.OS === 'web') {
    const blobUrl = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    return 'downloaded';
  }
  try {
    const FS = require('expo-file-system');
    const Sharing = require('expo-sharing');
    const file = new FS.File(FS.Paths.cache, name);
    try {
      if (file.exists) file.delete();
    } catch {
      /* stale */
    }
    file.create();
    file.writeSync(markdown);
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(file.uri, { mimeType: 'text/markdown', UTI: 'net.daringfireball.markdown', dialogTitle: title });
      return 'shared';
    }
  } catch {
    /* fall back to plain-text share */
  }
  await Share.share({ message: markdown, title });
  return 'shared';
}
