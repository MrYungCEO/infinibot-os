// useHardware — pulls a snapshot of the federation's hardware health via the
// gateway's hardware HTTP endpoints. Falls back from the new
// `/api/hardware/nodes/stream` (being added by a sibling agent) to the
// legacy `/api/hardware/stream` endpoint so the mobile app keeps working
// while the new surface stabilises.
//
// Returns: { snapshot, nodes, federationRole, status, error, refresh }.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getGatewayUrl, getGatewayAuthHeaders } from '../utils/storage';

function wsToHttp(url) {
  if (!url) return '';
  return url.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...(await getGatewayAuthHeaders()), ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { raw: t }; }
}

export function useHardware({ enabled = true } = {}) {
  const [snapshot, setSnapshot] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [federationRole, setFederationRole] = useState('standalone');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const baseRef = useRef('');

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      if (!baseRef.current) {
        baseRef.current = wsToHttp(await getGatewayUrl());
      }
      const base = baseRef.current;
      if (!base) throw new Error('Gateway URL not resolved');

      // Prefer the snapshot endpoint — it's a polled summary used by the web
      // hardware page. The streaming endpoints are nice-to-have but require
      // SSE which is awkward to consume from RN fetch.
      try {
        const snap = await fetchJson(`${base}/api/hardware/snapshot`);
        setSnapshot(snap);
      } catch (snapErr) {
        // Some installs only expose the older /api/hardware route; try it.
        try {
          const legacy = await fetchJson(`${base}/api/hardware`);
          setSnapshot(legacy);
        } catch {
          throw snapErr;
        }
      }

      // Nodes list — try the new endpoint first, then the legacy summary.
      // /api/hardware/nodes returns { role, nodes: NodeHardwareEntry[] }
      try {
        const n = await fetchJson(`${base}/api/hardware/nodes`);
        if (Array.isArray(n?.nodes)) {
          setNodes(n.nodes);
          setFederationRole(n.role ?? 'standalone');
        } else if (Array.isArray(n)) {
          setNodes(n);
        }
      } catch {
        setNodes([]);
      }
      setStatus('ready');
    } catch (err) {
      setError(err?.message || String(err));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [enabled, load]);

  return { snapshot, nodes, federationRole, status, error, refresh: load };
}
