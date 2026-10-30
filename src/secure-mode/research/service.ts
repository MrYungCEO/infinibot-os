/**
 * Secure research: web research for Secure Mode without leaking secure data.
 *
 *   goal + secure files ──local model──▶ proposed queries
 *        ──sanitizer (rules + local model review)──▶ generic queries
 *        ──approval (ask | auto-sanitized)──▶ local SearXNG
 *        ──hardened page fetch──▶ text (local readability)
 *        ──local model──▶ extracts ──local model──▶ summary + value ranges
 *        ──▶ encrypted vault record (query log, sources, egress log)
 *
 * The only things that leave the machine are the approved query strings (to
 * the local SearXNG, which forwards them to public search engines) and plain
 * GETs of the public result pages. Secure content (the goal, file text,
 * entities, extracts) only ever reaches the local model.
 */

import type { InfinibotConfig } from "../../config/config.js";
import { extractReadableContent } from "../../agents/tools/web-fetch-utils.js";
import { getOcrService } from "../../ocr/runtime.js";
import { getSecureModeRuntime } from "../runtime.js";
import { SecureModeBlockedError } from "../policy.js";
import { getResearchApprovals, type ResearchApprovals } from "./approvals.js";
import {
  checkEgressStatic,
  resolveResearchEndpoints,
  type ResearchEndpoints,
  SecureEgressError,
} from "./egress.js";
import { SecureFetcher, type EgressEvent } from "./fetcher.js";
import { type LocalLlm, parseJsonLoose, resolveResearchLlm } from "./local-llm.js";
import {
  applyModelFlags,
  findSensitive,
  normalizeSensitiveTerms,
  sanitizeBatch,
  type SanitizeContext,
  type SanitizedQuery,
} from "./sanitizer.js";
import {
  newResearchId,
  type ResearchApprovalMode,
  type ResearchRecord,
  type ResearchSource,
  ResearchStore,
  type ValueEstimate,
} from "./store.js";

export type SecureResearchConfig = {
  approval: ResearchApprovalMode;
  searxngUrl: string;
  proxy?: string;
  maxQueries: number;
  pagesPerQuery: number;
  maxPages: number;
  fetchTimeoutMs: number;
  maxPageBytes: number;
  approvalTimeoutSec: number;
  sensitiveTerms: string[];
  enabled: boolean;
};

export function resolveSecureResearchConfig(cfg?: InfinibotConfig): SecureResearchConfig {
  const r = cfg?.secureMode?.research ?? {};
  const clamp = (v: unknown, lo: number, hi: number, def: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : def;
  return {
    enabled: r.enabled !== false,
    approval: r.approval === "auto-sanitized" ? "auto-sanitized" : "ask",
    searxngUrl: resolveResearchEndpoints(cfg).searxngUrl,
    proxy: typeof r.proxy === "string" && r.proxy.trim() ? r.proxy.trim() : undefined,
    maxQueries: clamp(r.maxQueries, 1, 12, 6),
    pagesPerQuery: clamp(r.pagesPerQuery, 0, 5, 2),
    maxPages: clamp(r.maxPages, 0, 20, 8),
    fetchTimeoutMs: clamp(r.fetchTimeoutMs, 2_000, 60_000, 12_000),
    maxPageBytes: clamp(r.maxPageBytes, 50_000, 5_000_000, 1_500_000),
    approvalTimeoutSec: clamp(r.approvalTimeoutSec, 30, 1_800, 300),
    sensitiveTerms: Array.isArray(r.sensitiveTerms)
      ? r.sensitiveTerms.filter((t) => typeof t === "string")
      : [],
  };
}

export type SecureResearchInput = {
  goal: string;
  /** Short generic item descriptions the agent already knows. */
  items?: string[];
  /** Secure-lane file ids whose OCR/analysis informs the queries. */
  fileIds?: string[];
  /** Queries the agent proposes (still sanitized and approved). */
  queries?: string[];
  sessionKey?: string;
  projectId?: string;
};

export type SecureResearchProgress = { phase: string; done?: number; total?: number };

export type SecureResearchDeps = {
  llm?: LocalLlm;
  fetcher?: Pick<SecureFetcher, "get" | "proxyKind">;
  store?: ResearchStore;
  approvals?: ResearchApprovals;
  now?: () => number;
  /** Read secure file context (tests replace this). */
  fileContext?: (ids: string[]) => FileContext[];
  /** Secure-graph terms (tests replace this). */
  vaultTerms?: () => string[];
};

export type FileContext = { id: string; name: string; text: string; entities: string[] };

export type SecureResearchResult = {
  id: string;
  status: ResearchRecord["status"];
  approvalMode: ResearchApprovalMode;
  queriesSent: string[];
  summary?: string;
  estimates?: ValueEstimate[];
  sources: Array<{ n: number; url: string; title?: string; kind?: "page" | "snippet" }>;
  model?: string;
  egressHosts: string[];
  removedCount: number;
  note?: string;
  error?: string;
};

// ── context ────────────────────────────────────────────────────────────────

function defaultFileContext(ids: string[]): FileContext[] {
  const svc = getOcrService();
  const out: FileContext[] = [];
  for (const id of ids.slice(0, 12)) {
    const ctx = svc.getContext("secure", { id });
    if (!ctx) continue;
    const sc = ctx.sidecar;
    const analyses = (sc?.analyses ?? []).map((a) => a.summary).join("\n");
    const text = [sc?.description ?? "", analyses, sc?.markdown ?? ""].filter(Boolean).join("\n\n");
    out.push({
      id: ctx.entry.id,
      name: ctx.entry.name,
      text: text.slice(0, 6_000),
      entities: sc?.entities ?? [],
    });
  }
  return out;
}

const SENSITIVE_KINDS = new Set(["person", "client"]);

function defaultVaultTerms(): string[] {
  const vault = getSecureModeRuntime().requireVault();
  const g = vault.readJson<{
    nodes?: Array<{ label?: string; kind?: string; sensitive?: boolean }>;
  }>("graph", {});
  return (g.nodes ?? [])
    .filter((n) => n.sensitive === true || SENSITIVE_KINDS.has(String(n.kind)))
    .map((n) => String(n.label ?? ""))
    .filter(Boolean);
}

/** Entities from OCR that look like a person, place, id or account. Item names stay searchable. */
function identifyingEntities(entities: string[]): string[] {
  return entities
    .filter((e) => {
      const t = e.trim();
      if (!t) return false;
      // "Serial: A1070", "Owner: Hans Müller", "Address: …"
      if (
        /^(?:owner|holder|name|payee|bearer|address|serial|no\.?|nr\.?|number|account|iban|phone|email|signature|signed|registered(?: to)?|issued to|inhaber|eigentümer|besitzer)\b/i.test(
          t,
        )
      )
        return true;
      // Bare tokens with digits and letters (ids), or long digit runs.
      if (/\b(?=\w*\d)(?=\w*[A-Za-z])\w{4,}\b/.test(t) || /\d{5,}/.test(t)) return true;
      return false;
    })
    .map((e) => e.replace(/^[^:]{1,20}:\s*/, ""));
}

// ── prompts ────────────────────────────────────────────────────────────────

const PLAN_SYSTEM = `You plan PUBLIC web searches for a private research task. The owner's private data stays on this machine; only your search queries go to a public search engine.
Rules for every query:
- Describe the TYPE of item only: issuer, year, denomination, series, material, "value", "price", "auction", "catalog".
- NEVER include: personal names, signatures, addresses, cities tied to the owner, emails, phone numbers, serial/certificate/account numbers, file names, exact amounts the owner paid, dates other than the item's year.
- 3 to 8 words per query. One item per query. Prefer English.
Answer with JSON only: {"items":[{"name":"short generic item name"}],"queries":["..."]}`;

const REVIEW_SYSTEM = `You check search queries before they are sent to the public internet.
Flag any word or phrase that identifies a person, a place tied to a person, an account, a serial or certificate number, a file, or the owner's own copy of an item (as opposed to the generic item type).
Do NOT flag generic item descriptions such as issuer, year, denomination, currency, "bond", "banknote", "value", "price", "auction".
Answer with JSON only: {"flagged":["exact substring", ...]} (empty list when clean).`;

const EXTRACT_SYSTEM = `You read one web page (plain text) for a valuation task and extract ONLY prices or values it actually states.
Answer with JSON only: {"relevant":true|false,"facts":[{"item":"which item","price":number,"currency":"USD|EUR|GBP|…","kind":"sold|asking|estimate|catalog","condition":"grade/condition if stated","quote":"short verbatim snippet"}],"note":"one line"}
Never invent numbers. If the page has no price for these items, return {"relevant":false,"facts":[],"note":"…"}.`;

const SYNTH_SYSTEM = `You write a short valuation summary from extracted web facts. Use ONLY the facts given; cite sources by their [n] numbers.
Answer with JSON only:
{"summary":"3-6 sentences, plain language, cite [n]","estimates":[{"item":"…","low":number|null,"high":number|null,"currency":"USD","basis":"why this range (sold vs asking, condition)","confidence":"low|medium|high","sources":[n,…]}]}
Notes that start with "search result snippet:" are short search-engine excerpts (weaker than a read page); use prices they state, but prefer sold prices over asking prices and lower the confidence when only snippets support a range.
If there are no usable facts for an item, give low/high null and confidence "low".`;

// ── service ────────────────────────────────────────────────────────────────

export class SecureResearchService {
  constructor(
    private readonly cfg: InfinibotConfig | undefined,
    private readonly deps: SecureResearchDeps = {},
  ) {}

  private get rc(): SecureResearchConfig {
    return resolveSecureResearchConfig(this.cfg);
  }

  private store(): ResearchStore {
    return this.deps.store ?? new ResearchStore(getSecureModeRuntime().requireVault());
  }

  private approvals(): ResearchApprovals {
    return this.deps.approvals ?? getResearchApprovals();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Sensitive terms for this run: vault people/clients, identifying OCR entities, owner list. */
  sanitizeContext(files: FileContext[]): SanitizeContext {
    const vault = (this.deps.vaultTerms ?? defaultVaultTerms)();
    const fromFiles = files.flatMap((f) => [
      ...identifyingEntities(f.entities),
      // Whatever the rules would strip from an entity (names, ids, addresses) is a term too.
      ...f.entities.flatMap((e) => findSensitive(e).map((r) => r.text)),
      f.name,
      f.name.replace(/\.[a-z0-9]{2,5}$/i, ""),
    ]);
    return {
      sensitiveTerms: normalizeSensitiveTerms([...this.rc.sensitiveTerms, ...vault, ...fromFiles]),
    };
  }

  async run(
    input: SecureResearchInput,
    opts: { signal?: AbortSignal; onProgress?: (p: SecureResearchProgress) => void } = {},
  ): Promise<SecureResearchResult> {
    const rc = this.rc;
    if (!rc.enabled)
      throw new SecureModeBlockedError(
        "secure research is turned off (secureMode.research.enabled=false)",
      );
    const goal = String(input.goal ?? "")
      .trim()
      .slice(0, 2_000);
    if (!goal) throw new Error("goal is required");
    const store = this.store();
    const approvals = this.approvals();
    const endpoints: ResearchEndpoints = { searxngUrl: rc.searxngUrl };
    const egress: EgressEvent[] = [];
    const fetcher =
      this.deps.fetcher ??
      new SecureFetcher({
        endpoints,
        cfg: this.cfg,
        proxy: rc.proxy,
        timeoutMs: rc.fetchTimeoutMs,
        maxBytes: rc.maxPageBytes,
        onEgress: (e) => egress.push(e),
      });
    const progress = (p: SecureResearchProgress) => {
      opts.onProgress?.(p);
      approvals.emit(record.id, input.sessionKey, `running:${p.phase}`);
    };

    const files = input.fileIds?.length
      ? (this.deps.fileContext ?? defaultFileContext)(input.fileIds)
      : [];
    const ctx = this.sanitizeContext(files);
    const record: ResearchRecord = {
      id: newResearchId(),
      createdAt: this.now(),
      updatedAt: this.now(),
      status: "running",
      approvalMode: rc.approval,
      goal,
      attachments: {
        ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(files.length ? { fileIds: files.map((f) => f.id) } : {}),
      },
      queries: [],
      sources: [],
      egress,
      proxy: fetcher.proxyKind,
      searchEngine: `searxng ${rc.searxngUrl}`,
    };
    const save = () => {
      record.updatedAt = this.now();
      store.save(record);
    };

    try {
      const llm = this.deps.llm ?? (await resolveResearchLlm(this.cfg));
      record.model = llm.ref;

      // 1. plan (local model) ------------------------------------------------
      progress({ phase: "plan" });
      const items = (input.items ?? [])
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 12);
      let proposed = (input.queries ?? []).map((q) => String(q)).filter((q) => q.trim());
      if (!proposed.length) {
        const fileBlock = files
          .map((f, i) => `FILE ${i + 1} (${f.name}):\n${f.text.slice(0, 2_500)}`)
          .join("\n\n");
        const answer = await llm.complete(
          [
            { role: "system", content: PLAN_SYSTEM },
            {
              role: "user",
              content: `Research goal: ${goal}\n${items.length ? `Known items: ${items.join("; ")}\n` : ""}${
                fileBlock
                  ? `\nPrivate file analyses (for your understanding only, never copy identifying details):\n${fileBlock}\n`
                  : ""
              }\nPropose up to ${rc.maxQueries} queries.`,
            },
          ],
          { maxTokens: 600, signal: opts.signal },
        );
        const plan = parseJsonLoose<{ queries?: unknown; items?: Array<{ name?: unknown }> }>(
          answer,
        );
        proposed = Array.isArray(plan?.queries)
          ? plan.queries.filter((q): q is string => typeof q === "string")
          : [];
        if (!proposed.length && items.length) proposed = items.map((i) => `${i} value`);
        if (!proposed.length) proposed = [`${goal}`];
      }

      // 2. sanitize: rules, then a local-model review that can only remove ------
      progress({ phase: "sanitize" });
      const batch = sanitizeBatch(proposed, ctx, rc.maxQueries);
      let reviewed: SanitizedQuery[] = batch.accepted;
      let modelReviewed = false;
      if (reviewed.length) {
        try {
          const answer = await llm.complete(
            [
              { role: "system", content: REVIEW_SYSTEM },
              { role: "user", content: JSON.stringify(reviewed.map((s) => s.query)) },
            ],
            { maxTokens: 300, signal: opts.signal },
          );
          const parsed = parseJsonLoose<{ flagged?: unknown }>(answer);
          if (parsed && Array.isArray(parsed.flagged)) {
            const flagged = parsed.flagged.filter((f): f is string => typeof f === "string");
            reviewed = reviewed.map((s) => applyModelFlags(s, flagged, ctx));
            modelReviewed = true;
          }
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          // Review unavailable: rules still applied; auto mode falls back to ask.
        }
      }
      const finalQueries = dedupe(reviewed.filter((s) => s.ok));
      record.rejected = [...batch.rejected, ...reviewed.filter((s) => !s.ok)].map((s) => ({
        proposed: s.original,
        reason: s.reason ?? "removed",
      }));
      record.queries = finalQueries.map((s) => ({
        query: s.query,
        proposed: s.original,
        removed: s.removed,
      }));
      if (!record.queries.length) {
        record.status = "blocked";
        record.error =
          "No query was left after removing personal details. Describe the item type (issuer, year, denomination).";
        save();
        return this.result(record);
      }

      // 3. approval -------------------------------------------------------------
      const auto = rc.approval === "auto-sanitized" && modelReviewed;
      if (auto) {
        record.status = "approved";
        record.decidedAt = this.now();
        record.decidedBy = "auto-sanitized";
        save();
      } else {
        record.status = "pending_approval";
        save();
        const decision = await approvals.wait(
          {
            id: record.id,
            sessionKey: input.sessionKey,
            goal: goal.slice(0, 200),
            queries: record.queries.map((q) => q.query),
            createdAt: this.now(),
            expiresAt: this.now() + rc.approvalTimeoutSec * 1000,
            ctx,
            maxQueries: rc.maxQueries,
          },
          opts.signal,
        );
        record.decidedAt = this.now();
        if (decision.decision !== "approve") {
          record.status = decision.decision === "deny" ? "denied" : "expired";
          if (decision.decision === "deny") record.decidedBy = decision.by ?? "owner";
          record.error =
            decision.decision === "deny"
              ? "The owner denied these queries. Nothing was sent."
              : decision.decision === "aborted"
                ? "The run was stopped before approval. Nothing was sent."
                : "Nobody approved the queries in time. Nothing was sent.";
          save();
          approvals.emit(record.id, input.sessionKey, record.status);
          return this.result(record);
        }
        record.status = "approved";
        record.decidedBy = decision.by ?? "owner";
        record.edited = decision.edited;
        if (decision.edited) {
          record.queries = decision.queries.map((q) => {
            const before = record.queries.find((x) => x.query === q);
            return before ?? { query: q, proposed: "(edited by owner)" };
          });
        }
        save();
      }

      // 4. search (local SearXNG) ---------------------------------------------------
      record.status = "running";
      const hits: Array<{ url: string; title?: string; query: string; snippet?: string }> = [];
      // Result snippets SearXNG already returned (often with prices): used
      // as weaker sources at no extra egress.
      const snippets: Array<{ url: string; title?: string; query: string; snippet: string }> = [];
      for (const [i, q] of record.queries.entries()) {
        progress({ phase: "search", done: i, total: record.queries.length });
        const url = `${rc.searxngUrl}/search?${new URLSearchParams({
          q: q.query,
          format: "json",
          language: "en",
          safesearch: "0",
        }).toString()}`;
        q.sentAt = this.now();
        try {
          const res = await fetcher.get(url, "search", opts.signal);
          const json = parseJsonLoose<{
            results?: Array<{ url?: string; title?: string; content?: string }>;
          }>(res.body);
          const results = (json?.results ?? []).filter((r) => typeof r.url === "string");
          q.results = results.length;
          let picked = 0;
          for (const [rank, r] of results.entries()) {
            if (!checkEgressStatic(r.url!, "page", endpoints).allowed) continue;
            if (hits.some((h) => sameUrl(h.url, r.url!))) continue;
            if (picked < rc.pagesPerQuery) {
              hits.push({ url: r.url!, title: r.title, query: q.query, snippet: r.content });
              picked++;
            } else if (rank < 8 && r.content && !snippets.some((x) => sameUrl(x.url, r.url!))) {
              snippets.push({ url: r.url!, title: r.title, query: q.query, snippet: r.content });
            }
          }
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          q.error = err instanceof Error ? err.message : String(err);
          if (/ECONNREFUSED|fetch failed|connect/i.test(q.error))
            q.error = `SearXNG is not reachable at ${rc.searxngUrl}. Start it: docker compose -f docker/searxng/docker-compose.yml up -d`;
        }
      }
      save();
      if (record.queries.every((q) => q.error)) {
        record.status = "failed";
        record.error = record.queries[0]?.error ?? "search failed";
        save();
        approvals.emit(record.id, input.sessionKey, record.status);
        return this.result(record);
      }

      // 5. fetch + extract locally ----------------------------------------------------
      const pages = hits.slice(0, rc.maxPages);
      const itemsLine = items.length
        ? items.join("; ")
        : record.queries.map((q) => q.query).join("; ");
      let done = 0;
      await mapLimit(pages, 3, async (hit) => {
        const src: ResearchSource = { url: hit.url, title: hit.title, query: hit.query };
        record.sources.push(src);
        try {
          const res = await fetcher.get(hit.url, "page", opts.signal);
          src.fetchedAt = this.now();
          src.status = res.status;
          src.bytes = res.bytes;
          // Bot walls (403/429…) are not page content: fall back to the snippet.
          if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
          const readable =
            /html|xml/i.test(res.contentType) || !res.contentType
              ? await extractReadableContent({
                  html: res.body,
                  url: res.finalUrl,
                  extractMode: "text",
                })
              : { text: res.body, title: undefined };
          const text = (readable?.text ?? "").slice(0, 7_000);
          if (!src.title && readable?.title) src.title = readable.title;
          if (text.length < 80) {
            src.error = "no readable text";
            if (hit.snippet) src.extract = snippetExtract(hit.snippet);
          } else {
            const answer = await llm.complete(
              [
                { role: "system", content: EXTRACT_SYSTEM },
                {
                  role: "user",
                  content: `Items: ${itemsLine}\nPage title: ${src.title ?? ""}\nPage text:\n${text}`,
                },
              ],
              { maxTokens: 500, signal: opts.signal },
            );
            const parsed = parseJsonLoose<{ relevant?: boolean; facts?: unknown[]; note?: string }>(
              answer,
            );
            src.extract = JSON.stringify({
              relevant: parsed?.relevant === true,
              facts: Array.isArray(parsed?.facts) ? parsed.facts.slice(0, 12) : [],
              note: typeof parsed?.note === "string" ? parsed.note.slice(0, 300) : undefined,
            });
          }
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          src.error = err instanceof Error ? err.message : String(err);
          if (!hit.snippet) return;
          // A search snippet is still a (weaker) source.
          src.extract = snippetExtract(hit.snippet);
        } finally {
          done++;
          progress({ phase: "read", done, total: pages.length });
        }
      });
      for (const sn of snippets
        .filter((x) => !hits.some((h) => sameUrl(h.url, x.url)))
        .slice(0, 12)) {
        record.sources.push({
          url: sn.url,
          title: sn.title,
          query: sn.query,
          kind: "snippet",
          extract: snippetExtract(sn.snippet),
        });
      }
      save();

      // 6. synthesize (local model) ---------------------------------------------
      progress({ phase: "summarize" });
      const usable = record.sources.filter((s) => s.extract);
      const numbered = usable.map((s, i) => ({
        n: i + 1,
        url: s.url,
        title: s.title,
        extract: s.extract,
      }));
      const answer = await llm.complete(
        [
          { role: "system", content: SYNTH_SYSTEM },
          {
            role: "user",
            content: `Goal: ${goal}\nItems: ${itemsLine}\n\nFacts by source:\n${numbered
              .map((s) => `[${s.n}] ${s.title ?? ""} ${s.url}\n${s.extract}`)
              .join("\n\n")}`,
          },
        ],
        { maxTokens: 1_200, signal: opts.signal },
      );
      const synth = parseJsonLoose<{ summary?: unknown; estimates?: unknown[] }>(answer);
      record.summary =
        typeof synth?.summary === "string" && synth.summary.trim()
          ? synth.summary.trim()
          : usable.length
            ? "The local model could not summarize the sources; see the source list."
            : "No readable sources were found for these queries.";
      record.estimates = (Array.isArray(synth?.estimates) ? synth.estimates : [])
        .map((e) => normalizeEstimate(e, numbered))
        .filter((e): e is ValueEstimate => e !== null);
      record.status = "done";
      save();
      approvals.emit(record.id, input.sessionKey, "done");
      return this.result(record);
    } catch (err) {
      record.status = opts.signal?.aborted
        ? "expired"
        : err instanceof SecureEgressError
          ? "blocked"
          : "failed";
      record.error = err instanceof Error ? err.message : String(err);
      try {
        save();
      } catch {
        // vault locked mid-run: nothing to persist
      }
      approvals.emit(record.id, input.sessionKey, record.status);
      if (err instanceof SecureModeBlockedError) throw err;
      return this.result(record);
    }
  }

  result(r: ResearchRecord): SecureResearchResult {
    const usable = r.sources.filter((s) => s.extract);
    const hosts = new Set<string>();
    for (const e of r.egress) if (!e.blocked) hosts.add(e.host);
    return {
      id: r.id,
      status: r.status,
      approvalMode: r.approvalMode,
      queriesSent: r.queries.filter((q) => q.sentAt).map((q) => q.query),
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.estimates ? { estimates: r.estimates } : {}),
      sources: usable.map((s, i) => ({
        n: i + 1,
        url: s.url,
        ...(s.title ? { title: s.title } : {}),
        ...(s.kind === "snippet" || s.error
          ? { kind: "snippet" as const }
          : { kind: "page" as const }),
      })),
      ...(r.model ? { model: r.model } : {}),
      egressHosts: [...hosts],
      removedCount:
        r.queries.reduce((n, q) => n + (q.removed?.length ?? 0), 0) + (r.rejected?.length ?? 0),
      ...(r.error ? { error: r.error } : {}),
    };
  }
}

function snippetExtract(snippet: string): string {
  return JSON.stringify({
    relevant: true,
    facts: [],
    note: `search result snippet: ${snippet.slice(0, 400)}`,
  });
}

function dedupe(list: SanitizedQuery[]): SanitizedQuery[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = s.query.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function sameUrl(a: string, b: string): boolean {
  const n = (u: string) => u.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && v.trim() ? n : null;
  }
  return null;
}

function normalizeEstimate(
  raw: unknown,
  numbered: Array<{ n: number; url: string }>,
): ValueEstimate | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const item = typeof e.item === "string" ? e.item.trim().slice(0, 160) : "";
  if (!item) return null;
  let low = toNum(e.low);
  let high = toNum(e.high);
  if (low !== null && high !== null && low > high) [low, high] = [high, low];
  // Only cite sources that were actually read.
  const sources = (Array.isArray(e.sources) ? e.sources : [])
    .map((s) => numbered.find((x) => x.n === Number(s))?.url)
    .filter((u): u is string => Boolean(u));
  const conf = e.confidence === "high" || e.confidence === "medium" ? e.confidence : "low";
  return {
    item,
    low,
    high,
    currency:
      typeof e.currency === "string" && e.currency.trim() ? e.currency.trim().slice(0, 8) : "USD",
    ...(typeof e.basis === "string" ? { basis: e.basis.slice(0, 400) } : {}),
    confidence: sources.length ? conf : "low",
    sources: [...new Set(sources)],
  };
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
