/**
 * useAgencyTopology — loads the agency map from the same RPCs as the web
 * controller (ui/src/ui/controllers/agency-topology.ts):
 *
 *   agency.ops.agencies.list                  → which agency
 *   agency.ops.clients.list / projects.list / employees.list {status:'active'}
 *   / assignments.list                         → the layers (Promise.allSettled)
 *   agency.ops.employee.detail (per worker)   → the real reporting line
 *   agency.ops.relations.client / .project    → lazy related records for the sheet
 *
 * Every request is fault isolated and timed out; failures are named in
 * `failedRequests` so a blank band is never ambiguous. A reload keeps the last
 * snapshot on screen. `agency.ops.updated` triggers a quiet background reload.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createTopologyState,
  managerFromDetail,
  normalizeAgencies,
  normalizeAssignments,
  normalizeClients,
  normalizeEmployees,
  normalizeProjects,
  normalizeRelations,
  pickAgency,
} from './topology-model';

const TIMEOUT_MS = 25000;

function withTimeout(promise, ms = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

const errText = (e) => (e && e.message ? e.message : String(e));

export function useAgencyTopology(gateway) {
  const sendReq = gateway?.sendReq;
  const status = gateway?.status;
  const [data, setData] = useState(() => createTopologyState());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [relations, setRelations] = useState(null);
  const generation = useRef(0);
  const preferredAgency = useRef(null);
  const loadedOnce = useRef(false);
  const mounted = useRef(true);
  const relationsCache = useRef(new Map());

  useEffect(() => () => { mounted.current = false; }, []);

  const call = useCallback(
    (method, params) => {
      if (!sendReq) return Promise.reject(new Error('Not connected to a gateway'));
      return withTimeout(Promise.resolve().then(() => sendReq(method, params)));
    },
    [sendReq],
  );

  const load = useCallback(
    async ({ background = false, agencyId } = {}) => {
      if (!sendReq) return;
      if (agencyId) preferredAgency.current = agencyId;
      const gen = ++generation.current;
      const quiet = background || loadedOnce.current;
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setError(null);
      const failures = [];
      const attempt = (method, params) =>
        call(method, params).catch((e) => {
          const entry = `${method} — ${errText(e)}`;
          if (!failures.includes(entry)) failures.push(entry);
          return null;
        });
      try {
        const agenciesRaw = await attempt('agency.ops.agencies.list', {});
        if (gen !== generation.current || !mounted.current) return;
        const agencies = normalizeAgencies(agenciesRaw);
        const selected = pickAgency(agencies, preferredAgency.current);
        if (!agenciesRaw && failures.length) {
          // Nothing loaded at all — surface as a page error, keep any old snapshot.
          setError(failures[0]);
          setData((prev) => ({ ...prev, failedRequests: failures }));
          return;
        }
        if (!selected) {
          setData((prev) => ({
            ...prev,
            agencies,
            agencyId: null,
            agencyName: '',
            clients: [],
            projects: [],
            workers: [],
            assignments: [],
            failedRequests: failures,
            lastLoadedAt: Date.now(),
          }));
          loadedOnce.current = true;
          return;
        }
        const id = selected.id;
        const [clientsRaw, projectsRaw, employeesRaw, assignmentsRaw] = await Promise.all([
          attempt('agency.ops.clients.list', { agencyId: id }),
          attempt('agency.ops.projects.list', { agencyId: id }),
          attempt('agency.ops.employees.list', { agencyId: id, status: 'active' }),
          attempt('agency.ops.assignments.list', { agencyId: id }),
        ]);
        if (gen !== generation.current || !mounted.current) return;
        const employees = normalizeEmployees(employeesRaw);
        let hierarchyPartial = false;
        const results = await Promise.allSettled(
          employees.map((e) => call('agency.ops.employee.detail', { agencyId: id, workerId: e.id })),
        );
        if (gen !== generation.current || !mounted.current) return;
        const workers = employees.map((e, i) => {
          const r = results[i];
          if (r.status === 'fulfilled') return { ...e, managerWorkerId: managerFromDetail(r.value) };
          hierarchyPartial = true;
          return { ...e, managerWorkerId: null };
        });
        if (hierarchyPartial) failures.push('agency.ops.employee.detail — reporting lines could not be read for every worker');
        setData((prev) => {
          const sameAgency = prev.agencyId === id;
          return {
            ...prev,
            agencies,
            agencyId: id,
            agencyName: selected.name,
            // A failed layer keeps the previous snapshot for the same agency.
            clients: clientsRaw ? normalizeClients(clientsRaw) : sameAgency ? prev.clients : [],
            projects: projectsRaw ? normalizeProjects(projectsRaw) : sameAgency ? prev.projects : [],
            workers: employeesRaw ? workers : sameAgency ? prev.workers : [],
            assignments: assignmentsRaw ? normalizeAssignments(assignmentsRaw) : sameAgency ? prev.assignments : [],
            hierarchyPartial,
            failedRequests: failures,
            lastLoadedAt: Date.now(),
            ...(sameAgency ? null : { focus: null }),
          };
        });
        if (!loadedOnce.current) loadedOnce.current = true;
        relationsCache.current.clear();
      } catch (e) {
        if (gen === generation.current && mounted.current) setError(errText(e));
      } finally {
        if (gen === generation.current && mounted.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [call, sendReq],
  );

  // Initial load + reload on reconnect.
  useEffect(() => {
    if (!sendReq) return;
    // Requests before the socket is up only produce "Not connected" noise.
    if (status && status !== 'connected') return;
    load();
  }, [sendReq, status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live: the agency surface broadcasts agency.ops.updated on writes.
  useEffect(() => {
    if (!gateway?.subscribeEvent) return undefined;
    let timer = null;
    const off = gateway.subscribeEvent('agency.ops.updated', () => {
      clearTimeout(timer);
      timer = setTimeout(() => load({ background: true }), 1500);
    });
    return () => {
      clearTimeout(timer);
      if (typeof off === 'function') off();
    };
  }, [gateway, load]);

  /** Related records for a client / project selection (cached per key). */
  const loadRelations = useCallback(
    async (selection) => {
      if (!selection || (selection.kind !== 'client' && selection.kind !== 'project')) {
        setRelations(null);
        return;
      }
      const agencyId = data.agencyId;
      if (!agencyId) return;
      const key = `${selection.kind}:${selection.id}`;
      const cached = relationsCache.current.get(key);
      if (cached) {
        setRelations(cached);
        return;
      }
      setRelations({ key, loading: true, error: null });
      try {
        const raw =
          selection.kind === 'client'
            ? await call('agency.ops.relations.client', { agencyId, clientId: selection.id })
            : await call('agency.ops.relations.project', { agencyId, projectId: selection.id });
        const next = normalizeRelations(raw, key);
        relationsCache.current.set(key, next);
        if (mounted.current) setRelations((prev) => (prev && prev.key === key ? next : prev));
      } catch (e) {
        if (mounted.current) setRelations((prev) => (prev && prev.key === key ? { ...prev, loading: false, error: errText(e) } : prev));
      }
    },
    [call, data.agencyId],
  );

  return { data, setData, loading, refreshing, error, load, relations, loadRelations };
}

export default useAgencyTopology;
