/* Satellite status window (renderer). Data: window.satellite (preload). */
const $ = (id) => document.getElementById(id);
const STATE_TEXT = {
  connected: 'Connected',
  connecting: 'Connecting',
  registering: 'Joining',
  reconnecting: 'Reconnecting',
  disconnected: 'Offline',
  stopped: 'Disconnected',
};
const FEATURES = [
  ['terminal', 'Terminal'],
  ['exec', 'Run commands'],
  ['screenshot', 'Screenshot'],
  ['input', 'Mouse & keyboard'],
  ['files', 'Files'],
  ['browser', 'Browser'],
  ['voice', 'Local voice'],
];
let last = null;

function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ts).toLocaleString();
}

function render(p) {
  last = p;
  const st = p?.status || null;
  const state = st?.state || (p?.running ? 'connecting' : 'stopped');
  $('state-pill').dataset.state = state;
  $('state-text').textContent = STATE_TEXT[state] || state;
  $('headline').textContent = p?.text || 'This device · satellite';
  const prob = $('problem');
  prob.textContent = p?.problem || '';
  prob.classList.toggle('show', Boolean(p?.problem));
  $('f-master').textContent = st?.masterUrl || p?.masterUrl || '—';
  $('f-latency').textContent = typeof st?.latencyMs === 'number' ? `${st.latencyMs} ms` : '—';
  $('f-since').textContent = st?.connectedAt ? new Date(st.connectedAt).toLocaleString() : '—';
  $('f-heartbeat').textContent = ago(st?.lastHeartbeatAck);
  $('f-pairing').textContent = !st
    ? '—'
    : st.credentialKind === 'device'
      ? `Paired · device key ${st.credentialFingerprint} · ${st.permissionLevel} access`
      : st.credentialKind === 'invite'
        ? 'Joining with invite…'
        : 'Not paired';
  $('f-node').textContent = st?.nodeId || '—';
  const d = st?.device;
  $('d-name').textContent = st?.nodeName || d?.hostname || '—';
  $('d-os').textContent = d ? `${d.os.type} ${d.os.release} (${d.os.arch}) · ${d.hostname}` : '—';
  $('d-cpu').textContent = d ? `${d.cpu.model} · ${d.cpu.cores} threads` : '—';
  $('d-mem').textContent = d ? `${(d.memoryMB / 1024).toFixed(1)} GB` : '—';
  $('d-gpu').textContent = d?.gpu?.name || '—';
  const caps = $('caps');
  caps.replaceChildren(
    ...FEATURES.map(([k, label]) => {
      const el = document.createElement('span');
      el.className = 'cap' + (d?.features?.[k] ? '' : ' off');
      el.textContent = label;
      return el;
    }),
  );
  $('clis').textContent = d?.clis?.length ? `Coding CLIs on this device: ${d.clis.join(', ')}` : 'No coding CLIs (claude, codex, gemini, grok, opencode) found on this device.';
  $('b-toggle').textContent = p?.running ? 'Disconnect' : 'Connect';
  $('b-open').disabled = state !== 'connected';
}

async function act(btn, fn, okMsg) {
  btn.disabled = true;
  $('msg').textContent = '';
  try {
    const r = await fn();
    if (r && r.ok === false && !r.cancelled) $('msg').textContent = r.error || 'That did not work.';
    else if (okMsg) $('msg').textContent = okMsg;
  } finally {
    btn.disabled = false;
    render(await window.satellite.getStatus());
  }
}

$('b-open').addEventListener('click', (e) => act(e.currentTarget, () => window.satellite.openMasterUi()));
$('b-reconnect').addEventListener('click', (e) => act(e.currentTarget, () => window.satellite.reconnect(), 'Reconnecting…'));
$('b-toggle').addEventListener('click', (e) =>
  act(e.currentTarget, () => (last?.running ? window.satellite.disconnect() : window.satellite.connect())),
);
$('b-leave').addEventListener('click', (e) => act(e.currentTarget, () => window.satellite.leave()));

window.satellite.onStatus(render);
window.satellite.getStatus().then(render);
setInterval(() => last && render(last), 5000);
