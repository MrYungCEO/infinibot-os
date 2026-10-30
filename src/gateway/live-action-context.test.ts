import { describe, expect, it } from "vitest";
import {
  filterEvent,
  getDocModalitiesForSession,
  getDocScopeForSession,
  setDocModalitiesForSession,
  setDocScopeForSession,
  type DocScope,
  type LiveActionEvent,
} from "./live-action-context.js";

describe("live-action-context", () => {
  describe("filterEvent", () => {
    it("forwards everything when the session has no docScope", () => {
      const e: LiveActionEvent = { kind: "click", docScope: { docType: "note", documentId: "x" } };
      expect(filterEvent(null, e)).toBe(true);
      const e2: LiveActionEvent = { kind: "global" };
      expect(filterEvent(null, e2)).toBe(true);
    });

    it("forwards events whose docScope matches the session's docScope", () => {
      const scope: DocScope = { docType: "note", documentId: "abc" };
      const e: LiveActionEvent = {
        kind: "edit",
        docScope: { docType: "note", documentId: "abc" },
      };
      expect(filterEvent(scope, e)).toBe(true);
    });

    it("drops events whose docType doesn't match", () => {
      const scope: DocScope = { docType: "note", documentId: "abc" };
      const e: LiveActionEvent = {
        kind: "edit",
        docScope: { docType: "db_row", documentId: "abc" },
      };
      expect(filterEvent(scope, e)).toBe(false);
    });

    it("drops events whose documentId doesn't match", () => {
      const scope: DocScope = { docType: "note", documentId: "abc" };
      const e: LiveActionEvent = {
        kind: "edit",
        docScope: { docType: "note", documentId: "xyz" },
      };
      expect(filterEvent(scope, e)).toBe(false);
    });

    it("drops global events (no docScope) for doc-scoped sessions", () => {
      const scope: DocScope = { docType: "note", documentId: "abc" };
      const e: LiveActionEvent = { kind: "global-nav" };
      expect(filterEvent(scope, e)).toBe(false);
    });
  });

  describe("DocScope storage", () => {
    it("round-trips a doc scope by session key", () => {
      const sk = "agent:main:doc:note:abc";
      setDocScopeForSession(sk, { docType: "note", documentId: "abc", title: "Hello" });
      const got = getDocScopeForSession(sk);
      expect(got).toEqual({ docType: "note", documentId: "abc", title: "Hello" });
    });

    it("clears the doc scope on detach", () => {
      const sk = "agent:main:doc:note:detach-test";
      setDocScopeForSession(sk, { docType: "note", documentId: "x" });
      expect(getDocScopeForSession(sk)).not.toBeNull();
      setDocScopeForSession(sk, null);
      expect(getDocScopeForSession(sk)).toBeNull();
    });

    it("returns null for an unknown session", () => {
      expect(getDocScopeForSession("agent:nobody:doc:note:nope")).toBeNull();
    });

    it("ignores writes with no session key", () => {
      // No-op — undefined sessionKey shouldn't throw.
      expect(() =>
        setDocScopeForSession(undefined, { docType: "note", documentId: "x" }),
      ).not.toThrow();
    });
  });

  describe("Modality storage", () => {
    it("round-trips modality flags by session key", () => {
      const sk = "agent:main:doc:db_row:m1";
      setDocModalitiesForSession(sk, {
        sidePanel: true,
        voice: false,
        liveActionObserve: true,
        liveActionAct: false,
      });
      expect(getDocModalitiesForSession(sk)).toEqual({
        sidePanel: true,
        voice: false,
        liveActionObserve: true,
        liveActionAct: false,
      });
    });

    it("clears modalities when passed null", () => {
      const sk = "agent:main:doc:note:m-clear";
      setDocModalitiesForSession(sk, {
        sidePanel: true,
        voice: true,
        liveActionObserve: false,
        liveActionAct: false,
      });
      setDocModalitiesForSession(sk, null);
      expect(getDocModalitiesForSession(sk)).toBeNull();
    });
  });
});
