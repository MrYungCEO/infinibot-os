/**
 * Composition variables — typed inputs that drive clip props.
 *
 * A composition stores two parallel fields under `meta`:
 *   - `meta.variables`: `CompositionVariable[]` — the typed declarations
 *     (id, type, label, default, options for enum, min/max for number).
 *   - `meta.variableValues`: `Record<string, unknown>` — the current
 *     bound values for this composition. Missing keys fall back to the
 *     variable's `default`.
 *
 * Clip props reference variables via `{{varId}}` substitution in any
 * string-valued field — `text`, `color`, `background`, etc. The
 * translator runs `resolveStringWithVariables(value, resolved)` before
 * emitting the element. A clip can also bind a non-string prop directly
 * to a variable via the `bindings` map (e.g. `{ "fontSize": "heroSize" }`)
 * for number/boolean/enum-typed inputs.
 *
 * This file is the source of truth for both:
 *   - the gateway RPC handlers (CRUD)
 *   - the translator's per-clip resolution pass
 * Keeping it shared means the agent's `composition.variables.*` writes
 * and the render path read the same shape — no schema drift.
 */
import type {
  CompositionVariable,
  StringVariable,
  NumberVariable,
  ColorVariable,
  BooleanVariable,
  EnumVariable,
} from "@hyperframes/core";

export type ResolvedVariableValues = Record<string, string | number | boolean>;

/**
 * Read the `(variables, variableValues)` pair off a composition's `meta`
 * blob and produce the resolved `{ varId → value }` map every consumer
 * expects, applying defaults for unset values and dropping any value
 * whose type doesn't match its declaration (e.g. someone wrote a string
 * to a NumberVariable's slot — we'd rather silently fall back to the
 * default than render `"hot"` as a font-size).
 */
export function resolveVariables(meta: Record<string, unknown> | undefined): {
  variables: CompositionVariable[];
  values: ResolvedVariableValues;
} {
  const m = meta ?? {};
  const variables = Array.isArray(m.variables) ? (m.variables as CompositionVariable[]) : [];
  const stored = (m.variableValues as Record<string, unknown> | undefined) ?? {};
  const values: ResolvedVariableValues = {};
  for (const v of variables) {
    const raw = Object.prototype.hasOwnProperty.call(stored, v.id) ? stored[v.id] : undefined;
    const validated = coerceValue(v, raw);
    values[v.id] = validated;
  }
  return { variables, values };
}

function coerceValue(decl: CompositionVariable, raw: unknown): string | number | boolean {
  switch (decl.type) {
    case "string":
      return typeof raw === "string" ? raw : (decl as StringVariable).default;
    case "color":
      return typeof raw === "string" && raw.length > 0 ? raw : (decl as ColorVariable).default;
    case "number": {
      const d = decl as NumberVariable;
      if (typeof raw === "number" && Number.isFinite(raw)) {
        if (d.min !== undefined && raw < d.min) return d.min;
        if (d.max !== undefined && raw > d.max) return d.max;
        return raw;
      }
      return d.default;
    }
    case "boolean":
      return typeof raw === "boolean" ? raw : (decl as BooleanVariable).default;
    case "enum": {
      const d = decl as EnumVariable;
      const opts = (d as unknown as { options?: string[] }).options ?? [];
      if (typeof raw === "string" && (opts.length === 0 || opts.includes(raw))) {
        return raw;
      }
      return d.default;
    }
    default:
      return "";
  }
}

/** Match patterns: `{{id}}` or `{{ id }}` (whitespace tolerated). */
const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;

/**
 * Replace every `{{id}}` in `value` with the resolved variable value.
 * Numbers/booleans coerce via `String(...)`. Unknown variable ids are
 * left intact so the operator can see something is unbound (instead of
 * the silent-empty-string fallback most templating engines use).
 */
export function resolveStringWithVariables(value: string, values: ResolvedVariableValues): string {
  if (!value || !value.includes("{{")) return value;
  return value.replace(VAR_RE, (_match, id: string) => {
    if (Object.prototype.hasOwnProperty.call(values, id)) {
      return String(values[id]);
    }
    return `{{${id}}}`;
  });
}

/**
 * Resolve a prop value that may either be a raw value OR an
 * `{ $var: "varId" }` binding object. The binding form is how the
 * editor / agent target a non-string prop (font size, opacity) at a
 * variable without lexing `{{id}}` out of a number.
 *
 * Returns the resolved primitive (passes raw values through unchanged).
 */
export function resolveBoundValue(raw: unknown, values: ResolvedVariableValues): unknown {
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "$var" in (raw as Record<string, unknown>)
  ) {
    const id = (raw as { $var: string }).$var;
    if (Object.prototype.hasOwnProperty.call(values, id)) return values[id];
    return raw; // unbound — render the placeholder object so it's visibly off
  }
  if (typeof raw === "string") return resolveStringWithVariables(raw, values);
  return raw;
}

/**
 * Walk every string-typed field of an arbitrary `props` blob and run
 * variable substitution. Number/boolean/object fields are left alone
 * unless they're `$var` bindings, which `resolveBoundValue` handles.
 * Returns a new object; the input is never mutated.
 */
export function resolveProps(
  props: Record<string, unknown>,
  values: ResolvedVariableValues,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = resolveBoundValue(v, values);
  }
  return out;
}
