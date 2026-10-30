import { describe, expect, it, vi } from "vitest";
import { docAgentHandlers } from "./doc-agent.js";
import {
  getDocModalitiesForSession,
  getDocScopeForSession,
  setDocModalitiesForSession,
  setDocScopeForSession,
} from "../live-action-context.js";

/**
 * The handlers expect a GatewayRequestHandlerOptions shape but only
 * actually read `params` and call `respond`. Build a minimal stub.
 */
function call(method: keyof typeof docAgentHandlers, params: Record<string, unknown>) {
  return new Promise<{ ok: boolean; payload: unknown; error: unknown }>((resolve) => {
    const respond = vi.fn((ok: boolean, payload: unknown, error: unknown) => {
      resolve({ ok, payload, error });
    });
    void docAgentHandlers[method]({
      req: { id: "t", type: "req", method: method as string },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });
  });
}

describe("doc-agent gateway handlers", () => {
  describe("doc_agent.spawn", () => {
    it("rejects missing documentId", async () => {
      const r = await call("doc_agent.spawn", { docType: "note" });
      expect(r.ok).toBe(false);
      expect((r.error as { code: string }).code).toBe("BAD_REQUEST");
    });

    it("returns a doc-scoped sessionKey for each new docType", async () => {
      const types = [
        "content_page",
        "storyboard",
        "whiteboard_doc",
        "video_composition",
        "brand_doc",
        "funnel_page",
        "inbox_thread",
      ];
      const seen = new Set<string>();
      for (const docType of types) {
        const r = await call("doc_agent.spawn", { docType, documentId: `doc-${docType}` });
        expect(r.ok).toBe(true);
        const p = r.payload as { sessionKey: string; docType: string; capabilities: unknown };
        expect(p.docType).toBe(docType);
        expect(p.sessionKey).toMatch(/^agent:[^:]+:doc:[^:]+:/);
        expect(p.capabilities).toBeDefined();
        seen.add(p.sessionKey);
      }
      expect(seen.size).toBe(types.length); // distinct keys per docType
    });

    it("produces distinct session keys per documentId on the same docType", async () => {
      const r1 = await call("doc_agent.spawn", { docType: "note", documentId: "d1" });
      const r2 = await call("doc_agent.spawn", { docType: "note", documentId: "d2" });
      const k1 = (r1.payload as { sessionKey: string }).sessionKey;
      const k2 = (r2.payload as { sessionKey: string }).sessionKey;
      expect(k1).not.toBe(k2);
    });

    it("returns the per-docType capability matrix in the response", async () => {
      const r = await call("doc_agent.spawn", { docType: "brand_doc", documentId: "brand-1" });
      const p = r.payload as { capabilities: { liveActionObserve: boolean } };
      // brand_doc has liveActionObserve: false by matrix.
      expect(p.capabilities.liveActionObserve).toBe(false);
    });
  });

  describe("doc_agent.attach_live_action + detach_live_action", () => {
    it("attach stores a DocScope; detach clears it", async () => {
      const sessionKey = "agent:test:doc:note:attach-1";
      // Ensure clean state.
      setDocScopeForSession(sessionKey, null);

      const attached = await call("doc_agent.attach_live_action", {
        sessionKey,
        docType: "note",
        documentId: "doc-1",
        title: "Hi",
      });
      expect(attached.ok).toBe(true);
      expect(getDocScopeForSession(sessionKey)).toEqual({
        docType: "note",
        documentId: "doc-1",
        title: "Hi",
      });

      const detached = await call("doc_agent.detach_live_action", { sessionKey });
      expect(detached.ok).toBe(true);
      expect(getDocScopeForSession(sessionKey)).toBeNull();
    });

    it("refuses to attach when the docType has liveActionObserve=false", async () => {
      const sessionKey = "agent:test:doc:brand_doc:no-observe";
      const r = await call("doc_agent.attach_live_action", {
        sessionKey,
        docType: "brand_doc",
        documentId: "brand-x",
      });
      expect(r.ok).toBe(false);
      expect((r.error as { code: string }).code).toBe("CAPABILITY_DENIED");
      expect(getDocScopeForSession(sessionKey)).toBeNull();
    });

    it("rejects attach when sessionKey is missing", async () => {
      const r = await call("doc_agent.attach_live_action", { docType: "note", documentId: "x" });
      expect(r.ok).toBe(false);
      expect((r.error as { code: string }).code).toBe("BAD_REQUEST");
    });
  });

  describe("doc_agent.set_modalities + get_modalities", () => {
    it("round-trips modalities and clamps against the capability matrix", async () => {
      const sessionKey = "agent:test:doc:content_page:mod-1";
      setDocModalitiesForSession(sessionKey, null); // clean

      const r = await call("doc_agent.set_modalities", {
        sessionKey,
        docType: "content_page",
        modalities: {
          sidePanel: true,
          voice: true,
          liveActionObserve: true,
          liveActionAct: true, // content_page has act=false in the matrix
        },
      });
      expect(r.ok).toBe(true);
      const p = r.payload as { modalities: { liveActionAct: boolean; liveActionObserve: boolean } };
      // Server clamps liveActionAct off; observe remains on.
      expect(p.modalities.liveActionAct).toBe(false);
      expect(p.modalities.liveActionObserve).toBe(true);

      // get_modalities returns the stored set.
      const g = await call("doc_agent.get_modalities", { sessionKey });
      expect(g.ok).toBe(true);
      const gp = g.payload as { modalities: { liveActionObserve: boolean } };
      expect(gp.modalities.liveActionObserve).toBe(true);
      expect(getDocModalitiesForSession(sessionKey)?.liveActionAct).toBe(false);
    });

    it("rejects set_modalities without sessionKey", async () => {
      const r = await call("doc_agent.set_modalities", { docType: "note", modalities: {} });
      expect(r.ok).toBe(false);
      expect((r.error as { code: string }).code).toBe("BAD_REQUEST");
    });
  });
});
