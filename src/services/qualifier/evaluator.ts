/**
 * Qualifier criterion evaluator.
 *
 * Pure function: takes a qualifier config + an inbound webhook payload,
 * decides "qualified" / "unqualified" / "error" with a per-criterion
 * trace the runs UI can render. No I/O — keeps this module trivially
 * testable and reusable from agent tools or the gateway runner.
 *
 * Mirrors the criterion shape declared in the UI controller
 * (`ui/src/ui/controllers/lead-qualifier.ts`) but accepts loosely-typed
 * objects so a UI-side schema bump doesn't drag this module along.
 */

export type CriterionEvalResult = {
  matched: boolean;
  reason: string;
};

interface LooseCriterion {
  id?: string;
  field?: string;
  customPath?: string;
  op?: string;
  value?: string;
  label?: string;
}

/** Resolve a criterion's value from the payload. Field aliases mirror the UI. */
function readField(payload: Record<string, unknown>, c: LooseCriterion): unknown {
  if (c.field === "custom" && c.customPath) {
    return readPath(payload, c.customPath);
  }
  if (!c.field) return undefined;
  // Most fields land at the top level on the webhook body — try direct key
  // first, then a `body.<field>` fallback for n8n-style payloads where the
  // form data is nested.
  if (payload[c.field] !== undefined) return payload[c.field];
  return readPath(payload, `body.${c.field}`);
}

/** Dotted-path read; tolerates undefined intermediates. */
function readPath(root: unknown, path: string): unknown {
  let curr: unknown = root;
  for (const part of path.split(".")) {
    if (curr === null || curr === undefined) return undefined;
    if (typeof curr !== "object") return undefined;
    curr = (curr as Record<string, unknown>)[part];
  }
  return curr;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string")
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

/** Evaluate one criterion. Returns matched=true when the rule passes. */
export function evaluateCriterion(
  payload: Record<string, unknown>,
  c: LooseCriterion,
): CriterionEvalResult {
  const actual = readField(payload, c);
  const op = c.op ?? "eq";
  const expected = typeof c.value === "string" ? c.value : "";

  switch (op) {
    case "exists":
      return {
        matched: actual !== undefined && actual !== null && actual !== "",
        reason: `${c.field} exists`,
      };
    case "not_exists":
      return {
        matched: actual === undefined || actual === null || actual === "",
        reason: `${c.field} not exists`,
      };
    case "gte":
    case "lte":
    case "gt":
    case "lt": {
      const a = asNumber(actual);
      const e = asNumber(expected);
      if (a === null || e === null) return { matched: false, reason: `${c.field} not numeric` };
      const matched = op === "gte" ? a >= e : op === "lte" ? a <= e : op === "gt" ? a > e : a < e;
      return { matched, reason: `${c.field} ${op} ${e} (actual ${a})` };
    }
    case "eq":
      return { matched: asString(actual) === expected, reason: `${c.field} == "${expected}"` };
    case "neq":
      return { matched: asString(actual) !== expected, reason: `${c.field} != "${expected}"` };
    case "contains":
      return {
        matched: asString(actual).toLowerCase().includes(expected.toLowerCase()),
        reason: `${c.field} contains "${expected}"`,
      };
    case "not_contains":
      return {
        matched: !asString(actual).toLowerCase().includes(expected.toLowerCase()),
        reason: `${c.field} ! contains "${expected}"`,
      };
    case "in": {
      const set = expected
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const arr = asArray(actual).map(asString);
      const direct = set.includes(asString(actual));
      const intersect = arr.some((x) => set.includes(x));
      return { matched: direct || intersect, reason: `${c.field} in [${set.join(", ")}]` };
    }
    case "not_in": {
      const set = expected
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const arr = asArray(actual).map(asString);
      const direct = !set.includes(asString(actual));
      const intersect = !arr.some((x) => set.includes(x));
      return { matched: direct && intersect, reason: `${c.field} not in [${set.join(", ")}]` };
    }
    case "regex": {
      try {
        const re = new RegExp(expected);
        return { matched: re.test(asString(actual)), reason: `${c.field} ~= /${expected}/` };
      } catch {
        return { matched: false, reason: `bad regex: ${expected}` };
      }
    }
    default:
      return { matched: false, reason: `unknown op: ${op}` };
  }
}

export interface EvaluateAllResult {
  result: "qualified" | "unqualified";
  matched: number;
  total: number;
  trace: Array<{ id?: string; label?: string; matched: boolean; reason: string }>;
}

export function evaluateConfig(
  payload: Record<string, unknown>,
  config: { criteriaMode?: "all" | "any"; criteria?: LooseCriterion[] },
): EvaluateAllResult {
  const criteria = Array.isArray(config.criteria) ? config.criteria : [];
  const mode = config.criteriaMode === "any" ? "any" : "all";
  const trace = criteria.map((c) => ({
    id: c.id,
    label: c.label,
    ...evaluateCriterion(payload, c),
  }));
  const matched = trace.filter((t) => t.matched).length;
  // No criteria configured: treat as qualified — the operator hasn't said
  // otherwise, and the action stack might still be useful (e.g. always
  // save-to-crm). Better than silently dropping leads.
  if (criteria.length === 0) {
    return { result: "qualified", matched: 0, total: 0, trace };
  }
  const ok = mode === "all" ? matched === criteria.length : matched > 0;
  return { result: ok ? "qualified" : "unqualified", matched, total: criteria.length, trace };
}
