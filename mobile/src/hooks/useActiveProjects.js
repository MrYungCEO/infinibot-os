import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Returns projects where active === true, scoped to the given businessId
 * when provided. Auto-refreshes every 60 s; call refresh() to force a reload.
 */
export function useActiveProjects({ gateway, businessId } = {}) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    if (!gateway?.sendReq) return;
    setLoading(true);
    setError(null);
    try {
      const res = await gateway.sendReq('kanban.projects.list', {});
      const all = Array.isArray(res) ? res : [];
      const active = all.filter((p) => {
        if (!p.active) return false;
        if (businessId && p.businessId && p.businessId !== businessId) return false;
        return true;
      });
      setProjects(active);
    } catch (err) {
      setError(err?.message ?? 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, [gateway, businessId]);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => void load(), 60_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  return { projects, loading, error, refresh: load };
}
