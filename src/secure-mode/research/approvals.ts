/**
 * Approval gate for secure research queries.
 *
 * In "ask" mode (the default) a run stops before any network call and waits
 * for the owner to Approve, Edit or Deny the exact query list in the secure
 * chat. Edited queries are sanitized again; if the sanitizer would change
 * them, the edit is refused with the sanitized text so the card can show it
 * and ask once more. What the owner finally approves is byte-for-byte what is
 * sent: "Only these words will leave this machine".
 *
 * Pending requests live in memory only. WS events carry ids and status, never
 * the queries — clients fetch them over the authenticated RPC.
 */

import { sanitizeQuery, type SanitizeContext } from "./sanitizer.js";

export type ApprovalDecision =
  | { decision: "approve"; queries: string[]; edited: boolean; by?: string }
  | { decision: "deny"; by?: string }
  | { decision: "expired" }
  | { decision: "aborted" };

export type PendingApproval = {
  id: string;
  sessionKey?: string;
  goal: string;
  queries: string[];
  createdAt: number;
  expiresAt: number;
  /** Sanitizer context for edits (vault terms). Never sent to clients. */
  ctx: SanitizeContext;
  maxQueries: number;
};

export type PendingApprovalView = Omit<PendingApproval, "ctx">;

export const SECURE_RESEARCH_EVENT = "secure.research.changed";

type Entry = {
  pending: PendingApproval;
  resolve: (d: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
};

type Broadcast = (event: string, payload: unknown) => void;

export class ResearchApprovalError extends Error {
  readonly code = "INVALID_REQUEST";
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ResearchApprovalError";
  }
}

export class ResearchApprovals {
  private entries = new Map<string, Entry>();
  private broadcast: Broadcast | null = null;

  setBroadcaster(fn: Broadcast | null): void {
    this.broadcast = fn;
  }

  emit(id: string, sessionKey: string | undefined, status: string): void {
    this.broadcast?.(SECURE_RESEARCH_EVENT, {
      id,
      sessionKey: sessionKey ?? null,
      status,
      at: Date.now(),
    });
  }

  /** Register a request and wait for the owner's decision (or timeout / abort). */
  wait(pending: PendingApproval, signal?: AbortSignal): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const finish = (d: ApprovalDecision) => {
        const e = this.entries.get(pending.id);
        if (!e) return;
        clearTimeout(e.timer);
        if (e.onAbort) e.signal?.removeEventListener("abort", e.onAbort);
        this.entries.delete(pending.id);
        resolve(d);
      };
      const timer = setTimeout(
        () => {
          finish({ decision: "expired" });
          this.emit(pending.id, pending.sessionKey, "expired");
        },
        Math.max(1_000, pending.expiresAt - Date.now()),
      );
      const entry: Entry = { pending, resolve: finish, timer };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          resolve({ decision: "aborted" });
          return;
        }
        entry.signal = signal;
        entry.onAbort = () => {
          finish({ decision: "aborted" });
          this.emit(pending.id, pending.sessionKey, "aborted");
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.entries.set(pending.id, entry);
      this.emit(pending.id, pending.sessionKey, "pending_approval");
    });
  }

  list(sessionKey?: string): PendingApprovalView[] {
    return [...this.entries.values()]
      .map((e) => e.pending)
      .filter((p) => !sessionKey || p.sessionKey === sessionKey)
      .map(({ ctx: _ctx, ...view }) => view);
  }

  get(id: string): PendingApprovalView | null {
    const e = this.entries.get(id);
    if (!e) return null;
    const { ctx: _ctx, ...view } = e.pending;
    return view;
  }

  /**
   * Resolve a pending request. `queries` (optional) is the owner's edited list.
   * Throws ResearchApprovalError (with `sanitized`) when an edit would not be
   * sent verbatim.
   */
  resolve(
    id: string,
    decision: "approve" | "deny",
    queries?: unknown,
    by?: string,
  ): ApprovalDecision {
    const e = this.entries.get(id);
    if (!e)
      throw new ResearchApprovalError(
        `no pending research request ${id} (already decided or expired)`,
      );
    if (decision === "deny") {
      const d: ApprovalDecision = { decision: "deny", by };
      e.resolve(d);
      this.emit(id, e.pending.sessionKey, "denied");
      return d;
    }
    let final = e.pending.queries;
    let edited = false;
    if (Array.isArray(queries)) {
      const cleaned = queries
        .filter((q): q is string => typeof q === "string")
        .map((q) => q.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (!cleaned.length)
        throw new ResearchApprovalError("approve needs at least one query (or deny)");
      if (cleaned.length > e.pending.maxQueries)
        throw new ResearchApprovalError(`at most ${e.pending.maxQueries} queries per batch`);
      const sanitized = cleaned.map((q) => sanitizeQuery(q, e.pending.ctx));
      const changed = sanitized.some((s, i) => !s.ok || s.query !== cleaned[i]);
      if (changed) {
        throw new ResearchApprovalError(
          "An edited query still contains personal details. Review the sanitized version and approve again.",
          {
            sanitized: sanitized.map((s) => ({
              query: s.query,
              ok: s.ok,
              removed: s.removed.map((r) => r.kind),
              ...(s.reason ? { reason: s.reason } : {}),
            })),
          },
        );
      }
      edited = cleaned.join("\n") !== e.pending.queries.join("\n");
      final = cleaned;
    }
    const d: ApprovalDecision = { decision: "approve", queries: final, edited, by };
    e.resolve(d);
    this.emit(id, e.pending.sessionKey, "approved");
    return d;
  }

  /** Sanitize a draft edit with the request's own context (nothing is sent). */
  preview(
    id: string,
    queries: unknown,
  ): Array<{ query: string; ok: boolean; removed: string[]; reason?: string }> {
    const e = this.entries.get(id);
    if (!e) throw new ResearchApprovalError(`no pending research request ${id}`);
    const list = Array.isArray(queries)
      ? queries.filter((q): q is string => typeof q === "string")
      : [];
    return list.slice(0, e.pending.maxQueries).map((q) => {
      const s = sanitizeQuery(q, e.pending.ctx);
      return {
        query: s.query,
        ok: s.ok,
        removed: s.removed.map((r) => r.kind),
        ...(s.reason ? { reason: s.reason } : {}),
      };
    });
  }

  /** Drop every pending request (Secure Mode locked / shutdown). */
  clear(): void {
    for (const [id, e] of Array.from(this.entries)) {
      e.resolve({ decision: "aborted" });
      this.emit(id, e.pending.sessionKey, "aborted");
    }
  }
}

let singleton: ResearchApprovals | null = null;

export function getResearchApprovals(): ResearchApprovals {
  singleton ??= new ResearchApprovals();
  return singleton;
}

export function setResearchApprovalsForTests(a: ResearchApprovals | null): void {
  singleton = a;
}
