/**
 * Discovery Docs — Netlify submissions poller.
 *
 * Runs in the gateway process: every N seconds (default 30), iterates
 * every template that has a Netlify binding, asks Netlify for any new
 * submissions, and pipes each one through the runner.
 *
 * Highwater-mark per template prevents re-processing. After a successful
 * run we optionally delete the submission from Netlify (configurable
 * per-template). On failure we keep the submission on Netlify for a
 * grace window so a transient AI/email outage doesn't lose the lead.
 */

import { STATE_DIR } from "../config/paths.js";
import { getDiscoveryStore } from "./store.js";
import { getNetlifyToken } from "./secrets.js";
import { NetlifyClient } from "./netlify.js";
import { runPipeline } from "./runner.js";
import type { DiscoveryDocTemplate } from "./types.js";

type BusinessLookup = (
  businessId: string,
) => { id: string; name: string; industry?: string; [k: string]: unknown } | null;

interface PollerOpts {
  /** Returns the active business profile by id — passed in by the gateway. */
  lookupBusiness: BusinessLookup;
  /** Stop signal so the gateway can tear down on shutdown. */
  signal?: AbortSignal;
}

let activeTimer: NodeJS.Timeout | null = null;
let pollerOpts: PollerOpts | null = null;

export function startNetlifyPoller(opts: PollerOpts): void {
  if (activeTimer) return;
  pollerOpts = opts;
  const tick = async () => {
    if (opts.signal?.aborted) return;
    try {
      await pollOnce();
    } catch (err) {
      console.warn("[discovery-poller] tick failed:", err);
    }
    if (!opts.signal?.aborted) {
      const store = getDiscoveryStore(STATE_DIR);
      const interval = store.getSettings().netlifyPollIntervalMs;
      activeTimer = setTimeout(tick, interval);
    }
  };
  // First run after a 5s warmup so we don't race with gateway boot.
  activeTimer = setTimeout(tick, 5_000);
  opts.signal?.addEventListener("abort", () => {
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = null;
  });
}

export function stopNetlifyPoller(): void {
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
}

export async function pollOnce(): Promise<{ processed: number; templates: number }> {
  const store = getDiscoveryStore(STATE_DIR);
  const token = getNetlifyToken(STATE_DIR);
  if (!token) return { processed: 0, templates: 0 };
  const settings = store.getSettings();
  const client = new NetlifyClient({ token });

  // Group templates by site so we batch the API calls per Netlify site.
  const templates = listAllTemplatesWithBinding();
  if (templates.length === 0) return { processed: 0, templates: 0 };

  const bySite = new Map<string, typeof templates>();
  for (const tpl of templates) {
    const id = tpl.netlify!.siteId;
    if (!bySite.has(id)) bySite.set(id, []);
    bySite.get(id)!.push(tpl);
  }

  let processed = 0;
  for (const [siteId, tpls] of bySite) {
    let submissions = [];
    try {
      submissions = await client.listSubmissions(siteId, { perPage: 100 });
    } catch (err) {
      console.warn(`[discovery-poller] listSubmissions(${siteId}) failed:`, err);
      continue;
    }

    for (const tpl of tpls) {
      // Filter to this template's form (form_name matches the slug-bound name).
      const formName = tpl.netlify!.formName;
      const newest = submissions
        .filter((s) => s.form_name === formName)
        .filter((s) => isNewerThanHighwater(s, tpl.netlify!.lastSeenSubmissionId))
        // Oldest first so the highwater mark advances cleanly.
        .reverse();
      if (newest.length === 0) continue;

      // Daily-rate abuse brake.
      const todayCount = store.countRunsLast24h(tpl.id);
      const remaining = Math.max(0, settings.perTemplateDailyLimit - todayCount);
      if (remaining === 0) {
        console.warn(`[discovery-poller] daily limit hit for template ${tpl.slug}`);
        continue;
      }
      const batch = newest.slice(0, remaining);

      for (const sub of batch) {
        // Dedupe: if we already have a run for this submission id, skip
        // (handles a poll race after a partial failure).
        if (store.getRunByNetlifySubmissionId(sub.id)) {
          store.setLastSeenSubmissionId(tpl.id, sub.id);
          continue;
        }
        const biz = pollerOpts?.lookupBusiness(tpl.businessId);
        if (!biz) {
          console.warn(`[discovery-poller] missing business ${tpl.businessId} for tpl ${tpl.id}`);
          continue;
        }
        try {
          const run = await runPipeline({
            template: tpl,
            inputs: sub.data,
            source: "netlify",
            business: biz,
            netlifySubmissionId: sub.id,
          });
          processed++;
          store.setLastSeenSubmissionId(tpl.id, sub.id);

          // Delete from Netlify on success if configured.
          const anyFailed = run.actions.some((a) => a.status === "failed");
          if (settings.deleteFromNetlifyAfterProcess && !anyFailed) {
            try {
              await client.deleteSubmission(sub.id);
            } catch (err) {
              console.warn(`[discovery-poller] deleteSubmission(${sub.id}) failed:`, err);
            }
          }
        } catch (err) {
          console.warn(`[discovery-poller] pipeline failed for sub ${sub.id}:`, err);
          // Don't advance the highwater on failure — next tick will retry.
          break;
        }
      }
    }
  }
  return { processed, templates: templates.length };
}

function isNewerThanHighwater(
  s: { id: string; created_at: string },
  highwaterId: string | null,
): boolean {
  if (!highwaterId) return true;
  // We can't trust submission order from Netlify across pages, but
  // within a single per_page=100 response they come newest-first. The
  // dedupe via getRunByNetlifySubmissionId is the real safety net.
  return s.id !== highwaterId;
}

function listAllTemplatesWithBinding(): DiscoveryDocTemplate[] {
  // The store doesn't expose a "list all" today; do it via a peek into
  // the sqlite handle. Acceptable internal coupling — store + poller
  // ship together.
  const store = getDiscoveryStore(STATE_DIR);
  const rows = (store as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }).db
    .prepare(`SELECT id FROM discovery_templates WHERE enabled = 1`)
    .all() as Array<{ id: string }>;
  const out: DiscoveryDocTemplate[] = [];
  for (const r of rows) {
    const tpl = store.getTemplate(r.id);
    if (tpl && tpl.netlify) out.push(tpl);
  }
  return out;
}
