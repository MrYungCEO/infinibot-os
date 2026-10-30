/**
 * Business hub RPC — lead generation (`hub.leadgen.*`): provider list and
 * config (keys masked), search jobs + paged results, import into the CRM,
 * single-record enrichment and standalone email verification.
 */

import { getLeadJob, listLeadJobs, listLeadResults, startLeadSearch } from "../leadgen/jobs.js";
import { enrichHubRecord, importLeadResults } from "../leadgen/import.js";
import { verifyEmail } from "../leadgen/verify.js";
import { listProviderStatus, saveLeadgenConfig, type ConfigPatch } from "../leadgen/config.js";
import type { LeadgenDeps } from "../leadgen/types.js";
import { defineHubHandlers, HubError, optBool, optNum, optStr, reqStr, strArr } from "./helpers.js";

export const LEADGEN_METHOD_SCOPES: Record<string, "read" | "write" | "admin"> = {
  "hub.leadgen.providers": "read",
  "hub.leadgen.config.set": "admin",
  "hub.leadgen.search": "write",
  "hub.leadgen.job": "read",
  "hub.leadgen.jobs": "read",
  "hub.leadgen.import": "write",
  "hub.leadgen.enrich": "write",
  "hub.leadgen.verifyEmail": "read",
};

/**
 * Optional deal hook the orchestrator registers (lead-gen never creates deals
 * itself). Called once per imported result when `createDeals` is true.
 */
export type LeadgenDealHook = (args: {
  contactId: string | null;
  companyId: string | null;
  jobId: string;
  pipelineStage?: string;
}) => void;

let dealHook: LeadgenDealHook | null = null;
export function setLeadgenDealHook(fn: LeadgenDealHook | null): void {
  dealHook = fn;
}

/** Network deps for handlers (tests may override). */
let rpcDeps: LeadgenDeps = {};
export function setLeadgenRpcDeps(deps: LeadgenDeps): void {
  rpcDeps = deps;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const leadgenHubHandlers = defineHubHandlers({
  "hub.leadgen.providers": (_p, { db }) => listProviderStatus(db, rpcDeps),

  "hub.leadgen.config.set": (p, { db }) => {
    const patch: ConfigPatch = {};
    const providers = asRecord(p.providers);
    if (Object.keys(providers).length) {
      patch.providers = {};
      for (const [id, raw] of Object.entries(providers)) {
        const r = asRecord(raw);
        const s = (k: string) =>
          typeof r[k] === "string" || r[k] === null ? (r[k] as string | null) : undefined;
        patch.providers[id] = {
          enabled: typeof r.enabled === "boolean" ? r.enabled : undefined,
          serviceUrl: s("serviceUrl"),
          apiKey: s("apiKey"),
          endpoint: s("endpoint"),
          geocoderUrl: s("geocoderUrl"),
        };
      }
    }
    const country = optStr(p, "defaultCountry");
    if (country) patch.defaultCountry = country;
    const quota = optNum(p, "dailyOverpassQuota");
    if (quota !== undefined) patch.dailyOverpassQuota = quota;
    saveLeadgenConfig(db, patch, rpcDeps);
    return listProviderStatus(db, rpcDeps);
  },

  "hub.leadgen.search": (p, { db, broadcast }) => {
    const { jobId } = startLeadSearch(
      db,
      {
        query: reqStr(p, "query"),
        location: optStr(p, "location") ?? null,
        providers: strArr(p, "providers"),
        limit: optNum(p, "limit"),
        enrich: optBool(p, "enrich"),
        verify: optBool(p, "verify"),
        businessId: optStr(p, "businessId") ?? null,
        country: optStr(p, "country"),
      },
      {
        ...rpcDeps,
        onProgress: (id, progress) => broadcast("hub.leadgen.progress", { jobId: id, progress }),
      },
    );
    return { jobId };
  },

  "hub.leadgen.job": (p, { db }) => {
    const jobId = reqStr(p, "jobId");
    const job = getLeadJob(db, jobId);
    if (!job) throw new HubError(`lead job not found: ${jobId}`, "NOT_FOUND");
    const status = optStr(p, "status");
    const page = listLeadResults(db, jobId, {
      minScore: optNum(p, "minScore"),
      hasEmail: optBool(p, "hasEmail"),
      status:
        status === "new" || status === "imported" || status === "skipped" ? status : undefined,
      limit: optNum(p, "limit"),
      offset: optNum(p, "offset"),
    });
    return { job, ...page };
  },

  "hub.leadgen.jobs": (p, { db }) => ({
    jobs: listLeadJobs(db, {
      limit: optNum(p, "limit"),
      businessId: optStr(p, "businessId") ?? null,
    }),
  }),

  "hub.leadgen.import": (p, { db, broadcast }) => {
    const jobId = reqStr(p, "jobId");
    const ids = p.resultIds === "all" ? "all" : strArr(p, "resultIds");
    if (!ids || (Array.isArray(ids) && !ids.length))
      throw new HubError('resultIds required (array or "all")');
    const createDeals = optBool(p, "createDeals") === true;
    const pipelineStage = optStr(p, "pipelineStage");
    const hook = createDeals ? dealHook : null;
    const res = importLeadResults(db, jobId, ids, {
      tags: strArr(p, "tags"),
      createDeals,
      pipelineStage,
      onImported: hook
        ? (contactId, companyId) => hook({ contactId, companyId, jobId, pipelineStage })
        : undefined,
    });
    broadcast("hub.changed", { kind: "leadgen.import", jobId });
    return {
      created: res.created,
      updated: res.updated,
      skipped: res.skipped,
      dealsRequested: !!hook,
    };
  },

  "hub.leadgen.enrich": async (p, { db, broadcast }) => {
    const id = reqStr(p, "id");
    const type = optStr(p, "type") ?? (id.startsWith("co_") ? "company" : "contact");
    if (type !== "company" && type !== "contact")
      throw new HubError("type must be company or contact");
    const res = await enrichHubRecord(db, { type, id }, rpcDeps);
    broadcast("hub.changed", { kind: "leadgen.enrich", id });
    return res;
  },

  "hub.leadgen.verifyEmail": async (p, { db }) => verifyEmail(db, reqStr(p, "email"), rpcDeps),
});
