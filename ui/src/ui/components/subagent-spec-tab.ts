/**
 * Spec-vs-Result oversight tab — sibling module of subagent-detail-modal.ts.
 *
 * Kept in a SEPARATE file (imported by the modal) so the in-UI diff-viewer and
 * completion-summary agents touching subagent-detail-modal.ts don't collide
 * with this work. The modal only adds: a TabId entry, a few ModalState fields,
 * a load hook in setActiveTab, and one render line delegating to renderSpecTab.
 *
 * Renders, top → bottom:
 *   1. Overall drift verdict + the original brief (markdown)
 *   2. Off-limits violations (RED — highest-priority drift), if any
 *   3. Per-criterion verdict rows (met / partial / unmet / unknown)
 *   4. Deferrals the agent admitted to
 *   5. Action row (re-spawn same / revised, accept deviation)
 *
 * Backend: `subagents.specAnalysis` (deterministic extraction + small LLM
 * verdict pass, cached on the run record) and `subagents.specAccept`.
 *
 * Reuses the existing `sadm-*` styles from subagent-detail-modal.ts plus a few
 * inline styles so no edit to the modal's shared <style> block is needed.
 */

import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../markdown";
import type { GatewayBrowserClient } from "../gateway";

export type SpecCriterionStatus = "met" | "unmet" | "partial" | "unknown";

export interface SpecCriterion {
  text: string;
  status: SpecCriterionStatus;
  evidence: string;
  /** True when synthesized from the brief rather than parsed verbatim. */
  inferred?: boolean;
}

export interface SpecAnalysisData {
  brief: string;
  criteria: SpecCriterion[];
  deferred: string[];
  offLimitsPatterns: string[];
  offLimitsViolations: Array<{ path: string; pattern: string }>;
  summary: string;
  heuristicOnly: boolean;
  /** True when criteria were synthesized from the brief vs parsed verbatim. */
  criteriaInferred?: boolean;
  accepted?: boolean;
  analyzedAt?: number;
  model?: string;
  provider?: string;
  /** Which tier produced the verdict: gateway | cli | ollama | heuristic. */
  verdictTier?: "gateway" | "cli" | "ollama" | "heuristic";
  /** Human label, e.g. "gateway primary (anthropic/claude-haiku…)". */
  verdictBy?: string;
  /** Per-tier failure reasons (for the "Why?" expander). */
  tierFailures?: Array<{ tier: string; reason: string }>;
}

/** Structural view of the modal's run record this tab needs. */
interface SpecRun {
  runId: string;
  task: string;
  childSessionKey?: string;
  requesterSessionKey: string;
  startedAt?: number;
  endedAt?: number;
  filesTouched?: Array<{ path: string; action: string; at: number }>;
  /** Absolute path to the JSONL transcript file; preferred over session-store lookup. */
  transcriptPath?: string;
}

/** Structural view of the modal state this tab reads/writes. */
export interface SpecTabHost {
  data: { run: SpecRun; source?: "live" | "archive" } | null;
  spec: SpecAnalysisData | null;
  specLoading: boolean;
  specError: string | null;
  specGated: boolean;
  specAccepting?: boolean;
  live?: { transcript?: Array<{ role: string; text: string }>; transcriptLoaded?: boolean } | null;
}

function req(client: GatewayBrowserClient, method: string, params?: unknown): Promise<unknown> {
  return (client as unknown as { request: (m: string, p?: unknown) => Promise<unknown> }).request(
    method,
    params,
  );
}

/** Flatten a transcript turn list to bounded plain text for the LLM pass. */
function transcriptToText(turns: Array<{ role: string; text: string }> | undefined): string {
  if (!turns?.length) return "";
  return turns
    .map((t) => `${t.role}: ${t.text}`)
    .join("\n")
    .slice(0, 16000);
}

/**
 * Lazily load the spec analysis. Auto-runs the (gated) backend pass; if the run
 * was short the backend returns `gated:true` and the UI offers a "Run analysis"
 * button that re-calls with force=true.
 */
export function loadSpecAnalysis(
  client: GatewayBrowserClient,
  host: SpecTabHost,
  requestUpdate: () => void,
  opts?: { force?: boolean },
): void {
  if (!host.data) return;
  const run = host.data.run;
  const isRunning = host.data.source !== "archive" && !run.endedAt;
  if (isRunning) return; // placeholder rendered directly
  if (host.specLoading) return;
  if (host.spec && !opts?.force) return; // already have a result

  host.specLoading = true;
  host.specError = null;
  requestUpdate();

  // Reuse the live transcript when the modal already loaded it; otherwise pull
  // the sub-agent's own transcript.  Priority: direct transcriptPath > childSessionKey
  // > runId-only (which falls back through archived history → transcript index).
  const haveLive = !!(host.live?.transcriptLoaded && host.live.transcript?.length);
  const transcriptP: Promise<string> = haveLive
    ? Promise.resolve(transcriptToText(host.live!.transcript))
    : req(client, "sessions.transcript", {
        runId: run.runId,
        ...(run.transcriptPath ? { transcriptPath: run.transcriptPath } : {}),
        ...(run.childSessionKey ? { sessionKey: run.childSessionKey } : {}),
        limit: 80,
        maxChars: 8000,
      })
        .then((r: unknown) => {
          const tr = r as { turns?: Array<{ role: string; text: string }> };
          return transcriptToText(tr?.turns);
        })
        .catch(() => "");

  const durationMs =
    run.startedAt && run.endedAt ? run.endedAt - run.startedAt : 0;

  void transcriptP
    .then((transcriptText) =>
      req(client, "subagents.specAnalysis", {
        runId: run.runId,
        sessionKey: run.childSessionKey ?? run.requesterSessionKey,
        transcriptText,
        durationMs,
        force: opts?.force === true,
      }),
    )
    .then((r: unknown) => {
      const res = r as { ok?: boolean; gated?: boolean; analysis?: SpecAnalysisData; error?: string };
      if (res?.ok && res.analysis) {
        host.spec = res.analysis;
        host.specGated = res.gated === true;
      } else {
        host.specError = res?.error ?? "Analysis failed";
      }
    })
    .catch((e) => {
      host.specError = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      host.specLoading = false;
      requestUpdate();
    });
}

async function acceptDeviation(
  client: GatewayBrowserClient,
  host: SpecTabHost,
  requestUpdate: () => void,
): Promise<void> {
  if (!host.data || host.specAccepting) return;
  host.specAccepting = true;
  requestUpdate();
  try {
    const res = (await req(client, "subagents.specAccept", {
      runId: host.data.run.runId,
      accepted: true,
    })) as { ok?: boolean; error?: string };
    if (res?.ok && host.spec) {
      host.spec.accepted = true;
    } else if (!res?.ok) {
      alert(`Could not mark accepted: ${res?.error ?? "unknown error"}`);
    }
  } catch (e) {
    alert(`Could not mark accepted: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    host.specAccepting = false;
    requestUpdate();
  }
}

async function respawnSameBrief(
  client: GatewayBrowserClient,
  host: SpecTabHost,
  requestUpdate: () => void,
): Promise<void> {
  if (!host.data) return;
  if (!confirm("Re-spawn this agent with the SAME brief?")) return;
  try {
    const res = (await req(client, "subagents.respawn", {
      runId: host.data.run.runId,
      force: true,
    })) as { ok?: boolean; newRunId?: string; error?: string };
    if (res?.ok) {
      alert(
        res.newRunId
          ? `Re-spawn started\nNew runId: ${String(res.newRunId).slice(0, 16)}…`
          : "Re-spawn started — check the Active list.",
      );
    } else {
      alert(`Re-spawn failed: ${res?.error ?? "Unknown error"}`);
    }
  } catch (e) {
    alert(`Re-spawn failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  requestUpdate();
}

async function respawnRevisedBrief(
  client: GatewayBrowserClient,
  host: SpecTabHost,
  requestUpdate: () => void,
): Promise<void> {
  if (!host.data) return;
  const revised = prompt("Re-spawn with a revised brief — edit the task:", host.data.run.task);
  if (revised == null) return;
  const task = revised.trim();
  if (!task) return;
  try {
    const res = (await req(client, "subagents.respawn", {
      runId: host.data.run.runId,
      task,
      force: true,
    })) as { ok?: boolean; newRunId?: string; error?: string };
    if (res?.ok) {
      alert(
        res.newRunId
          ? `Re-spawn started\nNew runId: ${String(res.newRunId).slice(0, 16)}…`
          : "Re-spawn started — check the Active list.",
      );
    } else {
      alert(`Re-spawn failed: ${res?.error ?? "Unknown error"}`);
    }
  } catch (e) {
    alert(`Re-spawn failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  requestUpdate();
}

// ── Render ──────────────────────────────────────────────────────────────────

const STATUS_META: Record<SpecCriterionStatus, { label: string; color: string; icon: string }> = {
  met: { label: "Met", color: "#22c55e", icon: "✓" },
  partial: { label: "Partial", color: "#f59e0b", icon: "◐" },
  unmet: { label: "Unmet", color: "#ef4444", icon: "✗" },
  unknown: { label: "Unknown", color: "rgba(245,245,244,0.45)", icon: "?" },
};

function statusChip(status: SpecCriterionStatus): TemplateResult {
  const m = STATUS_META[status] ?? STATUS_META.unknown;
  return html`<span
    style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;
           padding:2px 8px;border-radius:999px;white-space:nowrap;
           color:${m.color};border:1px solid ${m.color}40;background:${m.color}14;"
    >${m.icon} ${m.label}</span
  >`;
}

function sectionLabel(text: string): TemplateResult {
  return html`<div
    style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;
           color:var(--g-fg-dim,rgba(245,245,244,0.5));margin:18px 0 8px;"
  >
    ${text}
  </div>`;
}

/** "Verdict by: …" line — names the tier that produced the grade. */
function verdictByLabel(spec: SpecAnalysisData): TemplateResult {
  const by =
    spec.verdictBy ??
    (spec.heuristicOnly
      ? "heuristic (no LLM available)"
      : spec.model
        ? `${spec.provider ?? "LLM"}/${spec.model}`
        : "LLM");
  const color = spec.heuristicOnly ? "#f59e0b" : "#22c55e";
  return html`Verdict by: <span style="color:${color};font-weight:600;">${by}</span>`;
}

/**
 * Collapsible "Why?" showing each failed tier's reason — only rendered when a
 * tier failed (heuristic-only result, or earlier tiers fell through to a later
 * one). Lets the operator debug a missing/degraded LLM verdict.
 */
function whyExpander(spec: SpecAnalysisData): TemplateResult | typeof nothing {
  const failures = spec.tierFailures ?? [];
  if (!failures.length) return nothing;
  return html` ·
    <details style="display:inline;">
      <summary style="display:inline;cursor:pointer;color:#f59e0b;">Why?</summary>
      <div
        style="margin-top:6px;padding:8px 10px;border-radius:8px;font-size:11px;
               background:rgba(245,245,244,0.04);border:1px solid rgba(245,245,244,0.08);
               color:var(--g-fg-dim,rgba(245,245,244,0.6));"
      >
        ${failures.map(
          (f) => html`<div style="margin:2px 0;">
            <span style="color:#ef4444;font-weight:600;text-transform:uppercase;">${f.tier}</span>
            — ${f.reason}
          </div>`,
        )}
      </div>
    </details>`;
}

export function renderSpecTab(
  host: SpecTabHost,
  run: SpecRun,
  client: GatewayBrowserClient | null,
  requestUpdate: () => void,
): TemplateResult {
  const isRunning = host.data?.source !== "archive" && !run.endedAt;
  if (isRunning) {
    return html`<div class="sadm-completion-running" style="padding:24px;text-align:center;">
      <div style="font-size:13px;color:var(--g-fg-dim,rgba(245,245,244,0.55));">
        Still running — the spec-vs-result comparison appears once the run finishes.
      </div>
    </div>`;
  }

  const spec = host.spec;
  const verdictColor = spec?.offLimitsViolations.length
    ? "#ef4444"
    : spec?.criteria.some((c) => c.status === "unmet")
      ? "#f59e0b"
      : "#22c55e";

  return html`
    <div class="sadm-spec" style="display:flex;flex-direction:column;">
      <!-- Overall verdict -->
      ${host.specLoading && !spec
        ? html`<div
            style="padding:8px 12px;border-radius:8px;font-size:13px;
                   background:rgba(245,245,244,0.04);color:var(--g-fg-dim,rgba(245,245,244,0.6));"
          >
            Comparing result against the original brief…
          </div>`
        : nothing}
      ${host.specError
        ? html`<div
            style="padding:8px 12px;border-radius:8px;font-size:12px;
                   color:#ef4444;border:1px solid #ef444440;background:#ef444410;"
          >
            ${host.specError}
          </div>`
        : nothing}
      ${spec
        ? html`<div
            style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:10px;
                   border:1px solid ${verdictColor}33;background:${verdictColor}10;"
          >
            <span style="font-size:16px;line-height:1.2;">${spec.offLimitsViolations.length ? "🚨" : "🧭"}</span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;color:var(--g-fg,#f5f5f4);">
                ${spec.summary || "Spec comparison complete."}
              </div>
              <div style="font-size:11px;color:var(--g-fg-dim,rgba(245,245,244,0.45));margin-top:3px;">
                ${verdictByLabel(spec)}
                ${spec.criteriaInferred ? html` · <span style="color:#a78bfa;">criteria inferred from brief</span>` : nothing}
                ${spec.accepted ? html` · <span style="color:#22c55e;">deviation accepted</span>` : nothing}
                ${whyExpander(spec)}
              </div>
            </div>
          </div>`
        : nothing}

      <!-- Off-limits violations — highest-priority drift -->
      ${spec && spec.offLimitsViolations.length
        ? html`
            ${sectionLabel(`⚠ Off-limits violations (${spec.offLimitsViolations.length})`)}
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${spec.offLimitsViolations.map(
                (v) => html`<div
                  style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;
                         border:1px solid #ef444455;background:#ef444412;font-size:12px;"
                >
                  <span style="color:#ef4444;font-weight:700;">EDITED</span>
                  <code style="color:var(--g-fg,#f5f5f4);font-size:12px;word-break:break-all;">${v.path}</code>
                  <span style="color:var(--g-fg-dim,rgba(245,245,244,0.45));margin-left:auto;white-space:nowrap;"
                    >matched “${v.pattern}”</span
                  >
                </div>`,
              )}
            </div>
          `
        : spec && spec.offLimitsPatterns.length
          ? html`<div
              style="margin-top:10px;font-size:11px;color:#22c55e;display:flex;align-items:center;gap:6px;"
            >
              ✓ No off-limits files touched (${spec.offLimitsPatterns.length} pattern${
                spec.offLimitsPatterns.length === 1 ? "" : "s"
              } checked)
            </div>`
          : nothing}

      <!-- Per-criterion verdicts -->
      ${spec
        ? html`
            ${sectionLabel(
              `Acceptance criteria (${spec.criteria.length})${spec.criteriaInferred ? " · inferred" : ""}`,
            )}
            ${spec.criteriaInferred
              ? html`<div
                  style="font-size:11px;color:var(--g-fg-dim,rgba(245,245,244,0.45));margin:-2px 0 8px;"
                >
                  The brief stated no explicit acceptance criteria — these were inferred from its intent
                  and graded individually.
                </div>`
              : nothing}
            ${spec.criteria.length
              ? html`<div style="display:flex;flex-direction:column;gap:6px;">
                  ${spec.criteria.map(
                    (c) => html`<div
                      style="display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;
                             background:rgba(245,245,244,0.03);border:1px solid rgba(245,245,244,0.06);"
                    >
                      <div style="display:flex;align-items:flex-start;gap:8px;">
                        <div style="flex:1;min-width:0;font-size:12.5px;color:var(--g-fg,#f5f5f4);line-height:1.4;">
                          ${c.text}
                          ${c.inferred
                            ? html`<span
                                style="margin-left:6px;font-size:10px;font-weight:600;letter-spacing:0.03em;
                                       color:#a78bfa;border:1px solid #a78bfa40;background:#a78bfa14;
                                       padding:1px 6px;border-radius:999px;white-space:nowrap;vertical-align:middle;"
                                >inferred</span
                              >`
                            : nothing}
                        </div>
                        ${statusChip(c.status)}
                      </div>
                      ${c.evidence
                        ? html`<div
                            style="font-size:11px;color:var(--g-fg-dim,rgba(245,245,244,0.5));
                                   padding-left:2px;border-left:2px solid rgba(245,245,244,0.12);padding-left:8px;"
                          >
                            ${c.evidence}
                          </div>`
                        : nothing}
                    </div>`,
                  )}
                </div>`
              : html`<div style="font-size:12px;color:var(--g-fg-dim,rgba(245,245,244,0.45));">
                  Could not derive any acceptance criteria — the brief was empty.
                </div>`}
          `
        : nothing}

      <!-- Deferrals -->
      ${spec && spec.deferred.length
        ? html`
            ${sectionLabel(`Deferred / out of scope (${spec.deferred.length})`)}
            <div style="display:flex;flex-direction:column;gap:5px;">
              ${spec.deferred.map(
                (d) => html`<div style="font-size:12px;color:var(--g-fg,#f5f5f4);display:flex;gap:8px;">
                  <span style="color:#f59e0b;">⟳</span><span>${d}</span>
                </div>`,
              )}
            </div>
          `
        : nothing}

      <!-- Original brief -->
      ${spec
        ? html`
            ${sectionLabel("Original brief")}
            <div
              class="sadm-task-block sadm-task-markdown"
              style="max-height:320px;overflow:auto;"
            >
              ${unsafeHTML(toSanitizedMarkdownHtml(spec.brief || run.task || "_No brief recorded._"))}
            </div>
          `
        : nothing}

      <!-- Action row -->
      ${spec && client
        ? html`<div
            style="display:flex;flex-wrap:wrap;gap:8px;margin-top:18px;padding-top:14px;
                   border-top:1px solid rgba(245,245,244,0.08);"
          >
            <button
              class="sadm-tab"
              style="cursor:pointer;"
              ?disabled=${host.specLoading}
              @click=${() => loadSpecAnalysis(client, host, requestUpdate, { force: true })}
              title="Re-grade this run against the brief (re-runs the LLM verdict)"
            >
              ${host.specLoading ? "Analysing…" : "🔁 Re-analyze"}
            </button>
            <button class="sadm-tab" style="cursor:pointer;" @click=${() => void respawnSameBrief(client, host, requestUpdate)}>
              ↻ Re-spawn (same brief)
            </button>
            <button class="sadm-tab" style="cursor:pointer;" @click=${() => void respawnRevisedBrief(client, host, requestUpdate)}>
              ✎ Re-spawn (revised brief)
            </button>
            <button
              class="sadm-tab"
              style="cursor:pointer;margin-left:auto;${spec.accepted ? "opacity:0.6;" : ""}"
              ?disabled=${host.specAccepting || spec.accepted}
              @click=${() => void acceptDeviation(client, host, requestUpdate)}
            >
              ${spec.accepted ? "✓ Deviation accepted" : host.specAccepting ? "Saving…" : "Mark deviation accepted"}
            </button>
          </div>`
        : nothing}
    </div>
  `;
}
