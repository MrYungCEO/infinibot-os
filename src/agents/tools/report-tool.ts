/**
 * Report agent tool — the ONE way an agent produces a styled black-gold PDF.
 *
 * Before this existed, an agent asked to "send a report" had only `telegram_send`,
 * which ships the raw Markdown text — so reports arrived as unstyled Markdown
 * instead of the canonical black-gold PDF. The full render pipeline
 * (`src/reports`) was healthy but unreachable from the agent layer: the only
 * report producers were code-side (gateway self-heal, event triggers) and the UI.
 *
 * This tool closes that gap. It routes through the existing gateway RPCs
 * `reports.render` and `reports.sendToTelegram` (which build the PDF from a
 * structured payload via the black-gold template and deliver it with
 * `sendDocument`), so agents get the same PDF as everything else and the report
 * is registered in /reports. Agents may pass either a structured `sections`
 * array OR a raw `markdown` string (converted via `markdownToPayload`), so a
 * Markdown-only agent still gets a styled PDF.
 *
 * Rendering goes through the gateway (puppeteer launches a child Chrome there,
 * always closed in a finally — see server-methods/reports.ts), so a render
 * crash never lands in the agent process. We use a generous timeout because a
 * cold puppeteer launch + paint can take well over the default 10s.
 */

import { Type } from "@sinclair/typebox";

import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";
import { markdownToPayload } from "../../reports/helpers/markdown-to-payload.js";
import type { ReportPayload, ReportSection } from "../../reports/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("tools").child("report");

/** Cold puppeteer launch + networkidle0 paint can exceed the default 10s. */
const RENDER_TIMEOUT_MS = 120_000;

const REPORT_ACTIONS = ["render", "send"] as const;

// Flattened schema (no top-level/nested anyOf — OpenAI + Claude/Vertex friendly).
// `sections` is left loosely typed (validated at runtime) to dodge the nested
// union/anyOf quirks; `markdown` is the convenience path for Markdown-only callers.
const ReportToolSchema = Type.Object({
  action: stringEnum(REPORT_ACTIONS),
  title: Type.Optional(
    Type.String({
      description: "Report title. Required unless inferable from markdown's first # H1.",
    }),
  ),
  subtitle: Type.Optional(Type.String({ description: "One-line description under the title." })),
  eyebrow: Type.Optional(
    Type.String({ description: 'Small uppercase eyebrow (default "InfiniBot · Report").' }),
  ),
  footer: Type.Optional(Type.String({ description: "Footer note (e.g. report kind / source)." })),
  markdown: Type.Optional(
    Type.String({
      description:
        "Raw Markdown body. Converted to structured sections automatically. Use this when you " +
        "already have the report as Markdown — it still renders as the styled black-gold PDF. " +
        "Provide either `markdown` or `sections`.",
    }),
  ),
  sections: Type.Optional(
    Type.Array(Type.Object({}, { additionalProperties: true }), {
      description:
        "Structured sections: [{ heading, body?, bullets?[], code?, count?, table?:{columns[],rows[][]} }]. " +
        "Provide either `sections` or `markdown`.",
    }),
  ),
  theme: Type.Optional(Type.String({ description: 'Theme name (default "black-gold").' })),
  category: Type.Optional(Type.String({ description: "Taxonomy bucket for /reports filtering." })),
  kind: Type.Optional(Type.String({ description: 'Report kind label (default "manual_render").' })),
  // Associations — which business object this report is ABOUT. Passing any of
  // these links the report to that object as it is created, so it shows up in
  // the object's Reports section (and in the objrel graph) with no second call.
  clientId: Type.Optional(
    Type.String({ description: "Associate the report with this client id." }),
  ),
  opportunityId: Type.Optional(
    Type.String({ description: "Associate the report with this opportunity id." }),
  ),
  projectId: Type.Optional(
    Type.String({ description: "Associate the report with this project id." }),
  ),
  // send-only
  caption: Type.Optional(Type.String({ description: "Telegram caption (defaults to the title)." })),
  chatId: Type.Optional(Type.String({ description: "Override the configured default chat id." })),
  runId: Type.Optional(
    Type.String({
      description:
        "send only: the run this report is about — its verification screenshots are attached " +
        "under the PDF automatically.",
    }),
  ),
  // gateway plumbing (rarely needed)
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
});

/** Build a renderable {@link ReportPayload} from the tool args. Throws on empty. */
function buildPayload(params: Record<string, unknown>): ReportPayload {
  const title = readStringParam(params, "title");
  const subtitle = readStringParam(params, "subtitle");
  const eyebrow = readStringParam(params, "eyebrow");
  const footer = readStringParam(params, "footer");
  const theme = readStringParam(params, "theme");

  const rawSections = Array.isArray(params.sections) ? (params.sections as unknown[]) : null;
  const markdown = typeof params.markdown === "string" ? params.markdown : "";

  // Markdown path (or markdown + no usable sections) → convert.
  if ((!rawSections || rawSections.length === 0) && markdown.trim()) {
    return markdownToPayload(markdown, { title, subtitle, eyebrow, footer, theme });
  }

  // Structured path — coerce loosely-typed section objects into ReportSection.
  const sections: ReportSection[] = (rawSections ?? [])
    .map((s): ReportSection | null => {
      if (!s || typeof s !== "object") return null;
      const obj = s as Record<string, unknown>;
      const heading = typeof obj.heading === "string" ? obj.heading : "";
      if (!heading.trim()) return null;
      const section: ReportSection = { heading };
      if (typeof obj.body === "string" && obj.body.trim()) section.body = obj.body;
      if (Array.isArray(obj.bullets)) {
        const bullets = obj.bullets.filter((b): b is string => typeof b === "string");
        if (bullets.length) section.bullets = bullets;
      }
      if (typeof obj.code === "string" && obj.code.trim()) section.code = obj.code;
      if (typeof obj.count === "number") section.count = obj.count;
      const table = obj.table as Record<string, unknown> | undefined;
      if (table && Array.isArray(table.columns) && Array.isArray(table.rows)) {
        const columns = table.columns.filter((c): c is string => typeof c === "string");
        const rows = (table.rows as unknown[])
          .filter((r): r is unknown[] => Array.isArray(r))
          .map((r) =>
            r.map((c) => (typeof c === "string" || typeof c === "number" ? c : String(c))),
          );
        if (columns.length) {
          section.table = { columns, rows };
          if (Array.isArray(table.pillColumns)) {
            const pc = table.pillColumns.filter((n): n is number => typeof n === "number");
            if (pc.length) section.table.pillColumns = pc;
          }
        }
      }
      return section;
    })
    .filter((s): s is ReportSection => s !== null);

  if (!title?.trim()) throw new Error("`title` is required when passing structured `sections`.");
  if (!sections.length) {
    throw new Error("Provide at least one valid section (with a heading) or a `markdown` body.");
  }

  const payload: ReportPayload = { title, sections };
  if (subtitle) payload.subtitle = subtitle;
  if (eyebrow) payload.eyebrow = eyebrow;
  if (footer) payload.footer = footer;
  if (theme) payload.theme = theme;
  return payload;
}

export function createReportTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Report",
    name: "report",
    description:
      "Render a structured report as the canonical InfiniBot black-gold PDF, and optionally " +
      "deliver it to Telegram. ALWAYS use this — not telegram_send — when delivering a report, " +
      "summary, digest, brief, or any multi-section document, so it ships as the styled PDF " +
      "instead of raw Markdown text. Pass either a `markdown` body (auto-converted) or structured " +
      "`sections`.\n" +
      "Actions:\n" +
      "- render: build the PDF, save it, and register it in /reports. Returns { filePath, bytes, id }.\n" +
      "- send: render AND deliver the PDF to Telegram (sendDocument). Returns { ok, messageId, filePath, id }.\n" +
      "\nWhen the report is ABOUT a specific client, opportunity or project, pass `clientId` / " +
      "`opportunityId` / `projectId`. The report is then associated with that object and appears in its " +
      "Reports section — always do this when you know what the report covers, so it is findable later " +
      "instead of only by title. Use the `object_relations` tool to associate an existing report.",
    parameters: ReportToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const payload = buildPayload(params);

      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl"),
        gatewayToken: readStringParam(params, "gatewayToken"),
        timeoutMs: RENDER_TIMEOUT_MS,
      };
      const kind = readStringParam(params, "kind");
      const category = readStringParam(params, "category");
      const sourceSession = opts?.agentSessionKey;
      // Association targets ride along with the render call; the gateway links
      // the report as soon as it has an id (see reports/associations.ts).
      const targets = {
        clientId: readStringParam(params, "clientId"),
        opportunityId: readStringParam(params, "opportunityId"),
        projectId: readStringParam(params, "projectId"),
      };

      if (action === "render") {
        const result = await callGatewayTool("reports.render", gatewayOpts, {
          payload,
          kind,
          category,
          sourceSession,
          ...targets,
        });
        log.info("rendered", { title: payload.title, sections: payload.sections.length });
        return jsonResult({ ok: true, ...(result as Record<string, unknown>) });
      }

      if (action === "send") {
        const result = (await callGatewayTool("reports.sendToTelegram", gatewayOpts, {
          payload,
          caption: readStringParam(params, "caption"),
          chatId: readStringParam(params, "chatId"),
          runId: readStringParam(params, "runId"),
          kind,
          category,
          sourceSession,
          ...targets,
        })) as Record<string, unknown>;
        log.info("sent", { title: payload.title, ok: result?.ok });
        // Surface a clear error if Telegram delivery failed (PDF still rendered).
        if (result && result.ok === false) {
          return jsonResult({
            ok: false,
            error: result.error ?? "telegram delivery failed",
            filePath: result.filePath,
            note: "The styled PDF rendered but Telegram delivery failed — check channels.telegram config.",
          });
        }
        return jsonResult({ ok: true, ...result });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
