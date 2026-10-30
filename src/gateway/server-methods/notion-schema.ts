/**
 * Gateway RPCs for Notion database schema reconciliation.
 *
 * Three methods, each addressing one stage of the operator's workflow when
 * an imported Notion database doesn't match InfiniBot's expected shape:
 *
 *   1. notion.schema.diff       — show what canonical properties the DB lacks.
 *   2. notion.schema.applyPatch — add missing properties via Notion PATCH.
 *   3. notion.schema.aiSuggest  — when property names diverge (not just
 *      missing), ask the configured LLM for an old-name → canonical-name
 *      mapping. The operator approves before any rename happens elsewhere.
 *
 * No method ever mutates a property's TYPE or removes properties — both
 * are destructive operations Notion can't undo for the operator. The diff
 * surface flags type-mismatches as advisories so the caller can decide.
 */
import { completeSimple } from "@mariozechner/pi-ai";
import { loadConfig } from "../../config/config.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import { pollNotionNow } from "../../databases/notion-bidirectional-sync.js";
import {
  ROLES_BY_ID,
  applySchemaPatch,
  applySchemaRename,
  buildAiSuggestPrompt,
  diffSchema,
  getDatabaseSchema,
  parseAiSuggestResponse,
} from "../../databases/notion-schema.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("notion-schema");

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isTextBlock(block: { type: string }): block is { type: "text"; text: string } {
  return block.type === "text";
}

export const notionSchemaHandlers: GatewayRequestHandlers = {
  /**
   * Inspect a Notion database and report which canonical properties for the
   * given role are missing, present-under-an-alias, or present-but-wrong-type.
   * Read-only. Safe to call from the wizard / dashboard / agent.
   */
  "notion.schema.diff": async ({ params, respond }) => {
    const dbId = asString((params as Record<string, unknown>)?.dbId);
    const role = asString((params as Record<string, unknown>)?.role);
    if (!dbId || !role) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "dbId and role required" });
      return;
    }
    if (!ROLES_BY_ID[role]) {
      respond(false, undefined, { code: "BAD_REQUEST", message: `unknown role: ${role}` });
      return;
    }
    try {
      const diff = await diffSchema(dbId, role);
      if (!diff) {
        respond(false, undefined, {
          code: "NOT_AVAILABLE",
          message: "Notion not configured or database unreachable",
        });
        return;
      }
      respond(true, diff);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Add the missing canonical properties to the DB. Additive only — never
   * deletes, never changes types. Operator must call diff first to know
   * what's about to be added.
   */
  "notion.schema.applyPatch": async ({ params, respond }) => {
    const dbId = asString((params as Record<string, unknown>)?.dbId);
    const roleId = asString((params as Record<string, unknown>)?.role);
    if (!dbId || !roleId) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "dbId and role required" });
      return;
    }
    const role = ROLES_BY_ID[roleId];
    if (!role) {
      respond(false, undefined, { code: "BAD_REQUEST", message: `unknown role: ${roleId}` });
      return;
    }
    try {
      const diff = await diffSchema(dbId, roleId);
      if (!diff) {
        respond(false, undefined, {
          code: "NOT_AVAILABLE",
          message: "Notion not configured or database unreachable",
        });
        return;
      }
      const result = await applySchemaPatch(dbId, role, diff);
      log.info("schema patch applied", { dbId, role: roleId, applied: result.applied });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Force a one-shot Notion → local pull outside the periodic timer. Useful
   * from a "Sync now" UI button. Returns counts so the operator gets
   * immediate feedback ({projects: 3, tasks: 0} = "three project edits
   * pulled from Notion this round").
   */
  "notion.sync.pullNow": async ({ respond }) => {
    try {
      const result = await pollNotionNow();
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Apply a {existing → canonical} property rename to the Notion DB. The
   * caller normally builds the mapping by editing what `aiSuggest` returned
   * and presenting it in a confirm-screen.
   *
   * Skips identity renames, missing-source properties, and target-already-
   * exists conflicts (those would 409 from Notion). The response splits
   * `applied` from `skipped` so the UI can show what landed and why the
   * rest didn't.
   */
  "notion.schema.applyRename": async ({ params, respond }) => {
    const dbId = asString((params as Record<string, unknown>)?.dbId);
    const roleId = asString((params as Record<string, unknown>)?.role);
    const rawMapping = (params as Record<string, unknown>)?.mapping;
    if (!dbId || !roleId) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "dbId and role required" });
      return;
    }
    const role = ROLES_BY_ID[roleId];
    if (!role) {
      respond(false, undefined, { code: "BAD_REQUEST", message: `unknown role: ${roleId}` });
      return;
    }
    if (!rawMapping || typeof rawMapping !== "object" || Array.isArray(rawMapping)) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "mapping must be an object" });
      return;
    }
    const mapping: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawMapping as Record<string, unknown>)) {
      if (typeof v === "string" && k && v) mapping[k] = v;
    }
    try {
      const result = await applySchemaRename(dbId, role, mapping);
      log.info("schema rename applied", {
        dbId,
        role: roleId,
        applied: result.applied.length,
        skipped: result.skipped.length,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * AI-driven property name suggestion for imported DBs. The DB has the
   * RIGHT semantic fields under WRONG names (e.g. "Job Name" instead of
   * "Project"); the model returns a {existing → canonical} mapping the
   * operator can approve. We never apply renames automatically — Notion's
   * rename API touches every page in the DB and the operator deserves a
   * preview.
   */
  "notion.schema.aiSuggest": async ({ params, respond }) => {
    const dbId = asString((params as Record<string, unknown>)?.dbId);
    const roleId = asString((params as Record<string, unknown>)?.role);
    if (!dbId || !roleId) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "dbId and role required" });
      return;
    }
    const role = ROLES_BY_ID[roleId];
    if (!role) {
      respond(false, undefined, { code: "BAD_REQUEST", message: `unknown role: ${roleId}` });
      return;
    }

    const cfg = loadConfig();
    const primary = (cfg as { agents?: { defaults?: { model?: { primary?: string } } } })
      ?.agents?.defaults?.model?.primary;
    if (!primary || !primary.includes("/")) {
      respond(false, undefined, {
        code: "NO_MODEL",
        message: "No primary model configured (set agents.defaults.model.primary)",
      });
      return;
    }
    const [provider, ...modelParts] = primary.split("/");
    const modelId = modelParts.join("/");
    const resolved = resolveModel(provider, modelId, undefined, cfg);
    if (!resolved.model) {
      respond(false, undefined, {
        code: "MODEL_UNRESOLVED",
        message: resolved.error ?? `Unknown model: ${primary}`,
      });
      return;
    }

    let apiKey: string;
    try {
      apiKey = requireApiKey(
        await getApiKeyForModel({ model: resolved.model, cfg }),
        provider,
      );
    } catch (e) {
      respond(false, undefined, { code: "NO_API_KEY", message: String(e) });
      return;
    }

    let existingProps: Array<{ name: string; type: string }> = [];
    try {
      const schema = await getDatabaseSchema(dbId, { force: true });
      if (!schema) {
        respond(false, undefined, {
          code: "NOT_AVAILABLE",
          message: "Notion not configured or database unreachable",
        });
        return;
      }
      existingProps = Array.from(schema.byName.entries()).map(([name, type]) => ({ name, type }));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      return;
    }

    const prompt = buildAiSuggestPrompt(role, existingProps);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await completeSimple(
          resolved.model,
          {
            messages: [
              { role: "user", content: `${prompt.system}\n\n${prompt.user}`, timestamp: Date.now() },
            ],
          },
          {
            apiKey,
            maxTokens: 1024,
            temperature: 0.1,
            signal: controller.signal,
          },
        );
        const text = res.content
          .filter(isTextBlock)
          .map((b) => b.text)
          .join("");
        const suggestion = parseAiSuggestResponse(text, role);
        respond(true, {
          ...suggestion,
          existingProps,
          // Echo the role's canonical property list so the UI can render the
          // mapping side-by-side without a second round-trip.
          canonical: role.properties.map((p) => ({ canonical: p.canonical, type: p.type, required: p.required })),
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      respond(false, undefined, { code: "AI_FAILED", message: String(e) });
    }
  },
};
