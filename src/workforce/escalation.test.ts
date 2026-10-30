import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  composeEscalationMessage,
  parseApprovalDirective,
  parseEscalationReference,
} from "./escalation-compose.js";
import { isWithinQuietHours, nextDigestAt, quietHoursEndAt } from "./escalation-schedule.js";
import { EscalationService, type EscalationTransport } from "./escalation-service.js";
import { WorkforceEscalationStore } from "./escalation-store.js";
import {
  defaultDedupeKey,
  defaultEscalationPolicy,
  ESCALATION_MEMORY_NAMESPACE,
  normalizeEscalationInput,
  normalizeEscalationPolicy,
  redactSecrets,
} from "./escalation-types.js";
import { defaultCommunicationProfile, type CommunicationProfile } from "./communication.js";
import { WorkforceOperatingStore } from "./operating-store.js";
import { WorkforceStore } from "./store.js";

const AGENCY = "agency-esc";
/** Friday 2026-07-24, 10:00 UTC — inside default quiet-hours-free daytime. */
const NOON = Date.UTC(2026, 6, 24, 10, 0, 0);

function profileWith(patch: Partial<CommunicationProfile>): CommunicationProfile {
  return { ...defaultCommunicationProfile(NOON), ...patch };
}

describe("escalation protocol", () => {
  let directory: string;
  let dbPath: string;
  let workforce: WorkforceStore;
  let operating: WorkforceOperatingStore;
  let store: WorkforceEscalationStore;
  let transport: ReturnType<typeof vi.fn>;
  let clock: number;
  let service: EscalationService;

  const build = (overrides: { transport?: EscalationTransport } = {}) =>
    new EscalationService({
      store,
      workerStore: workforce,
      operatingStore: operating,
      transport: overrides.transport ?? (transport as unknown as EscalationTransport),
      now: () => clock,
    });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "infinibot-esc-"));
    dbPath = join(directory, "agency.db");
    workforce = new WorkforceStore(dbPath);
    workforce.createWorker({
      agencyId: AGENCY,
      id: "mercury",
      type: "ai",
      displayName: "Mercury",
      communicationProfile: profileWith({}),
    });
    workforce.upsertChannelBinding(AGENCY, {
      workerId: "mercury",
      channelId: "slack",
      target: "C-OWNER",
      direction: "both",
    });
    operating = new WorkforceOperatingStore(dbPath);
    store = new WorkforceEscalationStore(dbPath);
    transport = vi.fn(async () => ({ messageId: "m-1" }));
    clock = NOON;
    service = build();
  });

  afterEach(() => {
    store.close();
    operating.close();
    workforce.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const raise = (patch: Record<string, unknown> = {}) =>
    service.raise(AGENCY, {
      workerId: "mercury",
      kind: "blocked",
      title: "Stripe webhook signature keeps failing",
      summary: "Three consecutive retries failed with a 401 from the billing service.",
      urgency: "critical",
      ...patch,
    } as Parameters<EscalationService["raise"]>[1]);

  // ── 1. Composition through the communication profile ──────────────────────

  it("composes each kind through the employee's own profile", () => {
    const blunt = profileWith({ tone: "blunt", verbosity: "terse", emojiUse: "none" });
    const warm = profileWith({
      tone: "friendly",
      verbosity: "detailed",
      emojiUse: "sparing",
      greeting: "Morning!",
      signOff: "— Mercury",
    });
    const base = {
      urgency: "normal" as const,
      title: "Q3 budget split",
      summary: "The retainer covers two of the three workstreams. Reference below.",
      question: "Which workstream absorbs the overage?",
      options: ["Paid media", "Creative"],
      reference: "work-item/abc",
      correlationCode: "ESC-7K2QF4",
      occurrences: 1,
    };

    for (const kind of [
      "needs_context",
      "major_decision",
      "blocked",
      "proactive_insight",
    ] as const) {
      const terse = composeEscalationMessage({
        escalation: { ...base, kind },
        profile: blunt,
      });
      const rich = composeEscalationMessage({
        escalation: { ...base, kind },
        profile: warm,
      });
      // Every kind, in every voice, keeps the handle the reply is matched on.
      expect(terse).toContain("[#ESC-7K2QF4]");
      expect(rich).toContain("[#ESC-7K2QF4]");
      // The blunt/terse employee drops the greeting, sign-off and reference.
      expect(terse).not.toContain("Morning!");
      expect(terse).not.toContain("Reference:");
      expect(rich).toContain("Morning!");
      expect(rich).toContain("— Mercury");
      expect(rich).toContain("Reference: work-item/abc");
      // Distinct kinds read distinctly rather than sharing one template.
      expect(terse.split("\n\n")[0]).not.toEqual(
        composeEscalationMessage({
          escalation: { ...base, kind: kind === "blocked" ? "needs_context" : "blocked" },
          profile: blunt,
        }).split("\n\n")[0],
      );
    }
  });

  it("applies the per-channel override rather than the profile default", () => {
    const profile = profileWith({
      tone: "formal",
      verbosity: "detailed",
      signOff: "Kind regards,",
      channelOverrides: [
        { channelId: "slack", tone: "casual", verbosity: "terse", emojiUse: "none" },
      ],
    });
    const escalation = {
      kind: "blocked" as const,
      urgency: "high" as const,
      title: "Deploy is stuck",
      summary: "The release pipeline has been red for 40 minutes.",
      question: null,
      options: [],
      reference: "run/551",
      correlationCode: "ESC-AAA111",
      occurrences: 1,
    };
    const onSlack = composeEscalationMessage({ escalation, profile, channelId: "slack" });
    const elsewhere = composeEscalationMessage({ escalation, profile, channelId: "telegram" });
    expect(onSlack).toContain("Hit a wall here");
    expect(onSlack).not.toContain("Kind regards,");
    expect(elsewhere).toContain("Work is blocked and requires your intervention.");
    expect(elsewhere).toContain("Kind regards,");
  });

  it("surfaces a repeat rather than hiding it behind a collapsed row", () => {
    const text = composeEscalationMessage({
      escalation: {
        kind: "blocked",
        urgency: "high",
        title: "Auth failing",
        summary: "",
        question: null,
        options: [],
        reference: null,
        correlationCode: "ESC-BBB222",
        occurrences: 4,
      },
      profile: profileWith({}),
    });
    expect(text).toContain("4th time");
  });

  // ── 2. Schedule-aware timing ──────────────────────────────────────────────

  it("holds a non-urgent escalation for the human-paced delay", () => {
    const result = service.raise(AGENCY, {
      workerId: "mercury",
      kind: "needs_context",
      title: "Need the client's brand guidelines",
      urgency: "normal",
    });
    expect(result.decision).toBe("scheduled");
    // The default latency policy aims for 300s; never instant.
    expect(result.escalation.deliverAfter).toBeGreaterThan(clock);
    expect(store.listDeliverable(AGENCY, clock)).toHaveLength(0);
  });

  it("lets a genuine blocker bypass quiet hours", async () => {
    clock = Date.UTC(2026, 6, 24, 3, 0, 0); // 03:00 UTC — inside quiet hours
    service = build();
    const quiet = service.raise(AGENCY, {
      workerId: "mercury",
      kind: "proactive_insight",
      title: "Landing page bounce rate is climbing",
    });
    // A 3am idea waits.
    expect(quiet.escalation.deliverAfter).toBeGreaterThan(clock);

    const urgent = raise({ dedupeKey: "urgent-1" });
    expect(urgent.escalation.deliverAfter).toBe(clock);
    expect(urgent.reason).toContain("bypassed");
    const pass = await service.processQueue(AGENCY);
    expect(pass.delivered).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("computes quiet hours and digest windows across midnight", () => {
    const policy = defaultEscalationPolicy();
    expect(isWithinQuietHours(policy, Date.UTC(2026, 6, 24, 23, 0))).toBe(true);
    expect(isWithinQuietHours(policy, Date.UTC(2026, 6, 24, 3, 0))).toBe(true);
    expect(isWithinQuietHours(policy, Date.UTC(2026, 6, 24, 12, 0))).toBe(false);
    expect(quietHoursEndAt(policy, Date.UTC(2026, 6, 24, 23, 0))).toBe(Date.UTC(2026, 6, 25, 7, 0));
    expect(nextDigestAt("daily", "17:00", "UTC", Date.UTC(2026, 6, 24, 10, 0))).toBe(
      Date.UTC(2026, 6, 24, 17, 0),
    );
    expect(nextDigestAt("daily", "09:00", "UTC", Date.UTC(2026, 6, 24, 10, 0))).toBe(
      Date.UTC(2026, 6, 25, 9, 0),
    );
  });

  // ── 3. Dedupe and rate limiting under a failure loop ──────────────────────

  it("collapses an employee stuck in a failure loop into one escalation", async () => {
    for (let pass = 0; pass < 200; pass += 1) {
      raise();
    }
    const rows = store.list(AGENCY, { limit: 500 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBe(200);
    await service.processQueue(AGENCY);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("caps how many messages one employee can put on a channel per hour", async () => {
    store.setPolicy(AGENCY, null, {
      rateLimit: { maxPerWorkerPerHour: 2, maxPerAgencyPerHour: 50, minSecondsBetween: 0 },
    });
    for (let index = 0; index < 4; index += 1) {
      raise({ title: `Distinct blocker ${index}`, dedupeKey: `k-${index}` });
      await service.processQueue(AGENCY);
    }
    const delivered = store.list(AGENCY, { status: "delivered", limit: 50 });
    const suppressed = store.list(AGENCY, { status: "suppressed", limit: 50 });
    expect(delivered).toHaveLength(2);
    expect(suppressed).toHaveLength(2);
    // Suppression is not deletion: the operator can still read what was held.
    expect(suppressed[0]!.reason).toContain("rate limit");
    expect(suppressed[0]!.composedMessage).toBeTruthy();
  });

  it("respects a reactive employee's refusal to volunteer observations", () => {
    workforce.setCommunicationProfile(AGENCY, "mercury", { proactivity: "reactive" });
    const result = service.raise(AGENCY, {
      workerId: "mercury",
      kind: "proactive_insight",
      title: "Competitor changed their pricing page",
    });
    expect(result.decision).toBe("suppressed_proactivity");
    expect(result.escalation.status).toBe("suppressed");
  });

  // ── 4 & 5. Idempotency and delivery failure ───────────────────────────────

  it("never re-sends an escalation, however many loop passes run", async () => {
    raise();
    for (let pass = 0; pass < 5; pass += 1) {
      await service.processQueue(AGENCY);
    }
    expect(transport).toHaveBeenCalledTimes(1);
    expect(
      store.listDeliveries(AGENCY, store.list(AGENCY)[0]!.id).filter((d) => d.ok),
    ).toHaveLength(1);
  });

  it("keeps the escalation readable when every channel is down", async () => {
    const failing = vi.fn(async () => {
      throw new Error("slack: connection refused");
    });
    service = build({ transport: failing as unknown as EscalationTransport });
    const raised = raise();
    const pass = await service.processQueue(AGENCY);
    expect(pass.failed).toBe(1);
    const after = store.get(AGENCY, raised.escalation.id)!;
    expect(after.status).toBe("failed");
    expect(after.lastError).toContain("connection refused");
    // Persist-first: the composed body is on the record regardless.
    expect(after.composedMessage).toContain(after.correlationCode);
    expect(store.listDeliveries(AGENCY, after.id)).toHaveLength(1);
    // And it is still visible on the board.
    expect(store.list(AGENCY, { openOnly: true }).map((row) => row.id)).toContain(after.id);
  });

  it("gives up after maxDeliveryAttempts instead of hammering a dead channel", async () => {
    store.setPolicy(AGENCY, null, { maxDeliveryAttempts: 2 });
    const failing = vi.fn(async () => {
      throw new Error("down");
    });
    service = build({ transport: failing as unknown as EscalationTransport });
    const raised = raise();
    for (let pass = 0; pass < 6; pass += 1) {
      clock += 3_600_000;
      await service.processQueue(AGENCY, { now: clock });
    }
    expect(failing).toHaveBeenCalledTimes(2);
    expect(store.get(AGENCY, raised.escalation.id)!.attempts).toBe(2);
  });

  // ── 6. Reply correlation ──────────────────────────────────────────────────

  it("routes a tagged reply to the right escalation, work item and job memory", async () => {
    const item = operating.enqueueWorkItem(AGENCY, {
      workerId: "mercury",
      title: "Ship the billing fix",
    });
    operating.transitionWorkItem(AGENCY, item.id, "accepted");
    operating.transitionWorkItem(AGENCY, item.id, "in_progress");
    // A second, unrelated escalation so "the right one" means something.
    raise({ title: "Unrelated", dedupeKey: "other" });
    const raised = raise({
      kind: "needs_context",
      title: "Which Stripe account is live?",
      question: "Which account should I point the webhook at?",
      workItemId: item.id,
      dedupeKey: "stripe-account",
    });
    await service.processQueue(AGENCY);
    expect(operating.getWorkItem(AGENCY, item.id)!.status).toBe("waiting");

    const code = raised.escalation.correlationCode;
    const result = service.ingestReply({
      agencyId: AGENCY,
      channelId: "slack",
      target: "C-OWNER",
      text: `Use the production account, acct_live_main. [#${code}]`,
      actorId: "owner-1",
    });
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("unreachable");
    expect(result.action).toBe("answered");
    if (result.action !== "answered") throw new Error("unreachable");
    expect(result.escalation.id).toBe(raised.escalation.id);
    expect(result.escalation.status).toBe("resolved");
    expect(result.resumed).toBe(true);
    expect(operating.getWorkItem(AGENCY, item.id)!.status).toBe("in_progress");

    const memory = operating.listJobMemory(AGENCY, "mercury", ESCALATION_MEMORY_NAMESPACE);
    expect(memory).toHaveLength(1);
    expect(memory[0]!.key).toBe(`answer:${code}`);
    expect((memory[0]!.value as { answer: string }).answer).toContain("production account");
    // The tag is addressing, not content.
    expect((memory[0]!.value as { answer: string }).answer).not.toContain(code);
  });

  it("falls back to the latest unanswered escalation on the same conversation", async () => {
    const raised = raise({ kind: "major_decision", title: "Renew or renegotiate?" });
    await service.processQueue(AGENCY);
    const result = service.ingestReply({
      agencyId: AGENCY,
      channelId: "slack",
      target: "C-OWNER",
      text: "Renegotiate.",
    });
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("unreachable");
    expect(result.via).toBe("channel");
    expect(store.get(AGENCY, raised.escalation.id)!.answer).toBe("Renegotiate.");
  });

  it("ignores an unrelated inbound message", () => {
    expect(service.ingestReply({ agencyId: AGENCY, text: "morning" }).matched).toBe(false);
  });

  it("parses the correlation tag the way a human actually types it", () => {
    expect(parseEscalationReference("ok [#esc-7k2qf4]")).toBe("ESC-7K2QF4");
    expect(parseEscalationReference("# ESC-AAA111 sure")).toBe("ESC-AAA111");
    expect(parseEscalationReference("nothing here")).toBeNull();
  });

  // ── 7. No secrets on a channel ────────────────────────────────────────────

  it("never puts a credential or a file dump on a channel", () => {
    const raised = raise({
      title: "Deploy failed",
      summary:
        "The worker exited 1. api_key: sk-live-ABCDEFGHIJKLMNOPQRSTUV and token=xoxb-1234567890-abcdef.\n" +
        "```\nconst SECRET='hunter2';\nmore file contents\n```\n" +
        "Also https://user:pa55word@internal.example.com/deploy",
      dedupeKey: "secret-test",
    });
    const body = `${raised.escalation.summary}\n${raised.escalation.composedMessage}`;
    expect(body).not.toContain("sk-live-ABCDEFGHIJKLMNOPQRSTUV");
    expect(body).not.toContain("xoxb-1234567890-abcdef");
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("more file contents");
    expect(body).not.toContain("pa55word");
    expect(body).toContain("[redacted");
  });

  it("rejects a context bag that looks like it carries credentials", () => {
    expect(() =>
      normalizeEscalationInput({
        workerId: "mercury",
        kind: "blocked",
        title: "x",
        context: { slackToken: "xoxb-abc" },
      }),
    ).toThrow(/credential/i);
  });

  it("redacts PEM blocks and JWTs", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(pem)).toBe("[redacted key]");
    expect(redactSecrets("bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk")).toContain(
      "[redacted]",
    );
  });

  // ── 8. Draft → approve → deliver ──────────────────────────────────────────

  it("never sends a client message before a human approves it", async () => {
    workforce.upsertChannelBinding(AGENCY, {
      workerId: "mercury",
      channelId: "whatsapp",
      target: "client-jid",
      direction: "outbound",
    });
    const raised = service.raise(AGENCY, {
      workerId: "mercury",
      kind: "major_decision",
      title: "Weekly status for Acme",
      recipientKind: "client",
      recipientLabel: "Acme Corp",
      channelId: "whatsapp",
      target: "client-jid",
      draftMessage: "Hi Acme — the redesign lands Thursday. Anything else you need before then?",
    });
    expect(raised.decision).toBe("awaiting_approval");
    expect(raised.escalation.status).toBe("awaiting_approval");
    // Recipient and approver are different routes.
    expect(raised.escalation.target).toBe("client-jid");
    expect(raised.escalation.approvalTarget).toBe("C-OWNER");

    const pass = await service.processQueue(AGENCY);
    expect(pass.approvalsRequested).toBe(1);
    expect(pass.delivered).toBe(0);
    // The one message that went out went to the APPROVER, quoting the draft.
    expect(transport).toHaveBeenCalledTimes(1);
    const request = transport.mock.calls[0]![0] as { to: string; text: string };
    expect(request.to).toBe("C-OWNER");
    expect(request.text).toContain("the redesign lands Thursday");
    expect(request.text).toContain("Acme Corp");

    // Asking twice is impossible however many passes run.
    await service.processQueue(AGENCY);
    expect(transport).toHaveBeenCalledTimes(1);

    service.approve(AGENCY, raised.escalation.id, { actorId: "owner-1" });
    await service.processQueue(AGENCY);
    expect(transport).toHaveBeenCalledTimes(2);
    const delivery = transport.mock.calls[1]![0] as { to: string; text: string };
    expect(delivery.to).toBe("client-jid");
    expect(delivery.text).toBe(
      "Hi Acme — the redesign lands Thursday. Anything else you need before then?",
    );
  });

  it("lets the approver reword rather than bounce", async () => {
    const raised = service.raise(AGENCY, {
      workerId: "mercury",
      kind: "needs_context",
      title: "Reply to Acme",
      recipientKind: "client",
      target: "client-jid",
      channelId: "whatsapp",
      draftMessage: "Hey!! we're SO close, promise!!",
    });
    service.approve(AGENCY, raised.escalation.id, {
      actorId: "owner-1",
      editedMessage: "Hi — we're on track for Thursday. I'll confirm once it's live.",
    });
    await service.processQueue(AGENCY);
    const sent = transport.mock.calls.at(-1)![0] as { text: string };
    expect(sent.text).toBe("Hi — we're on track for Thursday. I'll confirm once it's live.");
    // The employee's own words survive for the audit trail.
    expect(store.get(AGENCY, raised.escalation.id)!.draftMessage).toContain("SO close");
  });

  it("rejects a draft outright and teaches the employee why", async () => {
    const raised = service.raise(AGENCY, {
      workerId: "mercury",
      kind: "needs_context",
      title: "Reply to Acme",
      recipientKind: "client",
      target: "client-jid",
      channelId: "whatsapp",
      draftMessage: "We'll discount 40% if you stay.",
    });
    service.reject(AGENCY, raised.escalation.id, {
      actorId: "owner-1",
      reason: "never offer a discount without asking me",
    });
    const after = store.get(AGENCY, raised.escalation.id)!;
    expect(after.status).toBe("rejected");
    expect(after.approvalState).toBe("rejected");
    await service.processQueue(AGENCY);
    // Nothing reached the client. The only send was the approval request.
    expect(
      transport.mock.calls.filter((call) => (call[0] as { to: string }).to === "client-jid"),
    ).toHaveLength(0);
    const memory = operating.listJobMemory(AGENCY, "mercury", ESCALATION_MEMORY_NAMESPACE);
    expect(memory[0]!.key).toBe(`rejected:${after.correlationCode}`);
  });

  it("reads approve / reject / edit typed on a phone", async () => {
    const raised = service.raise(AGENCY, {
      workerId: "mercury",
      kind: "needs_context",
      title: "Reply to Acme",
      recipientKind: "client",
      target: "client-jid",
      channelId: "whatsapp",
      draftMessage: "Draft body",
    });
    const code = raised.escalation.correlationCode;
    expect(parseApprovalDirective(`approve [#${code}]`)?.verb).toBe("approve");
    expect(parseApprovalDirective(`reject #${code} too pushy`)).toEqual({
      verb: "reject",
      code,
      body: "too pushy",
    });
    expect(parseApprovalDirective("just a normal sentence")).toBeNull();

    const result = service.ingestReply({
      agencyId: AGENCY,
      text: `edit [#${code}] Softer wording please.`,
      actorId: "owner-1",
    });
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("unreachable");
    expect(result.action).toBe("edited");
    await service.processQueue(AGENCY);
    expect((transport.mock.calls.at(-1)![0] as { text: string }).text).toBe(
      "Softer wording please.",
    );
  });

  it("does not treat a plain reply as approval", () => {
    const raised = service.raise(AGENCY, {
      workerId: "mercury",
      kind: "needs_context",
      title: "Reply to Acme",
      recipientKind: "client",
      target: "client-jid",
      channelId: "whatsapp",
      draftMessage: "Draft body",
    });
    const result = service.ingestReply({
      agencyId: AGENCY,
      text: `sounds fine to me [#${raised.escalation.correlationCode}]`,
    });
    expect(result.matched).toBe(false);
    expect(store.get(AGENCY, raised.escalation.id)!.approvalState).toBe("pending");
  });

  // ── 9. Proactive digest ───────────────────────────────────────────────────

  it("batches proactive insights into a single digest", async () => {
    for (const title of ["Bounce rate up 12%", "Two invoices overdue", "Ad spend under pacing"]) {
      service.raise(AGENCY, { workerId: "mercury", kind: "proactive_insight", title });
    }
    expect(store.list(AGENCY, { status: "batched" })).toHaveLength(3);
    // Nothing goes out before the window closes.
    await service.processQueue(AGENCY);
    expect(transport).not.toHaveBeenCalled();

    clock = Date.UTC(2026, 6, 24, 17, 30); // past the 17:00 default digest time
    service = build();
    const digest = await service.flushDigests(AGENCY, { now: clock });
    expect(digest.digestsSent).toBe(1);
    expect(digest.itemsDelivered).toBe(3);
    expect(transport).toHaveBeenCalledTimes(1);
    const body = (transport.mock.calls[0]![0] as { text: string }).text;
    expect(body).toContain("Bounce rate up 12%");
    expect(body).toContain("Two invoices overdue");
    expect(body).toContain("3 things");
    // Each item keeps its own tag so any one can still be replied to.
    for (const row of store.list(AGENCY, { kind: "proactive_insight" })) {
      expect(body).toContain(row.correlationCode);
      expect(row.status).toBe("delivered");
      expect(row.digestId).toBeTruthy();
    }
  });

  it("holds a digest that is too thin to be worth an interruption", async () => {
    store.setPolicy(AGENCY, null, { digest: { minItems: 3 } });
    service.raise(AGENCY, { workerId: "mercury", kind: "proactive_insight", title: "One thought" });
    clock = Date.UTC(2026, 6, 24, 17, 30);
    const digest = await service.flushDigests(AGENCY, { now: clock });
    expect(digest.digestsSent).toBe(0);
    expect(digest.deferred).toBe(1);
    expect(transport).not.toHaveBeenCalled();
  });

  // ── Policy plumbing ───────────────────────────────────────────────────────

  it("merges a worker override over the agency policy without writing on read", () => {
    store.setPolicy(AGENCY, null, { rateLimit: { maxPerWorkerPerHour: 6 } });
    store.setPolicy(AGENCY, "mercury", { quietHours: { enabled: false } });
    const effective = store.getPolicy(AGENCY, "mercury");
    expect(effective.rateLimit.maxPerWorkerPerHour).toBe(6);
    expect(effective.quietHours.enabled).toBe(false);
    expect(store.getPolicy(AGENCY).quietHours.enabled).toBe(true);
    // Re-applying the same patch is a genuine no-op.
    expect(store.setPolicy(AGENCY, "mercury", { quietHours: { enabled: false } }).changed).toBe(
      false,
    );
  });

  it("keeps client approval on by default and clamps nonsense policy input", () => {
    const policy = normalizeEscalationPolicy({
      rateLimit: { maxPerWorkerPerHour: -5 },
      quietHours: { start: "not a time" },
      channelByKind: { blocked: "not-a-channel" },
      mutedKinds: ["blocked", "nonsense"],
    });
    expect(policy.approval.requireForRecipients).toEqual(["client"]);
    expect(policy.rateLimit.maxPerWorkerPerHour).toBe(0);
    expect(policy.quietHours.start).toBe("22:00");
    expect(policy.channelByKind.blocked).toBeNull();
    expect(policy.mutedKinds).toEqual(["blocked"]);
  });

  it("derives a dedupe key that survives ids and counters in the title", () => {
    const a = defaultDedupeKey({ kind: "blocked", workItemId: "w1", title: "Retry 3 failed" });
    const b = defaultDedupeKey({ kind: "blocked", workItemId: "w1", title: "Retry 47 failed" });
    expect(a).toBe(b);
  });

  it("cannot cancel something the human has already read", async () => {
    const raised = raise();
    await service.processQueue(AGENCY);
    expect(() => service.cancel(AGENCY, raised.escalation.id)).toThrow(/already delivered/);
  });
});
