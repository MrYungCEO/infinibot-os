/**
 * useReports — the mobile Reports library (parity with the web /reports
 * gallery and the Research workspace's report list).
 *
 * Calls the EXACT gateway methods the web uses (src/gateway/server-methods/
 * reports.ts), so both clients read the one SQLite report store:
 *   reports.list      ({ category?, kind?, status?, limit?, offset? }) -> { reports[], total }
 *   reports.get       ({ id })            -> { report }   (includes markdownBody — the markitdown copy)
 *   reports.preview   ({ id, base64 })    -> { filePath, mimeType, base64 }
 *   reports.associations ({ reportId })   -> { associations[] }
 *   reports.meta      ()                  -> { kinds[], themes[], categories[] }
 *   reports.schedules.list / reports.triggers.list            (read-only here)
 *   reports.generate / reports.resend / reports.delete         (secondary actions)
 * Research (ui/src/ui/views/research/api.ts):
 *   reports.list × {category:research | kind:research_brief | kind:competitive_analysis | recent}
 *   agent.tools.invoke { tool: 'research', args: { action: 'list' | 'get' } }
 *
 * The store is dominated by `oversight_event` rows ("Sub-agent failed — …"),
 * so the library also pulls every non-general category on its own and keeps
 * paging the recent feed until enough non-system rows are on screen.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import {
  dedupeReports,
  isSystemEvent,
  isResearchReport,
  toolPayload,
  researchDocToRow,
} from '../lib/reports-model';

const PAGE = 200;
const UI_TOOL_SESSION = 'agent:main:research-ui';
/** Enough real (non-system) rows to fill a phone screen before we stop auto-paging. */
const MIN_REAL_ROWS = 40;
const MAX_AUTO_PAGES = 6;

export function useReports(gateway) {
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status ? gateway.status === 'connected' : !!sendReq;

  const [meta, setMeta] = useState({ kinds: [], themes: [], categories: [] });
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const loadSeq = useRef(0);

  const req = useCallback(
    (method, params = {}) => {
      if (!sendReq) return Promise.reject(new Error('Not connected'));
      return sendReq(method, params);
    },
    [sendReq],
  );

  const loadMeta = useCallback(async () => {
    try {
      const res = await req('reports.meta', {});
      const m = { kinds: res?.kinds || [], themes: res?.themes || [], categories: res?.categories || [] };
      setMeta(m);
      return m;
    } catch {
      return null;
    }
  }, [req]);

  /** First load / pull-to-refresh: recent pages + every non-general category. */
  const refresh = useCallback(async () => {
    if (!sendReq) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const m = (await loadMeta()) || meta;
      const cats = (m.categories || []).filter((c) => c && c !== 'general');
      const catCalls = cats.map((category) => req('reports.list', { category, limit: PAGE }).catch(() => null));
      let collected = [];
      let tot = 0;
      let off = 0;
      for (let page = 0; page < MAX_AUTO_PAGES; page++) {
        const res = await req('reports.list', { limit: PAGE, offset: off });
        const list = Array.isArray(res?.reports) ? res.reports : [];
        tot = typeof res?.total === 'number' ? res.total : tot;
        collected = collected.concat(list);
        off += list.length;
        const real = collected.filter((r) => !isSystemEvent(r)).length;
        if (list.length < PAGE || real >= MIN_REAL_ROWS || off >= tot) break;
      }
      const catLists = (await Promise.all(catCalls)).map((r) => (Array.isArray(r?.reports) ? r.reports : []));
      if (seq !== loadSeq.current) return;
      setRows(dedupeReports(collected, ...catLists));
      setTotal(tot);
      setOffset(off);
    } catch (e) {
      if (seq === loadSeq.current) setError(e?.message || String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [sendReq, req, loadMeta, meta]);

  const hasMore = offset < total;

  const loadMore = useCallback(async () => {
    if (!sendReq || loadingMore || loading || offset >= total) return;
    setLoadingMore(true);
    try {
      const res = await req('reports.list', { limit: PAGE, offset });
      const list = Array.isArray(res?.reports) ? res.reports : [];
      setRows((prev) => dedupeReports(prev, list));
      setOffset((o) => o + list.length);
      if (typeof res?.total === 'number') setTotal(res.total);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [sendReq, req, offset, total, loadingMore, loading]);

  // ── Research (reports + research-docs store) ────────────────────
  const [research, setResearch] = useState({ rows: [], loading: false, error: null, loaded: false });
  const loadResearch = useCallback(async () => {
    if (!sendReq) return;
    setResearch((s) => ({ ...s, loading: true, error: null }));
    const calls = await Promise.allSettled([
      req('reports.list', { category: 'research', limit: 300 }),
      req('reports.list', { kind: 'research_brief', limit: 300 }),
      req('reports.list', { kind: 'competitive_analysis', limit: 100 }),
      req('reports.list', { limit: 500 }),
      req('agent.tools.invoke', {
        tool: 'research',
        args: { action: 'list', limit: 1000 },
        sessionKey: UI_TOOL_SESSION,
        source: 'ui',
      }),
    ]);
    const reportLists = calls.slice(0, 4).map((c) => (c.status === 'fulfilled' && Array.isArray(c.value?.reports) ? c.value.reports : []));
    const reports = dedupeReports(...reportLists).filter(isResearchReport);
    const docsCall = calls[4];
    const docs =
      docsCall.status === 'fulfilled'
        ? (Array.isArray(toolPayload(docsCall.value).research) ? toolPayload(docsCall.value).research : []).map(researchDocToRow)
        : [];
    const allFailed = calls.every((c) => c.status === 'rejected');
    setResearch({
      rows: [...reports, ...docs],
      loading: false,
      loaded: true,
      error: allFailed ? calls[0].reason?.message || 'Could not load research' : null,
    });
  }, [sendReq, req]);

  // ── Schedules + triggers (read-only) ────────────────────────────
  const [automation, setAutomation] = useState({ schedules: [], triggers: [], loading: false, error: null, loaded: false });
  const loadAutomation = useCallback(async () => {
    if (!sendReq) return;
    setAutomation((s) => ({ ...s, loading: true, error: null }));
    const [s, t] = await Promise.allSettled([req('reports.schedules.list', {}), req('reports.triggers.list', {})]);
    setAutomation({
      schedules: s.status === 'fulfilled' && Array.isArray(s.value?.schedules) ? s.value.schedules : [],
      triggers: t.status === 'fulfilled' && Array.isArray(t.value?.triggers) ? t.value.triggers : [],
      loading: false,
      loaded: true,
      error: s.status === 'rejected' && t.status === 'rejected' ? s.reason?.message || 'Could not load schedules' : null,
    });
  }, [sendReq, req]);

  // ── Detail reads ────────────────────────────────────────────────
  const getReport = useCallback(async (id) => {
    const res = await req('reports.get', { id });
    return res?.report || null;
  }, [req]);

  const getAssociations = useCallback(async (reportId) => {
    try {
      const res = await req('reports.associations', { reportId });
      return Array.isArray(res?.associations) ? res.associations : [];
    } catch {
      return [];
    }
  }, [req]);

  // Project names for association chips (cached for the session).
  const projectNames = useRef(null);
  const getProjectNames = useCallback(async () => {
    if (projectNames.current) return projectNames.current;
    try {
      const res = await req('kanban.projects.list', {});
      const list = Array.isArray(res) ? res : Array.isArray(res?.projects) ? res.projects : [];
      const map = new Map();
      for (const p of list) if (p?.id) map.set(String(p.id), String(p.name || p.title || p.id));
      projectNames.current = map;
      return map;
    } catch {
      return new Map();
    }
  }, [req]);

  const getResearchDoc = useCallback(async (docId) => {
    const res = await req('agent.tools.invoke', {
      tool: 'research',
      args: { action: 'get', id: docId },
      sessionKey: UI_TOOL_SESSION,
      source: 'ui',
    });
    const r = toolPayload(res).research;
    return r && typeof r === 'object' ? r : null;
  }, [req]);

  const preview = useCallback(async (id) => {
    const res = await req('reports.preview', { id, base64: true });
    return res || null; // { filePath, mimeType, base64 }
  }, [req]);

  // ── Secondary actions (kept from the original screen) ───────────
  const generate = useCallback(async ({ kind, theme, sinks, config } = {}) => {
    if (!kind) return null;
    setBusy(true);
    try {
      const res = await req('reports.generate', {
        kind,
        theme: theme || undefined,
        sinks: sinks && sinks.length ? sinks : undefined,
        config: config || undefined,
      });
      refresh();
      return res;
    } catch (e) {
      setError(e?.message || String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [req, refresh]);

  const resend = useCallback(async (id, sinks) => {
    if (!id || !sinks?.length) return null;
    setBusy(true);
    try {
      return await req('reports.resend', { id, sinks });
    } catch (e) {
      setError(e?.message || String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [req]);

  const deleteItem = useCallback(async (id) => {
    setBusy(true);
    try {
      await req('reports.delete', { id });
      setRows((prev) => prev.filter((r) => r.id !== id));
      return true;
    } catch (e) {
      setError(e?.message || String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [req]);

  useEffect(() => {
    if (connected) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, sendReq]);

  return {
    meta,
    rows,
    total,
    loading,
    loadingMore,
    hasMore,
    error,
    busy,
    refresh,
    loadMore,
    research,
    loadResearch,
    automation,
    loadAutomation,
    getReport,
    getAssociations,
    getProjectNames,
    getResearchDoc,
    preview,
    generate,
    resend,
    deleteItem,
    clearError: () => setError(null),
  };
}

export default useReports;
