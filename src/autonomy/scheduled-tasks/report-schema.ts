/**
 * The standard work-suggestion report contract.
 *
 * The assignee writes `report.json` in the run's artifact dir; it must pass
 * {@link validateReport} (JSON schema + a few semantic rules). The same checks
 * are written into a standalone `validate-report.mjs` next to it, which is one
 * of the suggestion goal run's completion checks. The agent gets the exact
 * errors back as feedback and fixes the file; it cannot "finish" with a
 * malformed report.
 */

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import AjvPkg, { type ErrorObject } from "ajv";
import { Type, type Static } from "@sinclair/typebox";
import { GoalCheckSchema } from "../../gateway/protocol/schema/goals.js";
import type { SuggestionReport } from "./types.js";

export const REPORT_TEMPLATE_ID = "work-suggestions-v1";

const Str = (max = 4000) => Type.String({ minLength: 1, maxLength: max });
const OptNum = Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]));
const OptStr = Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]));

export const RepoHealthSchema = Type.Object(
  {
    repo: Str(200),
    branch: Str(300),
    ahead: OptNum,
    behind: OptNum,
    openPRs: OptNum,
    openIssues: OptNum,
    ci: OptStr,
    failingTests: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 })),
    uncommittedChanges: OptNum,
    staleBranches: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 100 })),
    deployStatus: OptStr,
    notes: Type.Optional(Type.String({ maxLength: 4000 })),
  },
  { additionalProperties: false },
);

export const WorkItemSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9._-]+$" }),
    title: Str(200),
    why: Str(4000),
    priority: Type.Union([
      Type.Literal("P0"),
      Type.Literal("P1"),
      Type.Literal("P2"),
      Type.Literal("P3"),
    ]),
    effort: Type.Union([Type.Literal("S"), Type.Literal("M"), Type.Literal("L")]),
    risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    repo: Str(200),
    files: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 100 }),
    dev: Type.Object(
      { steps: Type.Array(Str(2000), { minItems: 1, maxItems: 30 }) },
      { additionalProperties: false },
    ),
    checks: Type.Array(GoalCheckSchema, { minItems: 1, maxItems: 20 }),
    deploy: Type.Object(
      {
        steps: Type.Array(Str(2000), { minItems: 1, maxItems: 30 }),
        rollback: Str(4000),
        command: Type.Optional(Type.String({ maxLength: 4000 })),
        checks: Type.Optional(Type.Array(GoalCheckSchema, { maxItems: 20 })),
      },
      { additionalProperties: false },
    ),
    approvals: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 10 }),
  },
  { additionalProperties: false },
);

export const SuggestionReportSchema = Type.Object(
  {
    summary: Str(8000),
    repos: Type.Array(RepoHealthSchema, { maxItems: 30 }),
    items: Type.Array(WorkItemSchema, { maxItems: 50 }),
  },
  { additionalProperties: false },
);

export type SuggestionReportShape = Static<typeof SuggestionReportSchema>;

/**
 * Rules JSON schema can't express. Self-contained on purpose: its source is
 * embedded verbatim into the standalone validator script.
 */
export function semanticReportErrors(report: unknown, repoLabels: string[]): string[] {
  const errors: string[] = [];
  const r = report as { items?: Array<Record<string, unknown>> };
  const seen = new Set<string>();
  for (const [i, item] of (r.items ?? []).entries()) {
    const id = String(item.id ?? "");
    if (seen.has(id)) errors.push(`/items/${i}/id duplicate id "${id}"`);
    seen.add(id);
    if (repoLabels.length && !repoLabels.includes(String(item.repo)))
      errors.push(`/items/${i}/repo must be one of: ${repoLabels.join(", ")}`);
    const checks = [
      ...((item.checks as Array<Record<string, unknown>>) ?? []).map((c) => ["checks", c] as const),
      ...(
        ((item.deploy as Record<string, unknown>)?.checks as Array<Record<string, unknown>>) ?? []
      ).map((c) => ["deploy/checks", c] as const),
    ];
    for (const [j, [where, c]] of checks.entries()) {
      const need =
        c.type === "shell"
          ? "command"
          : c.type === "llm"
            ? "criterion"
            : c.type === "file"
              ? "path"
              : c.type === "grep"
                ? c.path
                  ? "pattern"
                  : "path"
                : null;
      if (need && !(typeof c[need] === "string" && (c[need] as string).trim()))
        errors.push(`/items/${i}/${where}[${j}] (${String(c.type)}) needs "${need}"`);
    }
  }
  return errors;
}

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
});
const validateFn = ajv.compile(SuggestionReportSchema);

export interface ReportValidation {
  ok: boolean;
  errors: string[];
  report: SuggestionReport | null;
}

export function validateReport(raw: unknown, repoLabels: string[] = []): ReportValidation {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return { ok: false, errors: [`not valid JSON: ${(err as Error).message}`], report: null };
    }
  }
  const errors: string[] = [];
  if (!validateFn(data)) {
    for (const e of (validateFn.errors ?? []) as ErrorObject[])
      errors.push(`${e.instancePath || "/"} ${e.message ?? "invalid"}`);
  }
  if (errors.length === 0) errors.push(...semanticReportErrors(data, repoLabels));
  return errors.length
    ? { ok: false, errors: errors.slice(0, 40), report: null }
    : { ok: true, errors: [], report: data as SuggestionReport };
}

/** Write the standalone validator used as the suggestion run's shell check. */
export function writeStandaloneValidator(file: string, repoLabels: string[]): void {
  const req = createRequire(import.meta.url);
  const ajvUrl = pathToFileURL(req.resolve("ajv")).href;
  const src = `// Generated by InfiniBot scheduled tasks — validates report.json against the
// ${REPORT_TEMPLATE_ID} contract. Usage: node validate-report.mjs [report.json]
import { readFileSync } from "node:fs";
import AjvMod from ${JSON.stringify(ajvUrl)};
const Ajv = AjvMod.default ?? AjvMod;
const schema = ${JSON.stringify(SuggestionReportSchema)};
const repoLabels = ${JSON.stringify(repoLabels)};
const semanticReportErrors = ${semanticReportErrors.toString()};
const file = process.argv[2] || new URL("./report.json", import.meta.url).pathname;
let data;
try { data = JSON.parse(readFileSync(file, "utf8")); }
catch (e) { console.error("report.json is missing or not valid JSON: " + e.message); process.exit(1); }
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
let errors = [];
if (!validate(data)) errors = validate.errors.map((e) => (e.instancePath || "/") + " " + e.message);
if (!errors.length) errors = semanticReportErrors(data, repoLabels);
if (errors.length) { console.error("report.json is invalid:\\n- " + errors.slice(0, 40).join("\\n- ")); process.exit(1); }
console.log("report.json is valid: " + data.items.length + " item(s), " + data.repos.length + " repo(s)");
`;
  writeFileSync(file, src, "utf8");
}

/** A compact example the prompt shows the assignee. */
export const EXAMPLE_REPORT: SuggestionReport = {
  summary: "One-paragraph overview of repo health and what matters most today.",
  repos: [
    {
      repo: "<repo label>",
      branch: "main",
      ahead: 3,
      behind: 0,
      openPRs: 1,
      openIssues: 4,
      ci: "passing | failing: <job> | unknown",
      failingTests: [],
      uncommittedChanges: 0,
      staleBranches: [],
      deployStatus: "live at <url>, deployed <when> | unknown",
      notes: "",
    },
  ],
  items: [
    {
      id: "fix-login-timeout",
      title: "Short imperative title",
      why: "Why it matters / impact, with evidence (file:line, failing job, log).",
      priority: "P1",
      effort: "S",
      risk: "low",
      repo: "<repo label>",
      files: ["src/auth/login.ts"],
      dev: { steps: ["Step 1", "Step 2"] },
      checks: [
        { type: "shell", label: "unit tests", command: "pnpm vitest run src/auth" },
        { type: "grep", path: "src/auth/login.ts", pattern: "timeoutMs" },
      ],
      deploy: {
        steps: ["How to ship it"],
        rollback: "How to undo it",
        checks: [{ type: "shell", command: "curl -fsS https://example/health" }],
      },
      approvals: ["merge", "deploy"],
    },
  ],
};
