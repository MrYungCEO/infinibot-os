/**
 * Guard test: every key declared on `InfinibotConfig` must be accepted by the
 * zod validator.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * The config schemas call `.strict()` in ~250 places. Strict means an unknown key
 * is *rejected*, so an option that exists in the TypeScript types but is missing
 * from its zod schema is silently unsettable: `infinibot config set` fails, the
 * config RPCs fail, and hand-editing infinibot.json makes the whole file fail
 * validation on load (which bricks the gateway on boot). The feature looks fully
 * implemented in code review and simply cannot be enabled.
 *
 * This test walks the *real* TypeScript type of `InfinibotConfig` (via the
 * compiler's type checker, so aliases, intersections and inherited members are
 * resolved) in lockstep with the *real* `InfinibotSchema` object graph (via zod's
 * runtime introspection). Any type key with no schema counterpart fails the test.
 *
 * ── Extending this when you add a new config module ──────────────────────────
 * Nothing. The walk starts at `InfinibotConfig` and follows the type graph, so a
 * new `types.foo.ts` reached from `InfinibotConfig` is covered automatically —
 * that is the point. You only ever touch this file to add an ALLOWLIST entry.
 *
 * ── If this test fails ───────────────────────────────────────────────────────
 * The default fix is to ADD the missing key to the schema with a tight type
 * (enum for a union, positive int for a count, ...). Do NOT relax `.strict()` to
 * `.passthrough()` — strictness is what catches typos in a hand-edited config.
 * Only add an ALLOWLIST entry when the key is deliberately not settable at that
 * location, and say why.
 *
 * ── Known limitations (deliberate, to avoid false positives) ─────────────────
 * - Key-level only. It cannot see enum/value drift (e.g. a `z.enum` missing one
 *   member of the TS union) — that still needs a hand-written test.
 * - Unions are compared against the merged key set of all object options; a key
 *   present on any option counts as covered.
 * - `z.record(...)`, `.passthrough()` and `.catchall(...)` accept every key, so
 *   anything under them is treated as covered.
 */
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { InfinibotSchema } from "./zod-schema.js";

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * Config-type keys that are intentionally NOT accepted by the schema.
 * Key: `<dotted path>.<key>` as printed in the failure message.
 * Value: why it is excluded. Never add an entry without a reason.
 */
const ALLOWLIST: Record<string, string> = {
  // `AgentModelListConfig` is shared by `model` and `imageModel`, but these two
  // fields are text-model-only (see the doc comment on AgentModelListConfig).
  // Keeping them off the imageModel schema makes a misplaced key a load error
  // instead of a setting that silently does nothing.
  "agents.defaults.imageModel.ollamaSafetyNet":
    "text-model only; intentionally rejected under imageModel",
  "agents.defaults.imageModel.defaultProvider":
    "text-model only; intentionally rejected under imageModel",

  // Vestigial duplicate: the live embedding cache is `memorySearch.cache`
  // (schema'd, documented in schema.ts, and the only one any code reads).
  // `memorySearch.store.cache` has zero readers — adding it to the schema would
  // create a second, inert place to configure the same thing.
  "agents.defaults.memorySearch.store.cache":
    "dead type member; the real setting is memorySearch.cache",
  "agents.list[].memorySearch.store.cache":
    "dead type member; the real setting is memorySearch.cache",

  // Sub-agent model selection is read from `agents.defaults.subagents.model` and
  // the per-agent override (src/agents/tools/sessions-spawn-tool.ts). Nothing
  // reads `tools.subagents.model`; only `tools.subagents.tools` is live.
  "tools.subagents.model": "dead type member; use agents.defaults.subagents.model",
};

// ─────────────────────────── TypeScript side ───────────────────────────

function makeProgram(): ts.Program {
  const configPath = path.join(ROOT, "tsconfig.json");
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (!parsed) throw new Error(`could not parse ${configPath}`);
  return ts.createProgram({
    rootNames: [path.join(ROOT, "src", "config", "types.infinibot.ts")],
    options: { ...parsed.options, noEmit: true },
  });
}

function findRootDeclaration(program: ts.Program): ts.TypeAliasDeclaration {
  const wanted = "types.infinibot.ts";
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.endsWith(wanted)) continue;
    for (const st of sf.statements) {
      if (ts.isTypeAliasDeclaration(st) && st.name.text === "InfinibotConfig") return st;
    }
  }
  throw new Error("could not locate `InfinibotConfig` in types.infinibot.ts");
}

type TsInfo = {
  props: Map<string, ts.Type>;
  hasIndex: boolean;
  arrayElement?: ts.Type;
  /** any/unknown/function — no meaningful key set, stop walking. */
  opaque: boolean;
};

const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Void |
  ts.TypeFlags.Never;

function describeTsType(checker: ts.TypeChecker, type: ts.Type, node: ts.Node): TsInfo {
  const props = new Map<string, ts.Type>();
  let hasIndex = false;
  let arrayElement: ts.Type | undefined;
  let opaque = false;

  // Optional properties surface as `T | undefined`; intersections keep their parts.
  const parts = type.isUnion() ? type.types : [type];
  for (const part of parts) {
    if (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
    if (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      opaque = true;
      continue;
    }
    if (part.flags & PRIMITIVE_FLAGS) continue;
    if (checker.isArrayType(part)) {
      arrayElement = checker.getTypeArguments(part as ts.TypeReference)[0];
      continue;
    }
    if (checker.getSignaturesOfType(part, ts.SignatureKind.Call).length > 0) {
      opaque = true;
      continue;
    }
    if (checker.getIndexInfoOfType(part, ts.IndexKind.String)) hasIndex = true;
    for (const sym of checker.getPropertiesOfType(part)) {
      if (props.has(sym.name)) continue;
      const decl = sym.valueDeclaration ?? sym.declarations?.[0] ?? node;
      props.set(sym.name, checker.getTypeOfSymbolAtLocation(sym, decl));
    }
  }
  return { props, hasIndex, arrayElement, opaque };
}

// ─────────────────────────────── zod side ───────────────────────────────

type ZodInfo = {
  kind: string;
  shape?: Record<string, unknown>;
  /** true when unknown keys are not rejected (loose / catchall / record). */
  openKeys?: boolean;
  element?: unknown;
  valueType?: unknown;
  options?: unknown[];
};

/** Peel wrapper schemas (optional/default/lazy/...) down to the carrier type. */
function unwrapZod(schema: any, depth = 0): any {
  if (!schema || depth > 30) return schema;
  switch (schema?.def?.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "nonoptional":
    case "catch":
      return unwrapZod(schema.def.innerType, depth + 1);
    case "lazy":
      try {
        return unwrapZod(schema.def.getter(), depth + 1);
      } catch {
        return schema;
      }
    case "pipe":
      return unwrapZod(schema.def.out ?? schema.def.in, depth + 1);
    default:
      return schema;
  }
}

function describeZod(raw: unknown): ZodInfo {
  const schema = unwrapZod(raw);
  const kind = schema?.def?.type;
  if (kind === "object" || kind === "interface") {
    // zod v4: `.strict()` sets catchall to ZodNever. Anything else (loose,
    // explicit catchall, or the default strip behaviour) tolerates unknown keys.
    const openKeys = schema.def.catchall?.def?.type !== "never";
    return { kind: "object", shape: schema.shape, openKeys };
  }
  if (kind === "record" || kind === "map")
    return { kind: "record", valueType: schema.def.valueType };
  if (kind === "array") return { kind: "array", element: schema.def.element };
  if (kind === "union") return { kind: "union", options: schema.def.options };
  if (kind === "intersection")
    return { kind: "union", options: [schema.def.left, schema.def.right] };
  return { kind: kind ?? "unknown" };
}

// ───────────────────────────────── walk ─────────────────────────────────

type Finding = { path: string; reason: string };

/** Stable per-schema id so the cycle guard can key on (tsType, schema) pairs. */
const schemaIds = new WeakMap<object, number>();
let nextSchemaId = 1;
function schemaId(schema: unknown): number {
  if (!schema || typeof schema !== "object") return 0;
  let id = schemaIds.get(schema as object);
  if (!id) {
    id = nextSchemaId++;
    schemaIds.set(schema as object, id);
  }
  return id;
}

type WalkCtx = {
  checker: ts.TypeChecker;
  node: ts.Node;
  findings: Finding[];
  stats: { objects: number; keys: number };
};

function walk(
  ctx: WalkCtx,
  type: ts.Type,
  schema: unknown,
  pathStr: string,
  /** (tsType, schema) pairs already on this branch — cycle guard, per-branch so
   *  a schema reused at two paths is still reported at both. */
  ancestors: ReadonlySet<string>,
  depth: number,
): void {
  if (depth > 16 || !schema) return;

  const zi = describeZod(schema);
  const ti = describeTsType(ctx.checker, type, ctx.node);
  if (ti.opaque) return;

  if (zi.kind === "union") {
    // Ambiguous by nature: a key counts as covered if ANY object option has it,
    // and any record/open option covers everything.
    const merged = new Set<string>();
    for (const option of zi.options ?? []) {
      const oi = describeZod(option);
      if (oi.kind === "record" || (oi.kind === "object" && oi.openKeys)) return;
      if (oi.kind === "object" && oi.shape) for (const k of Object.keys(oi.shape)) merged.add(k);
    }
    if (merged.size === 0) return;
    for (const key of ti.props.keys()) {
      if (!merged.has(key)) {
        ctx.findings.push({ path: joinPath(pathStr, key), reason: "no union option accepts it" });
      }
    }
    return;
  }

  if (zi.kind === "array") {
    if (ti.arrayElement)
      walk(ctx, ti.arrayElement, zi.element, `${pathStr}[]`, ancestors, depth + 1);
    return;
  }

  if (zi.kind === "record") {
    // Every key is accepted; only the value shape can still be too narrow.
    const indexType = ctx.checker.getIndexInfoOfType(type, ts.IndexKind.String)?.type;
    if (indexType) walk(ctx, indexType, zi.valueType, `${pathStr}.<key>`, ancestors, depth + 1);
    return;
  }

  if (zi.kind !== "object" || !zi.shape) return;
  if (ti.props.size === 0 && !ti.hasIndex) return;

  const guard = `${ctx.checker.typeToString(type)}@@${schemaId(schema)}`;
  if (ancestors.has(guard)) return;
  const branch = new Set(ancestors);
  branch.add(guard);

  ctx.stats.objects += 1;
  for (const [key, propType] of ti.props) {
    ctx.stats.keys += 1;
    const sub = (zi.shape as Record<string, unknown>)[key];
    if (!sub) {
      // A TS index signature means the type itself is open-ended here.
      if (!zi.openKeys && !ti.hasIndex) {
        ctx.findings.push({ path: joinPath(pathStr, key), reason: "not in the zod schema" });
      }
      continue;
    }
    walk(ctx, propType, sub, joinPath(pathStr, key), branch, depth + 1);
  }
}

function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

// ───────────────────────────────── test ─────────────────────────────────

export function auditConfigSchemaCoverage(): {
  findings: Finding[];
  stats: { objects: number; keys: number };
} {
  const program = makeProgram();
  const checker = program.getTypeChecker();
  const decl = findRootDeclaration(program);
  const ctx: WalkCtx = {
    checker,
    node: decl,
    findings: [],
    stats: { objects: 0, keys: 0 },
  };
  walk(ctx, checker.getTypeAtLocation(decl.name), InfinibotSchema, "", new Set(), 0);
  return { findings: ctx.findings, stats: ctx.stats };
}

describe("config schema coverage", () => {
  const result = auditConfigSchemaCoverage();

  it("walks a meaningful slice of the config tree", () => {
    // Sanity floor: if the walk silently stops early (bad tsconfig, renamed
    // type, zod internals changed) the coverage assertion below would pass
    // vacuously. These numbers only need bumping if they become wrong-by-a-lot.
    expect(result.stats.objects).toBeGreaterThan(200);
    expect(result.stats.keys).toBeGreaterThan(1200);
  });

  it("accepts every InfinibotConfig key that is not explicitly allowlisted", () => {
    const unexpected = result.findings.filter((f) => !(f.path in ALLOWLIST));
    const message = unexpected
      .map(
        (f) =>
          `  ${f.path} — ${f.reason}\n` +
          "    Fix: add it to the matching zod schema with a tight type " +
          "(do not switch .strict() to .passthrough()), or add an ALLOWLIST " +
          "entry in this file explaining why it must stay unsettable.",
      )
      .join("\n");
    expect(
      unexpected.map((f) => f.path),
      `\n${message}\n`,
    ).toEqual([]);
  });

  it("has no stale ALLOWLIST entries", () => {
    const reported = new Set(result.findings.map((f) => f.path));
    const stale = Object.keys(ALLOWLIST).filter((p) => !reported.has(p));
    expect(stale, "these keys are now schema-covered; drop them from ALLOWLIST").toEqual([]);
  });
});
