/**
 * Condition evaluation for guided walkthroughs. Pure given an environment, so
 * the branching / skip / check logic is unit-tested without a browser.
 */

import {
  isReadOnlyMethod,
  type LearnCondition,
  type LearnRpcCheck,
  type LearnTarget,
} from "../../../../src/learn/guided/types.js";

export interface ConditionEnv {
  pluginEnabled(id: string): boolean;
  hasMethod(method: string): boolean;
  hasSurface(id: string): boolean;
  elementVisible(target: LearnTarget): boolean;
  /** Current route (path after the base path, with query). */
  route(): string;
  viewportWidth(): number;
  /** Read-only RPC. Throws / rejects when unavailable. */
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** `<trackId>/<walkthroughId>` or trackId → complete? */
  completed(ref: string): boolean;
}

/** Dotted-path lookup; `*` maps over arrays and flattens. */
export function pickPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur: unknown[] = [value];
  let mapped = false;
  for (const part of path.split(".")) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (part === "*") {
        mapped = true;
        if (Array.isArray(v)) next.push(...v);
        continue;
      }
      if (v == null) continue;
      if (part === "length" && (Array.isArray(v) || typeof v === "string")) {
        next.push(v.length);
        continue;
      }
      if (typeof v === "object") next.push((v as Record<string, unknown>)[part]);
    }
    cur = next;
  }
  return mapped ? cur : cur[0];
}

export function checkRpcValue(value: unknown, check: Pick<LearnRpcCheck, "equals" | "min" | "includes">): boolean {
  if (check.includes !== undefined) {
    return Array.isArray(value) && value.some((v) => v === check.includes);
  }
  if (check.equals !== undefined) {
    if (Array.isArray(value)) return value.some((v) => v === check.equals);
    return value === check.equals;
  }
  if (check.min !== undefined) {
    const n = Array.isArray(value) || typeof value === "string" ? value.length : typeof value === "number" ? value : NaN;
    return Number.isFinite(n) && n >= check.min;
  }
  if (Array.isArray(value)) return value.length > 0 && value.some(Boolean);
  return Boolean(value);
}

function routeMatches(current: string, path: string): boolean {
  const [cp] = current.split("?");
  const [pp, pq] = path.split("?");
  const c = (cp || "/").replace(/\/+$/, "") || "/";
  const p = (pp || "/").replace(/\/+$/, "") || "/";
  if (!(c === p || c.startsWith(`${p}/`))) return false;
  if (!pq) return true;
  const have = new URLSearchParams(current.split("?")[1] ?? "");
  for (const [k, v] of new URLSearchParams(pq)) if (have.get(k) !== v) return false;
  return true;
}

/** Evaluate synchronously where possible; RPC checks are async. */
export async function evaluate(cond: LearnCondition | undefined, env: ConditionEnv): Promise<boolean> {
  if (!cond) return true;
  switch (cond.kind) {
    case "pluginEnabled":
      return env.pluginEnabled(cond.plugin);
    case "method":
      return env.hasMethod(cond.method);
    case "surface":
      return env.hasSurface(cond.surface);
    case "element":
      return env.elementVisible(cond.target);
    case "route":
      return routeMatches(env.route(), cond.path);
    case "viewport": {
      const w = env.viewportWidth();
      return (cond.maxWidth === undefined || w <= cond.maxWidth) && (cond.minWidth === undefined || w >= cond.minWidth);
    }
    case "completed":
      return env.completed(cond.ref);
    case "rpc": {
      if (!isReadOnlyMethod(cond.method)) return false;
      try {
        const res = await env.rpc(cond.method, cond.params);
        return checkRpcValue(pickPath(res, cond.path), cond);
      } catch {
        return false;
      }
    }
    case "not":
      return !(await evaluate(cond.condition, env));
    case "all":
      for (const c of cond.conditions) if (!(await evaluate(c, env))) return false;
      return true;
    case "any":
      for (const c of cond.conditions) if (await evaluate(c, env)) return true;
      return false;
    default:
      return false;
  }
}

/**
 * Static availability check for catalog listing (no DOM, no RPC): `element`,
 * `route` and `rpc` conditions are treated as satisfiable so a track is never
 * hidden just because the user is on another page.
 */
export function isListable(cond: LearnCondition | undefined, env: Pick<ConditionEnv, "pluginEnabled" | "hasMethod" | "hasSurface" | "completed">): boolean {
  if (!cond) return true;
  switch (cond.kind) {
    case "pluginEnabled":
      return env.pluginEnabled(cond.plugin);
    case "method":
      return env.hasMethod(cond.method);
    case "surface":
      return env.hasSurface(cond.surface);
    case "completed":
      return true; // prerequisites are advisory in the catalog
    case "not":
      // Only negate static facts; dynamic ones stay listable.
      return ["pluginEnabled", "method", "surface"].includes(cond.condition.kind)
        ? !isListable(cond.condition, env)
        : true;
    case "all":
      return cond.conditions.every((c) => isListable(c, env));
    case "any":
      return cond.conditions.some((c) => isListable(c, env));
    default:
      return true;
  }
}

export { routeMatches };
