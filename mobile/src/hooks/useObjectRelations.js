/**
 * useObjectRelations — the typed-edge relation graph (`objrel.*`).
 *
 * This is the mobile face of the whole point of KIS Phase 1 (spec §4/§14):
 * an object is created once and referenced throughout, so from ANY object you
 * can traverse Client → Opportunity → Project → Task → People plus the attached
 * Decisions / Risks / Commitments / Products / Issues.
 *
 * `objrel.graph` returns `{ root, nodes, edges }` where a node is only
 * `{ type, id }` — there are no labels in the graph. Resolving a node to a human
 * name is therefore the CALLER's job (it needs that object's own store), which
 * is why `neighbors` hands back the raw endpoints and RelatedPanel takes an
 * optional `resolveLabel`. We do not invent names here.
 *
 * NAMESPACE: `objrel.*`, not `relations.*` — a separate, pre-existing untyped
 * entity-link system already owns `relations.*` with different semantics.
 *
 * RPCs: objrel.graph · list · link · unlink
 * (src/gateway/server-methods/object-relations.ts)
 */

import { useCallback, useMemo } from 'react';

import { useGatewayResource } from './useGatewayResource';
import { relationEdgeLabel } from '../kis/vocab';

const EMPTY_GRAPH = { root: null, nodes: [], edges: [] };

// The graph arrives as a bare object; normalise the array fields so a partial
// response can't make the panel throw on .map.
const selectGraph = (res) =>
  res && typeof res === 'object'
    ? { root: res.root ?? null, nodes: res.nodes ?? [], edges: res.edges ?? [] }
    : EMPTY_GRAPH;

/**
 * @param sendReq  gateway.sendReq
 * @param type     object type ('opportunity' | 'risk' | 'person' | …)
 * @param id       object id — the hook stays idle until this is truthy
 * @param maxDepth hops to follow (server clamps to 12; 3 covers
 *                 Client → Opportunity → Project → Task → People)
 */
export function useObjectRelations(sendReq, type, id, maxDepth = 3) {
  const enabled = !!(type && id);

  const { items: graph, loading, error, loadedAt, refresh, mutate } = useGatewayResource(sendReq, {
    method: 'objrel.graph',
    params: { type, id, maxDepth },
    select: selectGraph,
    enabled,
    initial: EMPTY_GRAPH,
  });

  const edges = graph?.edges ?? [];
  const nodes = graph?.nodes ?? [];

  /**
   * One entry per edge, oriented away from the root: `node` is always the OTHER
   * endpoint, `direction` says whether the root is the subject ('out') or the
   * object ('in') of the verb, and `phrase` reads correctly either way.
   */
  const neighbors = useMemo(() => {
    if (!enabled) return [];
    return edges.map((e) => {
      const rootIsFrom = e.fromType === type && e.fromId === id;
      const node = rootIsFrom ? { type: e.toType, id: e.toId } : { type: e.fromType, id: e.fromId };
      const verb = relationEdgeLabel(e.edge);
      return {
        edgeId: e.id,
        edge: e.edge,
        direction: rootIsFrom ? 'out' : 'in',
        node,
        // 'out': root <verb> node.  'in': node <verb> root.
        phrase: verb,
        from: { type: e.fromType, id: e.fromId },
        to: { type: e.toType, id: e.toId },
        createdBy: e.createdBy,
        createdAt: e.createdAt,
        meta: e.meta,
      };
    });
  }, [edges, type, id, enabled]);

  /** Neighbor object type → its edges, so the panel can render typed sections. */
  const byType = useMemo(() => {
    const groups = new Map();
    for (const n of neighbors) {
      const key = String(n.node.type || 'unknown');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    }
    return groups;
  }, [neighbors]);

  /** Every node except the root — the reachable neighborhood. */
  const reachable = useMemo(
    () => nodes.filter((n) => !(n.type === type && n.id === id)),
    [nodes, type, id],
  );

  const link = useCallback(
    (params) => mutate('objrel.link', params),
    [mutate],
  );

  /** Unlink by edge row id (what `neighbors[].edgeId` gives you). */
  const unlink = useCallback(
    (edgeId) =>
      mutate(
        'objrel.unlink',
        { id: edgeId },
        {
          optimistic: (g) => ({
            ...(g || EMPTY_GRAPH),
            edges: (g?.edges ?? []).filter((e) => e.id !== edgeId),
          }),
        },
      ),
    [mutate],
  );

  return {
    graph,
    nodes,
    edges,
    neighbors,
    byType,
    reachable,
    count: edges.length,
    loading,
    error,
    loadedAt,
    refresh,
    link,
    unlink,
    enabled,
  };
}

/**
 * useObjectLinks — the flat `objrel.list` read for one endpoint, when you want
 * the edge rows without the multi-hop neighborhood.
 *
 * @param direction 'both' | 'from' | 'to'
 */
export function useObjectLinks(sendReq, type, id, direction = 'both') {
  const enabled = !!(type && id);
  const { items, loading, error, refresh } = useGatewayResource(sendReq, {
    method: 'objrel.list',
    params: { type, id, direction },
    select: selectRelations,
    enabled,
  });
  return { relations: items, count: items.length, loading, error, refresh, enabled };
}

const selectRelations = (res) => res?.relations ?? (Array.isArray(res) ? res : []);

export default useObjectRelations;
