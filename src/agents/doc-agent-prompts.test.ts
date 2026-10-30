import { describe, expect, it } from "vitest";
import {
  DOC_AGENT_CAPABILITIES,
  buildDocAgentSystemPrompt,
  clampModalities,
  docAgentSessionKey,
  type DocAgentType,
} from "./doc-agent-prompts.js";

const ALL_TYPES: DocAgentType[] = [
  "note",
  "db_row",
  "workflow",
  "project",
  "kanban_card",
  "content_page",
  "storyboard",
  "whiteboard_doc",
  "video_composition",
  "brand_doc",
  "funnel_page",
  "inbox_thread",
  "generic",
];

const NEW_TYPES: DocAgentType[] = [
  "content_page",
  "storyboard",
  "whiteboard_doc",
  "video_composition",
  "brand_doc",
  "funnel_page",
  "inbox_thread",
];

/**
 * Each new docType should explicitly name its preferred tool in the
 * system prompt — if these strings diverge from the PER_TYPE entries,
 * the test fails loudly and we know to refresh the table in
 * docs/doc-agent-universal-plan.md too.
 */
const PREFERRED_TOOL_TOKEN: Record<DocAgentType, string> = {
  note: "notes_tool",
  db_row: "databases_tool",
  workflow: "workflows_tool",
  project: "kanban_tool",
  kanban_card: "kanban_tool",
  content_page: "content.pages",
  storyboard: "storyboard_tool",
  whiteboard_doc: "excalidraw_",
  video_composition: "compositions",
  brand_doc: "branding",
  funnel_page: "funnels",
  inbox_thread: "gmail",
  generic: "Ask what kind of document",
};

describe("doc-agent-prompts", () => {
  describe("buildDocAgentSystemPrompt", () => {
    for (const docType of ALL_TYPES) {
      it(`produces a non-empty prompt that references the documentId for docType=${docType}`, () => {
        const prompt = buildDocAgentSystemPrompt({
          docType,
          documentId: "doc-123",
          title: "T",
        });
        expect(prompt.length).toBeGreaterThan(0);
        expect(prompt).toContain("doc-123");
        // Hard cap so a runaway PER_TYPE entry can't blow the token budget.
        expect(prompt.length).toBeLessThan(4096);
      });

      it(`names the preferred tool surface for docType=${docType}`, () => {
        const prompt = buildDocAgentSystemPrompt({ docType, documentId: "x" });
        expect(prompt).toContain(PREFERRED_TOOL_TOKEN[docType]);
      });
    }

    it("packs schema + extra + content into the prompt when provided", () => {
      const prompt = buildDocAgentSystemPrompt({
        docType: "db_row",
        documentId: "row-1",
        databaseId: "db-1",
        schema: "title: title\nstatus: select",
        extra: "stage=qualified",
        content: "Hello world",
      });
      expect(prompt).toContain("database_id: db-1");
      expect(prompt).toContain("title: title");
      expect(prompt).toContain("stage=qualified");
      expect(prompt).toContain("Hello world");
    });

    it("truncates long content to keep the prompt bounded", () => {
      const big = "a".repeat(20_000);
      const prompt = buildDocAgentSystemPrompt({
        docType: "note",
        documentId: "n",
        content: big,
      });
      expect(prompt).toContain("…[truncated]");
      // Prompt itself stays well under the 4KB hard cap even with content
      // injected, because content is sliced to ~6KB but the total file
      // capacity already accounts for the BASE_RULES + PER_TYPE block.
      expect(prompt.length).toBeLessThan(8192);
    });
  });

  describe("docAgentSessionKey", () => {
    it("returns a distinct key per (agent, docType, documentId) triple", () => {
      const a = docAgentSessionKey("main", "note", "doc-1");
      const b = docAgentSessionKey("main", "note", "doc-2");
      const c = docAgentSessionKey("main", "db_row", "doc-1");
      const d = docAgentSessionKey("other", "note", "doc-1");
      expect(new Set([a, b, c, d]).size).toBe(4);
    });

    it("sanitises documentId to a safe slug", () => {
      const key = docAgentSessionKey("main", "note", "weird id/with::chars?#");
      expect(key.startsWith("agent:main:doc:note:")).toBe(true);
      const tail = key.slice("agent:main:doc:note:".length);
      // All chars in the tail must be safe — a-zA-Z0-9._-
      expect(/^[A-Za-z0-9._-]+$/.test(tail)).toBe(true);
    });

    it("returns a stable key on repeated calls", () => {
      expect(docAgentSessionKey("a", "note", "id")).toBe(docAgentSessionKey("a", "note", "id"));
    });

    it("matches the doc-scoped session detection regex used by server-voice-stream", () => {
      // Voice-stream uses /^agent:[^:]+:doc:[^:]+:/ to decide whether to
      // apply the doc preamble. Every key shape from this builder must
      // satisfy that pattern, or the voice router won't route correctly.
      const re = /^agent:[^:]+:doc:[^:]+:/;
      for (const docType of NEW_TYPES) {
        const key = docAgentSessionKey("main", docType, "id-1");
        expect(re.test(key)).toBe(true);
      }
    });
  });

  describe("DOC_AGENT_CAPABILITIES + clampModalities", () => {
    it("declares a capability entry for every docType", () => {
      for (const docType of ALL_TYPES) {
        expect(DOC_AGENT_CAPABILITIES[docType]).toBeDefined();
        expect(DOC_AGENT_CAPABILITIES[docType].sidePanel).toBe(true);
      }
    });

    it("clamps liveActionAct to false when the docType doesn't support it", () => {
      // content_page has liveActionAct: false in the matrix.
      const clamped = clampModalities("content_page", {
        sidePanel: true,
        voice: true,
        liveActionObserve: true,
        liveActionAct: true,
      });
      expect(clamped.liveActionAct).toBe(false);
      expect(clamped.liveActionObserve).toBe(true);
    });

    it("clamps liveActionObserve to false for brand_doc (matrix: off)", () => {
      const clamped = clampModalities("brand_doc", {
        liveActionObserve: true,
      });
      expect(clamped.liveActionObserve).toBe(false);
    });

    it("allows sidePanel + voice on every docType by default", () => {
      for (const docType of ALL_TYPES) {
        const clamped = clampModalities(docType, {});
        expect(clamped.sidePanel).toBe(true);
        expect(clamped.voice).toBe(true);
      }
    });

    it("respects explicit voice=false", () => {
      const clamped = clampModalities("note", { voice: false });
      expect(clamped.voice).toBe(false);
    });
  });
});
