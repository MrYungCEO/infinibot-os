/**
 * Business hub — what the business-agency plugin mounts while it is on:
 *
 *   • public, self-authenticated HTTP routes (tracking snippet + collector,
 *     email open / click / unsubscribe, email + revenue webhooks);
 *   • one background service: the legacy-data migration (once per state
 *     dir), the email sender loop (with inbound reply/bounce polling), the
 *     incremental revenue sync and the hourly next-action → kanban sync;
 *   • the event wiring that turns sends, clicks, replies, form submits and
 *     payments into pipeline moves (automation.ts).
 *
 * `INFINIBOT_BUSINESS_HUB_SCHEDULERS=0` keeps the routes and RPCs but starts
 * no timers (side gateways, tests).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import {
  agencyClientLinker,
  emitPipelineEvent,
  ensureOpenDeal,
  getSettings,
} from "./automation.js";
import { getHubDb } from "./db.js";

const log = createSubsystemLogger("business-hub");

const BASE = "/plugins/business-agency";

/** Every public route the plugin registers (manifest contributes.http + selfAuthHttp). */
export const BUSINESS_HUB_HTTP_PATHS = [
  `${BASE}/t/s.js`,
  `${BASE}/t/c`,
  `${BASE}/t/o`,
  `${BASE}/t/k`,
  `${BASE}/u`,
  `${BASE}/webhooks/email`,
  `${BASE}/webhooks/revenue`,
  `${BASE}/book`,
  `${BASE}/book/ics`,
] as const;

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Pipeline wiring shared by the HTTP routes, the RPCs and the schedulers. */
export function businessHubHooks() {
  const db = () => getHubDb();
  const deps = () => ({ linkClient: agencyClientLinker(db()) });
  return {
    onSent: (contactId: string) => {
      safe(() => emitPipelineEvent(db(), contactId, "email.sent", deps()));
    },
    onClicked: (contactId: string) => {
      safe(() => emitPipelineEvent(db(), contactId, "email.clicked", deps()));
    },
    onReplied: (
      contactId: string,
      info: {
        sendId: string;
        emailCampaignId: string | null;
        inboundId?: string | null;
        subject?: string | null;
        body?: string | null;
        autoReply?: boolean;
        receivedAt?: number;
      },
    ) => {
      safe(() => {
        emitPipelineEvent(db(), contactId, "email.replied", deps());
        void import("./autopilot.js")
          .then(({ recordAutopilotReply }) =>
            recordAutopilotReply(db(), {
              contactId,
              body: info.body ?? info.subject ?? "Reply received",
              subject: info.subject,
              inboundId: info.inboundId,
              messageId: info.sendId,
              autoReply: info.autoReply,
              receivedAt: info.receivedAt,
            }),
          )
          .catch(() => undefined);
      });
    },
    onFormSubmitted: (contactId: string, info: { campaignId: string | null }) => {
      safe(() => {
        if (getSettings(db()).autoCreateDeals)
          ensureOpenDeal(db(), contactId, { campaignId: info.campaignId });
        emitPipelineEvent(db(), contactId, "form.submitted", deps(), {
          reason: "Landing page form",
        });
      });
    },
    onPayment: (contactId: string, txn: { grossCents?: number; productName?: string | null }) => {
      safe(() =>
        emitPipelineEvent(db(), contactId, "payment.succeeded", deps(), {
          reason: txn.productName ? `Paid: ${txn.productName}` : "Payment received",
          valueCents: txn.grossCents,
        }),
      );
    },
  };
}

function safe(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    log.warn(`pipeline automation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let wired = false;

/** Install the hooks into the email + revenue runtimes (idempotent). */
export async function wireBusinessHub(): Promise<void> {
  if (wired) return;
  wired = true;
  const hooks = businessHubHooks();
  const [{ configureEmailRuntime }, { configureRevenueRpc }] = await Promise.all([
    import("./email/config.js"),
    import("./rpc/revenue.js"),
  ]);
  configureEmailRuntime({
    hooks,
    // InfiniBot Cloud: the tenant Machine's public origin (set by the
    // orchestrator) until the tenant saves its own public URL.
    baseUrl: () => process.env.FLEET_PUBLIC_URL?.trim() || null,
    log: (msg, data) => log.info(`${msg}${data ? ` ${JSON.stringify(data)}` : ""}`),
  });
  configureRevenueRpc({ onPayment: hooks.onPayment, log: (m: string) => log.info(m) });
}

async function readRaw(req: IncomingMessage, max = 1024 * 1024): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += b.length;
    if (size > max) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Handlers keyed by exact path (lazy: nothing heavy loads until a request arrives). */
export function createBusinessHubRoutes(): Record<string, Handler> {
  let emailTracking: Promise<Record<string, Handler>> | null = null;
  const loadEmailTracking = () => {
    emailTracking ??= (async () => {
      await wireBusinessHub();
      const { createBusinessHubHttpHandlers } = await import("./http.js");
      return createBusinessHubHttpHandlers({ hooks: businessHubHooks() }) as Record<
        string,
        Handler
      >;
    })();
    emailTracking.catch(() => (emailTracking = null));
    return emailTracking;
  };
  const out: Record<string, Handler> = {};
  for (const path of BUSINESS_HUB_HTTP_PATHS) {
    if (path.endsWith("/webhooks/revenue") || path.endsWith("/book") || path.endsWith("/book/ics"))
      continue;
    out[path] = async (req, res) => {
      const map = await loadEmailTracking();
      const h = map[path];
      if (!h) {
        res.writeHead(404).end();
        return;
      }
      await h(req, res);
    };
  }
  out[`${BASE}/webhooks/revenue`] = async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://gateway.local");
    const provider = url.searchParams.get("provider");
    const accountId = url.searchParams.get("account") ?? "";
    if ((provider !== "whop" && provider !== "stripe") || !accountId) {
      res
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: false, error: "provider and account required" }));
      return;
    }
    const raw = await readRaw(req);
    if (raw === null) {
      res.writeHead(413).end();
      return;
    }
    await wireBusinessHub();
    const { handleRevenueWebhook } = await import("./revenue/webhooks.js");
    const hooks = businessHubHooks();
    const r = await handleRevenueWebhook(
      getHubDb(),
      provider,
      accountId,
      raw,
      req.headers as Record<string, string | string[] | undefined>,
      {
        triggerSync: async (db, id) => {
          const { syncAccount } = await import("./revenue/sync.js");
          return syncAccount(db, id, { mode: "incremental", deps: { onPayment: hooks.onPayment } });
        },
      },
    );
    res
      .writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify(r.body));
  };
  let bookingRoutes: Promise<Record<string, Handler>> | null = null;
  const loadBookingRoutes = () => {
    bookingRoutes ??= import("./booking-http.js").then(({ createBookingHttpHandlers }) =>
      createBookingHttpHandlers({ getDb: () => getHubDb() }),
    );
    bookingRoutes.catch(() => (bookingRoutes = null));
    return bookingRoutes;
  };
  for (const path of [`${BASE}/book`, `${BASE}/book/ics`]) {
    out[path] = async (req, res) => {
      const handlers = await loadBookingRoutes();
      await handlers[path](req, res);
    };
  }
  return out;
}

// ── background service ────────────────────────────────────────────────────

let timers: Array<ReturnType<typeof setInterval>> = [];
let running = false;

export function businessHubSchedulersEnabled(env = process.env): boolean {
  return env.INFINIBOT_BUSINESS_HUB_SCHEDULERS !== "0";
}

export async function startBusinessHubService(): Promise<void> {
  if (running) return;
  running = true;
  await wireBusinessHub();
  const stateDir = resolveStateDirWithLegacyEnv();
  // One-time migration of legacy lead / pipeline / income data (idempotent).
  void (async () => {
    try {
      const { migrateLegacyBusinessData, defaultMigrationDeps } = await import("./migration.js");
      const { migrateLegacyIncome } = await import("./revenue/legacy.js");
      const deps = defaultMigrationDeps(stateDir);
      deps.migrateIncome = async (db, sd) => {
        const r: unknown = await migrateLegacyIncome(db, sd);
        return typeof r === "number"
          ? r
          : Number((r as { imported?: number } | null)?.imported ?? 0);
      };
      const report = await migrateLegacyBusinessData(getHubDb(stateDir), stateDir, deps);
      if (report)
        log.info(
          `legacy business data migrated: ${JSON.stringify({ ...report, backupDir: report.backupDir ? "yes" : "no" })}`,
        );
    } catch (err) {
      log.warn(`legacy migration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  if (!businessHubSchedulersEnabled()) {
    log.info("business hub schedulers disabled (INFINIBOT_BUSINESS_HUB_SCHEDULERS=0)");
    return;
  }
  const hooks = businessHubHooks();
  const [{ startEmailScheduler }, { scheduleRevenueSync }] = await Promise.all([
    import("./email/sender-loop.js"),
    import("./revenue/sync.js"),
  ]);
  startEmailScheduler({ hooks, log: (msg: string) => log.info(msg) });
  scheduleRevenueSync({
    getDb: () => getHubDb(),
    deps: { onPayment: hooks.onPayment, log: (m: string) => log.info(m) },
  });
  const reminders = setInterval(() => {
    void (async () => {
      try {
        const { syncReminders, kanbanReminderSink } = await import("./pipeline.js");
        // Resolved per tick: a cloud Machine pins its tenant namespace after
        // boot, so the boot-time dir can be the volume root.
        await syncReminders(
          getHubDb(),
          kanbanReminderSink(getHubDb(), resolveStateDirWithLegacyEnv()),
        );
      } catch (err) {
        log.warn(`follow-up sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, 60 * 60_000);
  reminders.unref?.();
  timers.push(reminders);
  const autopilot = setInterval(() => {
    void (async () => {
      // Resolved per tick (like the reminders): on a cloud Machine this is the
      // pinned tenant's own business-hub.db, so the scheduler is per tenant.
      const db = getHubDb();
      const { autopilotSchedulerTick, autopilotHasDueWork } = await import("./autopilot.js");
      if (!autopilotHasDueWork(db)) return;
      // A wake-mode cloud Machine must not idle-sleep mid-run; an empty tick
      // records nothing, so the scheduler alone never keeps it awake.
      const { fleetWorkBegin, fleetWorkEnd } = await import("../saas/fleet-idle.js");
      fleetWorkBegin("business-hub:autopilot", "autopilot");
      try {
        await autopilotSchedulerTick(db);
      } finally {
        fleetWorkEnd("business-hub:autopilot", "autopilot");
      }
    })().catch((err) =>
      log.warn(`autopilot tick failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, 60_000);
  autopilot.unref?.();
  timers.push(autopilot);
}

export async function stopBusinessHubService(): Promise<void> {
  running = false;
  for (const t of timers) clearInterval(t);
  timers = [];
  try {
    const [{ stopEmailScheduler }, { stopRevenueSync }] = await Promise.all([
      import("./email/sender-loop.js"),
      import("./revenue/sync.js"),
    ]);
    stopEmailScheduler();
    stopRevenueSync();
  } catch {
    /* modules never loaded */
  }
}
