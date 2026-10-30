/**
 * useProducts — KIS Object 5 (Product Registry).
 *
 * NOTE ON NAMING: this is the KIS product *registry* (`product.*`), NOT the
 * pre-existing products catalog served at the `/products` web route. The web UI
 * deliberately routes this one at `/product-registry` for exactly that reason.
 * Don't conflate them.
 *
 * RPCs: product.list · search · get · graph · create · update · delete
 * (src/gateway/server-methods/product.ts)
 */

import { useCallback, useMemo } from 'react';

import { useGatewayResource } from './useGatewayResource';
import { VALIDATION_STAGES, PRODUCT_STATUSES } from '../kis/vocab';

const selectProducts = (res) => res?.products ?? (Array.isArray(res) ? res : []);

export function useProducts(sendReq, params) {
  const { items, loading, error, loadedAt, refresh, mutate } = useGatewayResource(sendReq, {
    method: 'product.list',
    params,
    select: selectProducts,
  });

  const create = useCallback((draft) => mutate('product.create', draft), [mutate]);

  const update = useCallback(
    (id, patch) =>
      mutate(
        'product.update',
        { id, ...patch },
        { optimistic: (list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)) },
      ),
    [mutate],
  );

  const remove = useCallback(
    (id) => mutate('product.delete', { id }, { optimistic: (list) => list.filter((p) => p.id !== id) }),
    [mutate],
  );

  /**
   * The product's connected neighborhood (clients, opportunities, projects,
   * decisions, risks, parent/child products). Read-only; not cached here —
   * RelatedPanel owns presentation and caching of graph reads.
   */
  const graph = useCallback(
    (id, maxDepth = 2) => sendReq?.('product.graph', { id, maxDepth }),
    [sendReq],
  );

  /** Validation stage → products, in ladder order. Idea → … → Scaled, Retired. */
  const byValidationStage = useMemo(() => {
    const groups = new Map();
    for (const stage of VALIDATION_STAGES) groups.set(stage, []);
    for (const p of items) {
      const key = VALIDATION_STAGES.includes(p?.validationStage) ? p.validationStage : 'Idea';
      groups.get(key).push(p);
    }
    return groups;
  }, [items]);

  /** Operational status → products. INDEPENDENT of the validation ladder. */
  const byStatus = useMemo(() => {
    const groups = new Map();
    for (const status of PRODUCT_STATUSES) groups.set(status, []);
    for (const p of items) {
      const key = PRODUCT_STATUSES.includes(p?.status) ? p.status : 'Development';
      groups.get(key).push(p);
    }
    return groups;
  }, [items]);

  /** Products that have reached commercial proof — the portfolio headline. */
  const validatedCount = useMemo(
    () =>
      items.filter((p) => ['Paying Customer', 'Repeat Sales', 'Scaled'].includes(p?.validationStage))
        .length,
    [items],
  );

  return {
    products: items,
    loading,
    error,
    loadedAt,
    refresh,
    create,
    update,
    remove,
    graph,
    byValidationStage,
    byStatus,
    validatedCount,
  };
}

export default useProducts;
