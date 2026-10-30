/**
 * Business hub › Pipeline — drag-and-drop board + list, conversion metrics,
 * a required-fields prompt when a stage needs more info, and the stage /
 * automation editor.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { BusinessHubApp } from "../app";
import { barList, funnelChart } from "../charts";
import { date, fromInputDate, money, pct, relTime, toInputDate } from "../format";
import { icons } from "../icons";
import type { Deal, Pipeline, PipelineMetrics, Stage, StageRule } from "../types";
import { emptyState, errorCard, formValues, modal, searchBox, skeletonKpis } from "./ui";

type PipelinePayload = { pipelines: Array<{ id: string; name: string }>; pipeline: Pipeline; rules: StageRule[]; events: string[]; requirableFields: string[] };

const FIELD_LABEL: Record<string, string> = {
  valueCents: "Deal value",
  contactId: "Contact",
  companyId: "Company",
  expectedCloseAt: "Expected close",
  nextAction: "Next action",
  nextActionAt: "Next action date",
  lostReason: "Lost reason",
  contactEmail: "Contact email",
  owner: "Owner",
};

const EVENT_LABEL: Record<string, string> = {
  "email.sent": "Email sent",
  "email.clicked": "Email link clicked",
  "email.replied": "Email reply received",
  "form.submitted": "Form submitted",
  "meeting.booked": "Meeting booked",
  "payment.succeeded": "Payment received",
};

let dragId: string | null = null;

export async function moveWithPrompt(h: BusinessHubApp, deal: Deal, stage: Stage, patch?: Record<string, unknown>): Promise<void> {
  const res = await h.act<{ ok?: false; needs?: string[]; deal?: Deal; message?: string }>("hub.deals.move", { id: deal.id, stageId: stage.id, patch }, null, ["deals", "pipeline", "overview", "contact"]);
  if (res && res.needs?.length) {
    h.ui.modal = { kind: "needs", deal, stage, needs: res.needs };
    h.refresh();
  } else if (res?.deal) {
    h.showToast(stage.kind === "won" ? `${deal.title} won — it's now a client.` : `${deal.title} → ${stage.name}`);
  }
}

function needsModal(h: BusinessHubApp, m: { deal: Deal; stage: Stage; needs: string[] }): TemplateResult {
  const fields = m.needs.filter((f) => f !== "contactId" && f !== "companyId" && f !== "contactEmail");
  const blockers = m.needs.filter((f) => !fields.includes(f));
  return modal(
    h,
    `Move to ${m.stage.name}`,
    html`<p class="muted" style="margin-top:0">${m.stage.name} needs a little more about <b>${m.deal.title}</b>.</p>
      ${blockers.length ? html`<div class="banner glass"><span class="warn">●</span> Link a ${blockers.map((b) => FIELD_LABEL[b] ?? b).join(" / ")} first — open the deal to attach one.</div>` : nothing}
      <form id="needs" class="stack" @submit=${(e: Event) => e.preventDefault()}>
        ${fields.map((f) =>
          f === "valueCents"
            ? html`<label class="field">Deal value (${m.deal.currency})<input class="input" name="valueCents" type="number" min="1" step="0.01" required value=${m.deal.valueCents ? m.deal.valueCents / 100 : ""} /></label>`
            : f === "expectedCloseAt" || f === "nextActionAt"
              ? html`<label class="field">${FIELD_LABEL[f]}<input class="input" name=${f} type="date" required /></label>`
              : f === "lostReason"
                ? html`<label class="field">Why was it lost?<select class="input" name="lostReason" required><option value="">Choose…</option>${["Price", "Timing", "Went with a competitor", "No budget", "No response", "Not a fit", "Other"].map((r) => html`<option>${r}</option>`)}</select></label>`
                : html`<label class="field">${FIELD_LABEL[f] ?? f}<input class="input" name=${f} required /></label>`,
        )}
      </form>`,
    html`<button class="btn" @click=${() => { h.ui.modal = null; h.refresh(); }}>Cancel</button>
      ${blockers.length
        ? html`<button class="btn primary" @click=${() => { h.ui.modal = null; h.openDetail({ kind: "deal", id: m.deal.id }); }}>Open deal</button>`
        : html`<button class="btn primary" @click=${async (e: Event) => {
            const form = (e.target as HTMLElement).closest(".modal")!.querySelector("form") as HTMLFormElement;
            if (!form.reportValidity()) return;
            const v = formValues(form);
            const patch: Record<string, unknown> = {};
            for (const f of fields) {
              if (f === "valueCents") patch.valueCents = Math.round(Number(v.valueCents) * 100);
              else if (f === "expectedCloseAt" || f === "nextActionAt") patch[f] = fromInputDate(v[f]);
              else patch[f] = v[f];
            }
            h.ui.modal = null;
            await moveWithPrompt(h, m.deal, m.stage, patch);
          }}>Move deal</button>`}`,
  );
}

export function dealModal(h: BusinessHubApp, pipeline: Pipeline, deal: Partial<Deal> | null): TemplateResult {
  const isNew = !deal?.id;
  return modal(
    h,
    isNew ? "New deal" : `Edit ${deal?.title}`,
    html`<form class="stack" @submit=${(e: Event) => e.preventDefault()}>
      <label class="field">Title<input class="input" name="title" required .value=${deal?.title ?? ""} placeholder="e.g. Acme — website redesign" /></label>
      ${isNew ? html`<div class="field-row">
        <label class="field">Contact name<input class="input" name="contactName" placeholder="Jane Doe" /></label>
        <label class="field">Contact email<input class="input" name="contactEmail" type="email" placeholder="jane@acme.com" /></label>
      </div>
      <label class="field">Company<input class="input" name="companyName" placeholder="Acme Inc" /></label>` : nothing}
      <div class="field-row">
        <label class="field">Stage<select class="input" name="stageId">${pipeline.stages.map((s) => html`<option value=${s.id} ?selected=${s.id === (deal?.stageId ?? pipeline.stages[0].id)}>${s.name}</option>`)}</select></label>
        <label class="field">Value<input class="input" name="value" type="number" min="0" step="0.01" .value=${deal?.valueCents ? String(deal.valueCents / 100) : ""} placeholder="0" /></label>
      </div>
      <div class="field-row">
        <label class="field">Next action<input class="input" name="nextAction" .value=${deal?.nextAction ?? ""} placeholder="Send proposal" /></label>
        <label class="field">Due<input class="input" name="nextActionAt" type="date" .value=${toInputDate(deal?.nextActionAt)} /></label>
        <label class="field">Expected close<input class="input" name="expectedCloseAt" type="date" .value=${toInputDate(deal?.expectedCloseAt)} /></label>
      </div>
    </form>`,
    html`<button class="btn" @click=${() => { h.ui.modal = null; h.refresh(); }}>Cancel</button>
      <button class="btn primary" @click=${async (e: Event) => {
        const form = (e.target as HTMLElement).closest(".modal")!.querySelector("form") as HTMLFormElement;
        if (!form.reportValidity()) return;
        const v = formValues(form);
        let contactId = deal?.contactId ?? null;
        let companyId = deal?.companyId ?? null;
        if (isNew && (v.contactName || v.contactEmail)) {
          const c = await h.act<{ contact: { id: string; companyId: string | null } }>("hub.contacts.save", { contact: { name: v.contactName || undefined, email: v.contactEmail || undefined, companyName: v.companyName || undefined } });
          if (!c) return;
          contactId = c.contact.id;
          companyId = c.contact.companyId;
        }
        const params = { id: deal?.id, title: v.title, stageId: v.stageId, valueCents: Math.round(Number(v.value || 0) * 100), nextAction: v.nextAction || null, nextActionAt: fromInputDate(v.nextActionAt), expectedCloseAt: fromInputDate(v.expectedCloseAt), contactId, companyId };
        const r = await h.act("hub.deals.save", params, isNew ? "Deal created" : "Deal saved", ["deals", "pipeline", "overview"]);
        if (r) {
          h.ui.modal = null;
          h.refresh();
        }
      }}>${isNew ? "Create deal" : "Save"}</button>`,
  );
}

function stagesModal(h: BusinessHubApp, p: PipelinePayload): TemplateResult {
  const draft = (h.ui.stageDraft as Array<Partial<Stage> & { name: string }>) ?? p.pipeline.stages.map((s) => ({ ...s }));
  const rules = (h.ui.ruleDraft as StageRule[]) ?? p.rules.map((r) => ({ ...r }));
  h.ui.stageDraft = draft;
  h.ui.ruleDraft = rules;
  const nameOf = (id: string) => draft.find((s) => s.id === id)?.name ?? "?";
  return modal(
    h,
    "Stages & automation",
    html`<h3>Stages</h3>
      <p class="faint small" style="margin:4px 0 10px">Required fields must be filled before a deal can enter that stage. "Stalls after" flags deals that sit too long.</p>
      <div class="stack">
        ${draft.map(
          (s, i) => html`<div class="glass card" style="padding:12px">
            <div class="row" style="flex-wrap:wrap">
              <input class="input" style="flex:1 1 140px" .value=${s.name} aria-label="Stage name" @input=${(e: Event) => (s.name = (e.target as HTMLInputElement).value)} />
              <select class="input" style="width:110px" aria-label="Kind" @change=${(e: Event) => { s.kind = (e.target as HTMLSelectElement).value as Stage["kind"]; h.refresh(); }}>
                ${["open", "won", "lost"].map((k) => html`<option value=${k} ?selected=${(s.kind ?? "open") === k}>${k}</option>`)}
              </select>
              <input class="input" style="width:84px" type="number" min="0" max="100" .value=${String(s.probability ?? 0)} aria-label="Win probability %" title="Win probability %" @input=${(e: Event) => (s.probability = Number((e.target as HTMLInputElement).value))} />
              <input class="input" style="width:96px" type="number" min="0" placeholder="stall d" .value=${s.rotDays ? String(s.rotDays) : ""} aria-label="Stalls after days" title="Stalls after (days)" @input=${(e: Event) => (s.rotDays = Number((e.target as HTMLInputElement).value) || null)} />
              <button class="btn sm ghost" ?disabled=${i === 0} aria-label="Move up" @click=${() => { draft.splice(i - 1, 0, draft.splice(i, 1)[0]); h.refresh(); }}>↑</button>
              <button class="btn sm ghost danger" aria-label="Remove stage" @click=${() => { draft.splice(i, 1); h.refresh(); }}>${icons.x()}</button>
            </div>
            <div class="chips" style="margin-top:8px">
              ${p.requirableFields.map((f) => {
                const on = (s.requiredFields ?? []).includes(f);
                return html`<button class="chip" aria-pressed=${on} @click=${() => { s.requiredFields = on ? (s.requiredFields ?? []).filter((x) => x !== f) : [...(s.requiredFields ?? []), f]; h.refresh(); }}>${FIELD_LABEL[f] ?? f}</button>`;
              })}
            </div>
          </div>`,
        )}
        <button class="btn" @click=${() => { draft.splice(Math.max(0, draft.length - 2), 0, { name: "New stage", kind: "open", probability: 30, requiredFields: [] }); h.refresh(); }}>${icons.plus()} Add stage</button>
      </div>
      <div class="divider"></div>
      <h3>Automation</h3>
      <p class="faint small" style="margin:4px 0 10px">When something happens to a contact, their open deals move forward automatically (never backwards).</p>
      <div class="stack">
        ${rules.map(
          (r, i) => html`<div class="row" style="flex-wrap:wrap">
            <label class="check"><input type="checkbox" .checked=${r.enabled} @change=${(e: Event) => (r.enabled = (e.target as HTMLInputElement).checked)} /></label>
            <select class="input" style="flex:1 1 160px" @change=${(e: Event) => (r.event = (e.target as HTMLSelectElement).value)}>${p.events.map((ev) => html`<option value=${ev} ?selected=${ev === r.event}>${EVENT_LABEL[ev] ?? ev}</option>`)}</select>
            <span class="faint">→</span>
            <select class="input" style="flex:1 1 140px" @change=${(e: Event) => (r.toStageId = (e.target as HTMLSelectElement).value)}>${draft.filter((s) => s.id).map((s) => html`<option value=${s.id!} ?selected=${s.id === r.toStageId}>${s.name}</option>`)}</select>
            <span class="faint small" style="flex:1 1 100%">${r.onlyFrom.length ? `only from ${r.onlyFrom.map(nameOf).join(", ")}` : "from any earlier stage"}</span>
            <button class="btn sm ghost danger" aria-label="Remove rule" @click=${() => { rules.splice(i, 1); h.refresh(); }}>${icons.x()}</button>
          </div>`,
        )}
        <button class="btn" @click=${() => { rules.push({ id: "", event: "form.submitted", toStageId: draft.find((s) => s.id)?.id ?? "", onlyFrom: [], enabled: true }); h.refresh(); }}>${icons.plus()} Add rule</button>
      </div>`,
    html`<button class="btn" @click=${() => { h.ui.modal = null; h.ui.stageDraft = null; h.ui.ruleDraft = null; h.refresh(); }}>Cancel</button>
      <button class="btn primary" @click=${async () => {
        const removedWithDeals = p.pipeline.stages.filter((s) => !draft.some((d) => d.id === s.id));
        const moveTo = removedWithDeals.length ? draft.find((d) => d.id && d.kind === "open")?.id : undefined;
        const ok = await h.act("hub.pipeline.saveStages", { pipelineId: p.pipeline.id, stages: draft, moveDealsTo: moveTo });
        if (!ok) return;
        const saved = await h.act("hub.pipeline.saveRules", { pipelineId: p.pipeline.id, rules: rules.filter((r) => r.toStageId).map(({ id, ...r }) => (id ? { id, ...r } : r)) }, "Pipeline saved", ["pipeline", "deals", "overview"]);
        if (saved) {
          h.ui.modal = null;
          h.ui.stageDraft = null;
          h.ui.ruleDraft = null;
          h.refresh();
        }
      }}>Save pipeline</button>`,
    true,
  );
}

function dealCard(h: BusinessHubApp, d: Deal): TemplateResult {
  return html`<article class="deal ${d.rotting ? "rot" : ""}" draggable="true" tabindex="0" aria-label=${`${d.title}, ${money(d.valueCents, d.currency)}`}
    @dragstart=${(e: DragEvent) => { dragId = d.id; e.dataTransfer?.setData("text/plain", d.id); (e.currentTarget as HTMLElement).classList.add("dragging"); }}
    @dragend=${(e: DragEvent) => { dragId = null; (e.currentTarget as HTMLElement).classList.remove("dragging"); }}
    @click=${() => h.openDetail({ kind: "deal", id: d.id })}
    @keydown=${(e: KeyboardEvent) => e.key === "Enter" && h.openDetail({ kind: "deal", id: d.id })}>
    <b>${d.title}</b>
    <div class="meta"><span>${d.companyName ?? d.contactName ?? d.sourceName ?? "—"}</span><span class="val">${d.valueCents ? money(d.valueCents, d.currency, { compact: true }) : ""}</span></div>
    ${d.nextAction ? html`<div class="next ${d.nextActionAt && d.nextActionAt < Date.now() ? "bad" : ""}">${icons.clock()} ${d.nextAction}${d.nextActionAt ? html` · ${relTime(d.nextActionAt)}` : nothing}</div>` : nothing}
    ${d.rotting ? html`<div class="next warn">Stalled ${d.ageDays}d in stage</div>` : nothing}
  </article>`;
}

export function renderPipeline(h: BusinessHubApp): TemplateResult {
  const p = h.load<PipelinePayload>("pipeline:def", "hub.pipeline.get", {}, { maxAgeMs: 120_000 });
  const search = (h.ui.pipeSearch as string) ?? "";
  const view = (h.ui.pipeView as "board" | "list") ?? "board";
  const deals = h.load<{ deals: Deal[]; total: number }>(`deals:${search}`, "hub.deals.list", { search: search || undefined, limit: 1000 });
  const metrics = h.load<PipelineMetrics>("pipeline:metrics", "hub.pipeline.metrics", {});
  if (!p.data) return p.error ? errorCard(h, p.error, "pipeline") : html`${skeletonKpis(4)}<div class="board">${[1, 2, 3, 4].map(() => html`<div class="glass col sk"></div>`)}</div>`;
  const pipeline = p.data.pipeline;
  const list = deals.data?.deals ?? [];
  const m = metrics.data;
  const modalState = h.ui.modal as { kind: string } | null;

  const toolbar = html`<div class="toolbar">
    ${searchBox(search, (v) => { h.ui.pipeSearch = v; h.refresh(); }, "Search deals, contacts, companies")}
    <div class="chips"><button class="chip" aria-pressed=${view === "board"} @click=${() => { h.ui.pipeView = "board"; h.refresh(); }}>Board</button><button class="chip" aria-pressed=${view === "list"} @click=${() => { h.ui.pipeView = "list"; h.refresh(); }}>List</button></div>
    <span class="spacer"></span>
    <button class="btn" @click=${() => { h.ui.modal = { kind: "stages" }; h.refresh(); }}>Stages & automation</button>
    <button class="btn" title="Mirror next actions into kanban" @click=${() => h.act<{ created: number; updated: number; closed: number }>("hub.pipeline.syncReminders", {}, (r) => `Kanban follow-ups: ${r.created} new, ${r.updated} updated, ${r.closed} closed`)}>${icons.clock()} Sync follow-ups</button>
    <button class="btn primary" @click=${() => { h.ui.modal = { kind: "deal" }; h.refresh(); }}>${icons.plus()} New deal</button>
  </div>`;

  const metricsRow = m
    ? html`<div class="kpis k4">
        <div class="glass kpi"><div class="label">Open pipeline</div><div class="value">${money(m.open.valueCents, "USD", { compact: true })}</div><div class="foot">${m.open.count} deals · weighted ${money(m.open.weightedCents, "USD", { compact: true })}</div></div>
        <div class="glass kpi"><div class="label">Won</div><div class="value">${money(m.won.valueCents, "USD", { compact: true })}</div><div class="foot">${m.won.count} deals · ${m.lost.count} lost</div></div>
        <div class="glass kpi"><div class="label">Win rate</div><div class="value">${pct(m.winRate)}</div><div class="foot">of closed deals</div></div>
        <div class="glass kpi"><div class="label">Sales cycle</div><div class="value">${m.avgCycleDays ?? "—"}${m.avgCycleDays !== null ? html`<span class="faint" style="font-size:14px"> days</span>` : nothing}</div><div class="foot">created → won</div></div>
      </div>`
    : skeletonKpis(4);

  let body: TemplateResult;
  if (!list.length && !deals.loading && !search) {
    body = emptyState({
      icon: "pipeline",
      title: "No deals yet",
      text: "Deals open automatically when leads arrive from lead search, imports, landing-page forms or campaigns. You can also add one by hand.",
      actions: [
        { label: "Find leads", primary: true, run: () => h.go("leads", { leadsCompose: true }) },
        { label: "Import a list", run: () => h.go("imports") },
        { label: "New deal", run: () => { h.ui.modal = { kind: "deal" }; h.refresh(); } },
      ],
    });
  } else if (view === "board") {
    body = html`<div class="board" role="list">
      ${pipeline.stages.map((s) => {
        const col = list.filter((d) => d.stageId === s.id);
        const sum = col.reduce((a, d) => a + d.valueCents, 0);
        return html`<section class="glass col" role="listitem" aria-label=${s.name}
          @dragover=${(e: DragEvent) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add("over"); }}
          @dragleave=${(e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("over")}
          @drop=${(e: DragEvent) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).classList.remove("over");
            const id = e.dataTransfer?.getData("text/plain") || dragId;
            const d = list.find((x) => x.id === id);
            if (d && d.stageId !== s.id) {
              d.stageId = s.id; // optimistic
              h.refresh();
              void moveWithPrompt(h, { ...d, stageId: d.stageId }, s);
            }
          }}>
          <div class="col-head"><b><span class="dot-s" style="--stage:${s.color ?? "var(--bh-gold)"}"></span>${s.name} <span class="faint small">${col.length}</span></b><span class="sum">${sum ? money(sum, "USD", { compact: true }) : ""}</span></div>
          <div class="col-body">${col.length ? col.map((d) => dealCard(h, d)) : html`<div class="col-empty">${s.kind === "won" ? "Drop a deal here to win it" : s.kind === "lost" ? "Drop lost deals here" : "Drag deals here"}</div>`}</div>
        </section>`;
      })}
    </div>`;
  } else {
    const stageName = new Map(pipeline.stages.map((s) => [s.id, s]));
    body = html`<div class="glass table-wrap"><table class="table">
      <thead><tr><th>Deal</th><th>Stage</th><th class="r">Value</th><th class="hide-sm">Source</th><th class="hide-sm">Next action</th><th class="hide-sm">Age</th></tr></thead>
      <tbody>${list.map((d) => {
        const st = stageName.get(d.stageId);
        return html`<tr class="click" @click=${() => h.openDetail({ kind: "deal", id: d.id })}>
          <td><div class="who"><div class="t"><b>${d.title}</b><span>${d.companyName ?? d.contactName ?? ""}</span></div></div></td>
          <td><span class="chip"><span class="dot-s" style="--stage:${st?.color ?? "var(--bh-gold)"}"></span>${st?.name ?? "?"}</span></td>
          <td class="r num">${money(d.valueCents, d.currency)}</td>
          <td class="hide-sm">${d.sourceName ?? "—"}</td>
          <td class="hide-sm">${d.nextAction ? html`${d.nextAction} <span class="faint small">${d.nextActionAt ? date(d.nextActionAt) : ""}</span>` : html`<span class="faint">—</span>`}</td>
          <td class="hide-sm ${d.rotting ? "warn" : "faint"}">${d.ageDays ?? 0}d</td>
        </tr>`;
      })}</tbody></table></div>`;
  }

  return html`
    ${metricsRow}
    ${toolbar}
    ${body}
    ${m && list.length
      ? html`<div class="grid cols-3" style="margin-top:16px">
          <section class="glass card"><div class="card-head"><h2>Stage conversion</h2></div>${funnelChart(m.stages.filter((s) => s.kind !== "lost").map((s) => ({ label: s.name, value: s.reached, conv: s.conversionFromPrev, color: pipeline.stages.find((x) => x.id === s.stageId)?.color })))}</section>
          <section class="glass card"><div class="card-head"><h2>By source</h2><span class="meta">won value</span></div>${barList(m.bySource.map((r) => ({ label: r.label, value: r.wonCents || r.deals, sub: `${r.deals} deals · ${pct(r.winRate)}` })), { format: (v) => (m.bySource.some((r) => r.wonCents) ? money(v, "USD", { compact: true }) : String(v)) })}</section>
          <section class="glass card"><div class="card-head"><h2>By campaign</h2></div>${barList(m.byCampaign.filter((r) => r.key !== "none").map((r) => ({ label: r.label, value: r.deals, sub: `${r.won} won` })), { empty: "Tag deals with a campaign (UTM, email or import) to compare them." })}
            ${m.lostReasons.length ? html`<div class="divider"></div><h3 style="margin-bottom:8px">Lost reasons</h3>${barList(m.lostReasons.map((r) => ({ label: r.reason, value: r.count })))}` : nothing}</section>
        </div>`
      : nothing}
    ${modalState?.kind === "needs" ? needsModal(h, modalState as never) : nothing}
    ${modalState?.kind === "deal" ? dealModal(h, pipeline, (modalState as { deal?: Deal }).deal ?? null) : nothing}
    ${modalState?.kind === "stages" ? stagesModal(h, p.data) : nothing}
  `;
}
