/**
 * Business hub › Campaigns — email sequences on the owner's own sender:
 * campaigns (audience → steps with delays → sender + throttle, stop on reply),
 * templates with {{variables}}, audiences (segments), the suppression list,
 * and senders + compliance settings. Starting a campaign always shows who it
 * will reach first.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { BusinessHubApp } from "../app";
import { date, LIFECYCLE_LABEL, num, pct, relTime } from "../format";
import { icons } from "../icons";
import type { Contact } from "../types";
import { emptyState, errorCard, formValues, modal } from "./ui";

type Step = { id?: string; position?: number; delayMinutes: number; templateId: string; templateName?: string | null };
type Campaign = { id: string; campaignId: string; utmCampaign: string | null; segmentId: string | null; name: string; status: string; fromName: string | null; fromEmail: string | null; replyTo: string | null; sender: { kind: string | null; senderId: string | null; accountId: string | null }; perMinute: number; perDay: number; stopOnReply: boolean; trackOpens: boolean; trackClicks: boolean; requireOptIn: boolean; startedAt: number | null; completedAt: number | null; createdAt: number; steps: Step[] };
type Metrics = { sent: number; failed: number; delivered: number; opens: number; uniqueOpens: number; clicks: number; uniqueClicks: number; replies: number; bounces: number; unsubscribes: number; complaints: number; openRate: number; clickRate: number; replyRate: number; bounceRate: number; unsubscribeRate: number };
type CampaignMetrics = { campaign: { id: string; name: string; status: string }; enrolled: number; enrollments: Record<string, number>; skipReasons: Record<string, number>; totals: Metrics; steps: Array<{ stepId: string; position: number; templateName: string | null } & Metrics> };
type Template = { id: string; name: string; subject: string; html: string; text: string; updatedAt: number };
type SegmentFilter = { lifecycle?: string | string[]; tag?: string; tagsAny?: string[]; excludeTags?: string[]; minScore?: number; optedIn?: boolean; hasEmail?: boolean; emailStatus?: string; search?: string };
type Segment = { id: string; name: string; filter: SegmentFilter; updatedAt: number };
type Sender = { id: string; kind: string; label: string; fromName?: string | null; fromEmail?: string | null; host?: string | null; accountId?: string | null; apiKey: string | null; pass: string | null; webhookUrl: string | null; region?: string | null };
type Settings = { publicBaseUrl: string | null; physicalAddress: string | null; companyName: string | null; globalPerMinute: number; globalPerDay: number; defaultSenderId: string | null };
type Preview = { count: number; withEmail: number; optedIn: number; sample: Array<{ id: string; name: string; email: string | null; lifecycle: string }> };

const SENDER_KIND: Record<string, string> = {
  "smtp-account": "Email account (SMTP)",
  "smtp-custom": "Custom SMTP",
  "ses-smtp": "Amazon SES",
  resend: "Resend",
  postmark: "Postmark",
  gmail: "Gmail",
};
const VARS = ["first_name", "last_name", "name", "company", "title", "city", "email", "sender_name"];
const close = (h: BusinessHubApp) => {
  h.ui.modal = null;
  h.refresh();
};

function delayLabel(min: number): string {
  if (!min) return "immediately";
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? "" : "s"} later`;
  if (min % 60 === 0) return `${min / 60}h later`;
  return `${min} min later`;
}

function filterLabel(f: SegmentFilter): string {
  const parts: string[] = [];
  const l = Array.isArray(f.lifecycle) ? f.lifecycle : f.lifecycle ? [f.lifecycle] : [];
  if (l.length) parts.push(l.map((x) => LIFECYCLE_LABEL[x] ?? x).join(" / "));
  if (f.tag) parts.push(`#${f.tag}`);
  if (f.tagsAny?.length) parts.push(`any of #${f.tagsAny.join(" #")}`);
  if (f.excludeTags?.length) parts.push(`not #${f.excludeTags.join(" #")}`);
  if (f.minScore) parts.push(`score ${f.minScore}+`);
  if (f.optedIn) parts.push("opted in");
  return parts.join(" · ") || "Everyone with an email";
}

// ── audience (segment) editor ────────────────────────────────────────────
function audienceFields(h: BusinessHubApp, f: SegmentFilter): TemplateResult {
  const lc = Array.isArray(f.lifecycle) ? f.lifecycle : f.lifecycle ? [f.lifecycle] : [];
  const key = JSON.stringify(f);
  const prev = h.load<Preview>(`camp:preview:${key}`, "hub.email.segments.preview", { filter: { ...f, hasEmail: true }, sample: 6 }, { maxAgeMs: 10_000 });
  return html`<div class="stack">
    <div class="chips">${Object.entries(LIFECYCLE_LABEL).map(([k, v]) => html`<button type="button" class="chip" aria-pressed=${lc.includes(k)} @click=${() => { f.lifecycle = lc.includes(k) ? lc.filter((x) => x !== k) : [...lc, k]; h.refresh(); }}>${v}</button>`)}</div>
    <div class="field-row">
      <label class="field">With tag<input class="input" .value=${f.tag ?? ""} placeholder="any" @change=${(e: Event) => { f.tag = (e.target as HTMLInputElement).value.trim() || undefined; h.refresh(); }} /></label>
      <label class="field">Exclude tags<input class="input" .value=${(f.excludeTags ?? []).join(", ")} placeholder="customer, do-not-email" @change=${(e: Event) => { f.excludeTags = (e.target as HTMLInputElement).value.split(",").map((t) => t.trim()).filter(Boolean); h.refresh(); }} /></label>
      <label class="field">Min score<input class="input" type="number" min="0" max="100" .value=${String(f.minScore ?? "")} @change=${(e: Event) => { f.minScore = Number((e.target as HTMLInputElement).value) || undefined; h.refresh(); }} /></label>
    </div>
    <label class="check"><input type="checkbox" .checked=${Boolean(f.optedIn)} @change=${(e: Event) => { f.optedIn = (e.target as HTMLInputElement).checked || undefined; h.refresh(); }} /> Only people who opted in to marketing</label>
    <div class="glass card" style="padding:12px">
      ${prev.data
        ? html`<div class="row" style="justify-content:space-between;flex-wrap:wrap"><b>${num(prev.data.withEmail)} people with an email</b><span class="faint small">${num(prev.data.optedIn)} opted in · ${num(prev.data.count)} match</span></div>
            <div class="chips" style="margin-top:8px">${prev.data.sample.map((s) => html`<span class="chip">${s.name}</span>`)}</div>`
        : html`<div class="sk" style="height:14px;width:50%"></div>`}
    </div>
  </div>`;
}

// ── campaign builder ─────────────────────────────────────────────────────
function builderModal(h: BusinessHubApp, draft: Partial<Campaign> & { segmentFilter?: SegmentFilter; steps: Step[] }, templates: Template[], segments: Segment[], senders: Sender[]): TemplateResult {
  const useSegment = draft.segmentId ?? "";
  draft.segmentFilter ??= { lifecycle: ["lead", "qualified"] };
  return modal(
    h,
    draft.id ? `Edit ${draft.name}` : "New campaign",
    html`<form class="stack" id="builder" @submit=${(e: Event) => e.preventDefault()}>
      <label class="field">Name<input class="input" name="name" required .value=${draft.name ?? ""} placeholder="October outreach — roofers" @input=${(e: Event) => (draft.name = (e.target as HTMLInputElement).value)} /></label>
      <h3>Audience</h3>
      <select class="input" @change=${(e: Event) => { draft.segmentId = (e.target as HTMLSelectElement).value || null; h.refresh(); }}>
        <option value="" ?selected=${!useSegment}>Build an audience here</option>
        ${segments.map((s) => html`<option value=${s.id} ?selected=${useSegment === s.id}>Saved: ${s.name} — ${filterLabel(s.filter)}</option>`)}
      </select>
      ${useSegment ? nothing : audienceFields(h, draft.segmentFilter)}
      <h3>Sequence</h3>
      ${templates.length
        ? html`<div class="stack">${draft.steps.map((s, i) => html`<div class="row" style="flex-wrap:wrap">
            <span class="chip gold">Step ${i + 1}</span>
            <select class="input" style="flex:1 1 180px" aria-label="Template" @change=${(e: Event) => (s.templateId = (e.target as HTMLSelectElement).value)}>${templates.map((t) => html`<option value=${t.id} ?selected=${t.id === s.templateId}>${t.name}</option>`)}</select>
            <select class="input" style="width:150px" aria-label="Delay" @change=${(e: Event) => (s.delayMinutes = Number((e.target as HTMLSelectElement).value))}>
              ${[0, 60, 1440, 2880, 4320, 7200, 10080].map((m) => html`<option value=${m} ?selected=${s.delayMinutes === m}>${i === 0 && m === 0 ? "Right away" : delayLabel(m)}</option>`)}
            </select>
            ${draft.steps.length > 1 ? html`<button type="button" class="btn sm ghost danger" aria-label="Remove step" @click=${() => { draft.steps.splice(i, 1); h.refresh(); }}>${icons.x()}</button>` : nothing}
          </div>`)}
          <button type="button" class="btn sm" @click=${() => { draft.steps.push({ templateId: templates[0].id, delayMinutes: 4320 }); h.refresh(); }}>${icons.plus()} Add follow-up</button></div>`
        : html`<div class="banner glass"><span class="warn">●</span> Create an email template first. <button type="button" class="btn sm" @click=${() => { h.ui.campTab = "templates"; h.ui.modal = { kind: "template", template: null }; h.refresh(); }}>New template</button></div>`}
      <h3>Sending</h3>
      ${senders.length
        ? html`<div class="field-row">
            <label class="field">Send with<select class="input" name="senderId">${senders.map((s) => html`<option value=${s.id} ?selected=${(draft.sender?.senderId ?? senders[0].id) === s.id}>${s.label} · ${SENDER_KIND[s.kind] ?? s.kind}</option>`)}</select></label>
            <label class="field">From name<input class="input" name="fromName" .value=${draft.fromName ?? ""} placeholder="Jane at Acme" /></label>
            <label class="field">Reply-to<input class="input" name="replyTo" type="email" .value=${draft.replyTo ?? ""} placeholder="(sender address)" /></label>
          </div>`
        : html`<div class="banner glass"><span class="warn">●</span> No sender yet. <button type="button" class="btn sm" @click=${() => { h.ui.campTab = "senders"; h.ui.modal = { kind: "sender" }; h.refresh(); }}>Connect a sender</button></div>`}
      <div class="field-row">
        <label class="field">Max per minute<input class="input" name="perMinute" type="number" min="1" max="600" .value=${String(draft.perMinute ?? 20)} /></label>
        <label class="field">Max per day<input class="input" name="perDay" type="number" min="1" max="50000" .value=${String(draft.perDay ?? 400)} /></label>
      </div>
      <div class="chips">
        <label class="check"><input type="checkbox" name="stopOnReply" .checked=${draft.stopOnReply ?? true} /> Stop when they reply</label>
        <label class="check"><input type="checkbox" name="trackOpens" .checked=${draft.trackOpens ?? true} /> Track opens</label>
        <label class="check"><input type="checkbox" name="trackClicks" .checked=${draft.trackClicks ?? true} /> Track clicks</label>
        <label class="check"><input type="checkbox" name="requireOptIn" .checked=${draft.requireOptIn ?? false} /> Only opted-in contacts</label>
      </div>
    </form>`,
    html`<button class="btn" @click=${() => close(h)}>Cancel</button>
      <button class="btn primary" ?disabled=${!templates.length || !senders.length} @click=${async (e: Event) => {
        const form = (e.target as HTMLElement).closest(".modal")!.querySelector("form") as HTMLFormElement;
        if (!form.reportValidity()) return;
        const v = formValues(form);
        const fd = new FormData(form);
        const r = await h.act<{ campaign: Campaign }>(
          "hub.email.campaigns.save",
          {
            id: draft.id,
            name: v.name,
            segmentId: draft.segmentId || null,
            segmentFilter: draft.segmentId ? undefined : { ...draft.segmentFilter, hasEmail: true },
            steps: draft.steps.map((s) => ({ templateId: s.templateId, delayMinutes: s.delayMinutes })),
            sender: { senderId: v.senderId },
            fromName: v.fromName || null,
            replyTo: v.replyTo || null,
            perMinute: Number(v.perMinute),
            perDay: Number(v.perDay),
            stopOnReply: fd.get("stopOnReply") === "on",
            trackOpens: fd.get("trackOpens") === "on",
            trackClicks: fd.get("trackClicks") === "on",
            requireOptIn: fd.get("requireOptIn") === "on",
          },
          "Campaign saved as a draft",
          "camp",
        );
        if (r) {
          h.ui.modal = null;
          h.ui.campOpen = r.campaign.id;
          h.refresh();
        }
      }}>Save draft</button>`,
    true,
  );
}

function startModal(h: BusinessHubApp, c: Campaign, settings: Settings | null): TemplateResult {
  const prev = h.load<Preview>(`camp:startprev:${c.id}`, "hub.email.segments.preview", c.segmentId ? { id: c.segmentId, sample: 5 } : { filter: { hasEmail: true }, sample: 5 }, { maxAgeMs: 5000 });
  const missing = [!settings?.publicBaseUrl ? "a public URL (for unsubscribe + tracking links)" : null, !settings?.physicalAddress ? "a postal address for the footer" : null].filter(Boolean);
  return modal(
    h,
    `Start "${c.name}"?`,
    html`<p class="muted" style="margin-top:0">This sends real emails from your sender. ${c.steps.length} step${c.steps.length === 1 ? "" : "s"}, at most ${c.perMinute}/min and ${c.perDay}/day${c.stopOnReply ? ", stopping for anyone who replies" : ""}. Suppressed, bounced${c.requireOptIn ? " and not-opted-in" : ""} contacts are skipped automatically.</p>
      ${prev.data && c.segmentId ? html`<div class="glass card" style="padding:12px"><b>${num(prev.data.withEmail)} recipients</b> <span class="faint small">e.g. ${prev.data.sample.map((s) => s.name).join(", ")}</span></div>` : nothing}
      ${missing.length ? html`<div class="banner glass" style="margin-top:12px"><span class="bad">●</span> Add ${missing.join(" and ")} in Senders & settings before starting.</div>` : nothing}
      <label class="field" style="margin-top:14px">Send a test to yourself first<div class="row"><input class="input" id="testTo" type="email" placeholder="you@yourdomain.com" /><button class="btn" @click=${async (e: Event) => {
        const to = ((e.target as HTMLElement).closest(".row")!.querySelector("input") as HTMLInputElement).value.trim();
        if (to) await h.act("hub.email.campaigns.testSend", { id: c.id, toEmail: to }, `Test sent to ${to}`);
      }}>Send test</button></div></label>`,
    html`<button class="btn" @click=${() => close(h)}>Not yet</button>
      <button class="btn primary" ?disabled=${missing.length > 0} @click=${async () => {
        const r = await h.act<{ enrolled: number; skipped: Record<string, number> }>("hub.email.campaigns.start", { id: c.id }, (x) => {
          const skipped = Object.values(x.skipped ?? {}).reduce((a, b) => a + b, 0);
          return `Started — ${x.enrolled} enrolled${skipped ? `, ${skipped} skipped (no email, suppressed or no consent)` : ""}`;
        }, ["camp", "overview"]);
        if (r) close(h);
      }}>${icons.play()} Start sending</button>`,
  );
}

// ── templates ────────────────────────────────────────────────────────────
function templateModal(h: BusinessHubApp, t: Template | null): TemplateResult {
  const draft = (h.ui.tplDraft as { name: string; subject: string; body: string } | null) ?? { name: t?.name ?? "", subject: t?.subject ?? "", body: t?.text || t?.html || "Hi {{first_name|there}},\n\n\n\nBest,\n{{sender_name}}" };
  h.ui.tplDraft = draft;
  const prev = h.load<{ subject: string; html: string; text: string; warnings: string[] }>(`camp:tplprev:${draft.subject}|${draft.body.length}|${draft.body.slice(-40)}`, "hub.email.templates.preview", { subject: draft.subject, text: draft.body }, { maxAgeMs: 60_000 });
  const insert = (v: string) => {
    const ta = h.renderRoot.querySelector<HTMLTextAreaElement>("#tplBody");
    const tag = `{{${v}}}`;
    if (ta) {
      const at = ta.selectionStart ?? ta.value.length;
      draft.body = ta.value.slice(0, at) + tag + ta.value.slice(ta.selectionEnd ?? at);
    } else draft.body += tag;
    h.refresh();
  };
  return modal(
    h,
    t ? `Edit ${t.name}` : "New template",
    html`<div class="grid cols-2e">
      <div class="stack">
        <label class="field">Name<input class="input" .value=${draft.name} placeholder="Intro — local business" @input=${(e: Event) => (draft.name = (e.target as HTMLInputElement).value)} /></label>
        <label class="field">Subject<input class="input" .value=${draft.subject} placeholder="Quick question about {{company|your business}}" @change=${(e: Event) => { draft.subject = (e.target as HTMLInputElement).value; h.refresh(); }} /></label>
        <label class="field">Message<textarea class="input" id="tplBody" style="min-height:240px" .value=${draft.body} @change=${(e: Event) => { draft.body = (e.target as HTMLTextAreaElement).value; h.refresh(); }}></textarea></label>
        <div class="chips">${VARS.map((v) => html`<button type="button" class="chip" @click=${() => insert(v)}>{{${v}}}</button>`)}</div>
        <div class="faint small">Use <span class="mono">{{first_name|there}}</span> for a fallback. An unsubscribe link and your postal address are added automatically.</div>
      </div>
      <div class="stack">
        <h3>Preview</h3>
        <div class="glass card" style="padding:14px;min-height:260px">
          ${prev.data
            ? html`<div class="faint small">Subject</div><b>${prev.data.subject}</b><div class="divider"></div><div style="white-space:pre-wrap;font-size:13px">${prev.data.text}</div>
                ${prev.data.warnings.length ? html`<div class="divider"></div>${prev.data.warnings.map((w) => html`<div class="warn small">● ${w}</div>`)}` : nothing}`
            : html`<div class="sk" style="height:180px"></div>`}
        </div>
      </div>
    </div>`,
    html`<button class="btn" @click=${() => { h.ui.tplDraft = null; close(h); }}>Cancel</button>
      <button class="btn primary" @click=${async () => {
        if (!draft.name.trim() || !draft.subject.trim()) return h.showToast("Give the template a name and a subject.", true);
        const r = await h.act("hub.email.templates.save", { id: t?.id, name: draft.name, subject: draft.subject, text: draft.body }, "Template saved", "camp");
        if (r) {
          h.ui.tplDraft = null;
          close(h);
        }
      }}>Save template</button>`,
    true,
  );
}

// ── senders + settings ───────────────────────────────────────────────────
function senderModal(h: BusinessHubApp): TemplateResult {
  const kind = (h.ui.senderKind as string) ?? "smtp-account";
  const accounts = h.load<{ accounts?: Array<{ id: string; email: string; kind: string; label?: string }> } | Array<{ id: string; email: string; kind: string }>>("camp:emailaccounts", "email.accounts.list", {}, { maxAgeMs: 60_000 });
  const acctList = Array.isArray(accounts.data) ? accounts.data : (accounts.data?.accounts ?? []);
  return modal(
    h,
    "Connect a sender",
    html`<div class="chips" style="margin-bottom:12px">${Object.entries(SENDER_KIND).map(([k, v]) => html`<button class="chip" aria-pressed=${kind === k} @click=${() => { h.ui.senderKind = k; h.refresh(); }}>${v}</button>`)}</div>
      <form class="stack" @submit=${(e: Event) => e.preventDefault()}>
        <div class="field-row"><label class="field">Label<input class="input" name="label" required placeholder="Sales mailbox" /></label><label class="field">From name<input class="input" name="fromName" placeholder="Jane at Acme" /></label><label class="field">From email<input class="input" name="fromEmail" type="email" placeholder="jane@acme.com" /></label></div>
        ${kind === "smtp-account"
          ? html`<label class="field">Email account<select class="input" name="accountId">${acctList.length ? acctList.map((a) => html`<option value=${a.id}>${a.email} (${a.kind})</option>`) : html`<option value="">No accounts — add one in Inbox › Email accounts</option>`}</select></label>`
          : nothing}
        ${kind === "smtp-custom" ? html`<div class="field-row"><label class="field">SMTP host<input class="input" name="host" required placeholder="smtp.yourhost.com" /></label><label class="field">Port<input class="input" name="port" type="number" value="587" /></label></div><div class="field-row"><label class="field">Username<input class="input" name="user" /></label><label class="field">Password<input class="input" name="pass" type="password" autocomplete="off" /></label></div>` : nothing}
        ${kind === "ses-smtp" ? html`<div class="field-row"><label class="field">AWS region<input class="input" name="region" required placeholder="us-east-1" /></label><label class="field">SMTP username<input class="input" name="user" required /></label><label class="field">SMTP password<input class="input" name="pass" type="password" required autocomplete="off" /></label></div>` : nothing}
        ${kind === "resend" ? html`<label class="field">Resend API key<input class="input" name="apiKey" type="password" required autocomplete="off" placeholder="re_…" /></label><label class="field">Webhook signing secret (optional)<input class="input" name="webhookSigningSecret" type="password" autocomplete="off" placeholder="whsec_…" /></label>` : nothing}
        ${kind === "postmark" ? html`<label class="field">Postmark server token<input class="input" name="apiKey" type="password" required autocomplete="off" /></label><label class="field">Message stream<input class="input" name="messageStream" value="broadcast" /></label>` : nothing}
        ${kind === "gmail" ? html`<div class="faint small">Uses the connected Gmail account. Gmail sends plain text without open tracking; for full tracking add the mailbox under Email accounts with an app password and pick "Email account (SMTP)".</div>` : nothing}
        <div class="faint small">Keys are encrypted on this machine and never shown again.</div>
      </form>`,
    html`<button class="btn" @click=${() => close(h)}>Cancel</button>
      <button class="btn primary" @click=${async (e: Event) => {
        const form = (e.target as HTMLElement).closest(".modal")!.querySelector("form") as HTMLFormElement;
        if (!form.reportValidity()) return;
        const v = formValues(form);
        const params: Record<string, unknown> = { kind, ...v };
        if (v.port) params.port = Number(v.port);
        const r = await h.act<{ sender: Sender }>("hub.email.senders.save", params, "Sender connected", "camp");
        if (r) {
          await h.act<{ verify: { ok: boolean; error?: string } }>("hub.email.senders.test", { id: r.sender.id }, (x) => (x.verify.ok ? "Connection works" : `Connection failed: ${x.verify.error ?? "unknown"}`));
          close(h);
        }
      }}>Connect</button>`,
    true,
  );
}

function settingsCard(h: BusinessHubApp, s: Settings | null): TemplateResult {
  return html`<section class="glass card">
    <div class="card-head"><h2>Compliance & limits</h2></div>
    <form class="stack" @submit=${async (e: Event) => {
      e.preventDefault();
      const v = formValues(e.target as HTMLFormElement);
      await h.act("hub.email.settings.save", { publicBaseUrl: v.publicBaseUrl || null, physicalAddress: v.physicalAddress || null, companyName: v.companyName || null, globalPerMinute: Number(v.globalPerMinute), globalPerDay: Number(v.globalPerDay) }, "Settings saved", "camp");
    }}>
      <label class="field">Public URL of this InfiniBot <span class="faint">(where unsubscribe + tracking links point)</span><input class="input" name="publicBaseUrl" .value=${s?.publicBaseUrl ?? ""} placeholder="https://bot.yourdomain.com" /></label>
      <div class="field-row"><label class="field">Company name<input class="input" name="companyName" .value=${s?.companyName ?? ""} /></label><label class="field">Postal address <span class="faint">(required by law in marketing email)</span><input class="input" name="physicalAddress" .value=${s?.physicalAddress ?? ""} /></label></div>
      <div class="field-row"><label class="field">Global max / minute<input class="input" name="globalPerMinute" type="number" .value=${String(s?.globalPerMinute ?? 60)} /></label><label class="field">Global max / day<input class="input" name="globalPerDay" type="number" .value=${String(s?.globalPerDay ?? 2000)} /></label></div>
      <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">Save</button></div>
    </form>
  </section>`;
}

/** One-off email to a contact (opened from a contact's detail sheet). */
function sendOneModal(h: BusinessHubApp, contact: Contact, templates: Template[], senders: Sender[]): TemplateResult {
  return modal(
    h,
    `Email ${contact.name}`,
    senders.length
      ? html`<form class="stack" @submit=${(e: Event) => e.preventDefault()}>
          <div class="faint small">To <span class="mono">${contact.email}</span></div>
          <div class="field-row"><label class="field">Send with<select class="input" name="senderId">${senders.map((s) => html`<option value=${s.id}>${s.label}</option>`)}</select></label>
            <label class="field">Start from template<select class="input" name="templateId"><option value="">— write it here —</option>${templates.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select></label></div>
          <label class="field">Subject<input class="input" name="subject" placeholder="(from template)" /></label>
          <label class="field">Message<textarea class="input" name="text" placeholder="Hi {{first_name|there}}, …"></textarea></label>
        </form>`
      : html`<div class="empty-mini">Connect a sender first (Senders & settings).</div>`,
    html`<button class="btn" @click=${() => close(h)}>Cancel</button>
      <button class="btn primary" ?disabled=${!senders.length} @click=${async (e: Event) => {
        const v = formValues((e.target as HTMLElement).closest(".modal")!.querySelector("form") as HTMLFormElement);
        if (!v.templateId && (!v.subject || !v.text)) return h.showToast("Pick a template or write a subject and message.", true);
        const r = await h.act<{ ok: boolean; error?: string }>("hub.email.sendOne", { contactId: contact.id, senderId: v.senderId, templateId: v.templateId || undefined, subject: v.subject || undefined, text: v.text || undefined }, (x) => (x.ok ? `Sent to ${contact.email}` : `Not sent: ${x.error ?? "unknown"}`), ["contact", "overview"]);
        if (r?.ok) close(h);
      }}>${icons.mail()} Send</button>`,
  );
}

function campaignCard(h: BusinessHubApp, c: Campaign, settings: Settings | null): TemplateResult {
  const open = h.ui.campOpen === c.id;
  // Metrics load for every non-draft card so the headline numbers show without a click.
  const m = open || c.status !== "draft" ? h.load<CampaignMetrics>(`camp:metrics:${c.id}`, "hub.email.campaigns.metrics", { id: c.id }, { maxAgeMs: 8000 }) : null;
  if (open && (c.status === "active" || c.status === "running")) h.pollers.set("camp", () => h.invalidate(`camp:metrics:${c.id}`));
  const statusCls = c.status === "active" || c.status === "running" ? "ok" : c.status === "paused" ? "warn" : c.status === "completed" ? "gold" : "";
  const t = m?.data?.totals;
  return html`<section class="glass card">
    <div class="card-head" style="flex-wrap:wrap">
      <div style="min-width:0;flex:1;cursor:pointer" @click=${() => { h.ui.campOpen = open ? null : c.id; h.refresh(); }}>
        <h2>${c.name}</h2>
        <div class="faint small">${c.steps.length} step${c.steps.length === 1 ? "" : "s"} · ${c.steps.map((s) => delayLabel(s.delayMinutes)).join(" → ")} · ${c.startedAt ? `started ${relTime(c.startedAt)}` : `created ${date(c.createdAt)}`}${c.utmCampaign ? html` · <span class="mono">utm_campaign=${c.utmCampaign}</span>` : nothing}</div>
      </div>
      <div class="row">
        <span class="chip ${statusCls}">${c.status}</span>
        ${c.status === "draft" ? html`<button class="btn sm" @click=${() => { h.ui.modal = { kind: "builder", draft: { ...c, steps: c.steps.map((s) => ({ ...s })) } }; h.refresh(); }}>Edit</button><button class="btn sm primary" @click=${() => { h.ui.modal = { kind: "start", campaign: c }; h.refresh(); }}>${icons.play()} Start</button>` : nothing}
        ${c.status === "active" || c.status === "running" ? html`<button class="btn sm" @click=${() => h.act("hub.email.campaigns.pause", { id: c.id }, "Paused", "camp")}>${icons.pause()} Pause</button>` : nothing}
        ${c.status === "paused" ? html`<button class="btn sm primary" @click=${() => h.act("hub.email.campaigns.resume", { id: c.id }, "Resumed", "camp")}>${icons.play()} Resume</button><button class="btn sm" @click=${() => { if (confirm("Stop this campaign for good?")) void h.act("hub.email.campaigns.stop", { id: c.id }, "Stopped", "camp"); }}>Stop</button>` : nothing}
      </div>
    </div>
    ${!open && t
      ? html`<div class="chips" style="margin-top:4px"><span class="chip">${num(t.sent)} sent</span><span class="chip">${pct(t.openRate)} opened</span><span class="chip">${pct(t.clickRate)} clicked</span><span class="chip ${t.replies ? "ok" : ""}">${num(t.replies)} replies</span>${t.unsubscribes ? html`<span class="chip">${num(t.unsubscribes)} unsubscribed</span>` : nothing}<button class="chip" @click=${() => { h.ui.campOpen = c.id; h.refresh(); }}>Details ↓</button></div>`
      : nothing}
    ${open
      ? m?.data && t
        ? html`<div class="kpis k6" style="margin-bottom:8px">
            ${[["Enrolled", num(m.data.enrolled), Object.entries(m.data.skipReasons).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(" · ") || "skipped none"], ["Sent", num(t.sent), `${num(t.delivered)} delivered · ${num(t.failed)} failed`], ["Opened", pct(t.openRate), `${num(t.uniqueOpens)} people`], ["Clicked", pct(t.clickRate), `${num(t.uniqueClicks)} people`], ["Replied", pct(t.replyRate), `${num(t.replies)} replies`], ["Bounced", pct(t.bounceRate, 1), `${num(t.unsubscribes)} unsubscribed · ${num(t.complaints)} complaints`]].map(
              ([l, v, f]) => html`<div class="glass kpi" style="min-height:0"><div class="label">${l}</div><div class="value" style="font-size:22px">${v}</div><div class="foot">${f}</div></div>`,
            )}
          </div>
          ${m.data.steps.length > 1 ? html`<div class="list">${m.data.steps.map((s) => html`<div class="li"><span class="chip gold">Step ${s.position + 1}</span><div class="grow"><b>${s.templateName ?? "Template"}</b><span>${num(s.sent)} sent · ${pct(s.openRate)} opened · ${pct(s.clickRate)} clicked · ${num(s.replies)} replies</span></div></div>`)}</div>` : nothing}`
        : html`<div class="sk" style="height:90px"></div>`
      : nothing}
    ${settings && !settings.publicBaseUrl && c.status === "draft" ? html`<div class="faint small" style="margin-top:8px">Set your public URL in Senders & settings before starting.</div>` : nothing}
  </section>`;
}

export function renderCampaigns(h: BusinessHubApp): TemplateResult {
  const tab = (h.ui.campTab as string) ?? "campaigns";
  const camps = h.load<{ campaigns: Campaign[] }>("camp:list", "hub.email.campaigns.list", {});
  const tpls = h.load<{ templates: Template[] }>("camp:tpl", "hub.email.templates.list", {}, { maxAgeMs: 60_000 });
  const segs = h.load<{ segments: Segment[] }>("camp:seg", "hub.email.segments.list", {}, { maxAgeMs: 60_000 });
  const snd = h.load<{ senders: Sender[] }>("camp:snd", "hub.email.senders.list", {}, { maxAgeMs: 60_000 });
  const set = h.load<{ settings: Settings }>("camp:settings", "hub.email.settings.get", {}, { maxAgeMs: 60_000 });
  const templates = tpls.data?.templates ?? [];
  const segments = segs.data?.segments ?? [];
  const senders = snd.data?.senders ?? [];
  const settings = set.data?.settings ?? null;
  const campaigns = camps.data?.campaigns ?? [];
  const md = h.ui.modal as { kind?: string; draft?: Partial<Campaign> & { steps: Step[] }; campaign?: Campaign; template?: Template | null; contact?: Contact } | null;
  const newCampaign = () => {
    h.ui.modal = { kind: "builder", draft: { steps: templates.length ? [{ templateId: templates[0].id, delayMinutes: 0 }] : [], segmentFilter: { lifecycle: ["lead", "qualified"] } } };
    h.refresh();
  };
  if (h.ui.campaignPreselect && templates.length && senders.length && !md) {
    // Coming from Contacts › "Email them": pre-tag nothing, just open the builder.
    h.ui.campaignPreselect = null;
    newCampaign();
  }
  const setupGaps = [!senders.length ? "connect a sender" : null, !settings?.publicBaseUrl ? "set your public URL" : null, !settings?.physicalAddress ? "add your postal address" : null].filter(Boolean);

  const tabsBar = html`<div class="toolbar">
    <div class="chips">${[["campaigns", `Campaigns ${campaigns.length || ""}`], ["templates", `Templates ${templates.length || ""}`], ["audiences", `Audiences ${segments.length || ""}`], ["suppression", "Suppression"], ["senders", "Senders & settings"]].map(([id, l]) => html`<button class="chip" aria-pressed=${tab === id} @click=${() => { h.ui.campTab = id; h.refresh(); }}>${l}</button>`)}</div>
    <span class="spacer"></span>
    ${tab === "campaigns" ? html`<button class="btn primary" @click=${newCampaign}>${icons.plus()} New campaign</button>` : nothing}
    ${tab === "templates" ? html`<button class="btn primary" @click=${() => { h.ui.tplDraft = null; h.ui.modal = { kind: "template", template: null }; h.refresh(); }}>${icons.plus()} New template</button>` : nothing}
    ${tab === "audiences" ? html`<button class="btn primary" @click=${() => { h.ui.modal = { kind: "segment" }; h.ui.segDraft = { name: "", filter: { lifecycle: ["lead"] } }; h.refresh(); }}>${icons.plus()} New audience</button>` : nothing}
    ${tab === "senders" ? html`<button class="btn primary" @click=${() => { h.ui.modal = { kind: "sender" }; h.refresh(); }}>${icons.plus()} Connect sender</button>` : nothing}
  </div>`;

  let body: TemplateResult;
  if (tab === "templates") {
    body = templates.length
      ? html`<div class="grid cols-3">${templates.map((t) => html`<section class="glass card" style="cursor:pointer" @click=${() => { h.ui.tplDraft = null; h.ui.modal = { kind: "template", template: t }; h.refresh(); }}>
          <h2>${t.name}</h2><div class="faint small" style="margin:4px 0 10px">${t.subject}</div>
          <div class="muted small" style="white-space:pre-wrap;max-height:90px;overflow:hidden">${(t.text || t.html.replace(/<[^>]+>/g, " ")).slice(0, 220)}</div>
          <div class="faint small" style="margin-top:10px">edited ${relTime(t.updatedAt)}</div></section>`)}</div>`
      : emptyState({ icon: "mail", title: "Write your first email", text: "Templates use variables like {{first_name|there}} so every message feels personal. An unsubscribe link is added for you.", actions: [{ label: "New template", primary: true, run: () => { h.ui.modal = { kind: "template", template: null }; h.refresh(); } }] });
  } else if (tab === "audiences") {
    body = segments.length
      ? html`<div class="list glass card">${segments.map((s) => html`<div class="li"><div class="grow"><b>${s.name}</b><span>${filterLabel(s.filter)}</span></div>
          <button class="btn sm ghost danger" @click=${() => { if (confirm(`Delete audience "${s.name}"?`)) void h.act("hub.email.segments.delete", { id: s.id }, "Deleted", "camp"); }}>Delete</button></div>`)}</div>`
      : emptyState({ icon: "contacts", title: "Save an audience", text: "Audiences are live filters over your contacts (lifecycle, tags, score, consent) — reuse them across campaigns.", inline: false });
  } else if (tab === "suppression") {
    const sup = h.load<{ items: Array<{ email: string; reason: string; source: string | null; createdAt: number }>; total: number }>("camp:sup", "hub.email.suppressions.list", { limit: 200 });
    body = html`<section class="glass card">
      <div class="card-head"><h2>Never email</h2><span class="meta">${num(sup.data?.total ?? 0)} addresses — unsubscribes, bounces and complaints land here automatically</span></div>
      <form class="row" style="margin-bottom:12px;flex-wrap:wrap" @submit=${async (e: Event) => { e.preventDefault(); const i = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement; const emails = i.value.split(/[\s,;]+/).filter(Boolean); if (emails.length && (await h.act("hub.email.suppressions.add", { emails, reason: "manual" }, `${emails.length} suppressed`, "camp:sup"))) i.value = ""; }}>
        <input class="input" style="flex:1 1 240px" placeholder="Add emails (comma separated)" /><button class="btn" type="submit">Add</button>
        <label class="btn">${icons.imports()} Import CSV<input type="file" hidden accept=".csv,.txt" @change=${async (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) await h.act<{ added: number }>("hub.email.suppressions.import", { csv: await f.text(), fileName: f.name }, (r) => `${r.added ?? 0} addresses suppressed`, "camp:sup"); }} /></label>
      </form>
      ${sup.data?.items.length
        ? html`<div class="list">${sup.data.items.map((s) => html`<div class="li"><span class="chip ${s.reason === "complaint" || s.reason === "bounce" ? "bad" : ""}">${s.reason}</span><div class="grow"><b class="mono">${s.email}</b><span>${s.source ?? ""} · ${relTime(s.createdAt)}</span></div><button class="btn sm ghost" @click=${() => h.act("hub.email.suppressions.remove", { email: s.email }, "Removed", "camp:sup")}>Remove</button></div>`)}</div>`
        : html`<div class="empty-mini">Nobody is suppressed yet.</div>`}
    </section>`;
  } else if (tab === "senders") {
    body = html`<div class="grid cols-2">
      <section class="glass card">
        <div class="card-head"><h2>Senders</h2></div>
        ${senders.length
          ? html`<div class="list">${senders.map((s) => html`<div class="li">${icons.mail()}<div class="grow"><b>${s.label}</b><span>${SENDER_KIND[s.kind] ?? s.kind}${s.fromEmail ? ` · ${s.fromEmail}` : ""}${s.apiKey ? ` · key ${s.apiKey}` : ""}</span>${s.webhookUrl ? html`<span class="mono" title="Point your provider's bounce/complaint webhook here">${s.webhookUrl}</span>` : nothing}</div>
              <button class="btn sm" @click=${() => h.act<{ verify: { ok: boolean; error?: string } }>("hub.email.senders.test", { id: s.id }, (x) => (x.verify.ok ? "Connection works" : `Failed: ${x.verify.error ?? "unknown"}`))}>Test</button>
              <button class="btn sm ghost danger" @click=${() => { if (confirm(`Remove sender "${s.label}"?`)) void h.act("hub.email.senders.remove", { id: s.id }, "Removed", "camp"); }}>Remove</button></div>`)}</div>`
          : html`<div class="empty-mini">Send through your own mailbox (SMTP / Gmail) or a delivery service (Resend, Postmark, Amazon SES). Nothing is sent through InfiniBot servers.</div>`}
      </section>
      ${settingsCard(h, settings)}
    </div>`;
  } else {
    body = camps.error
      ? errorCard(h, camps.error, "camp")
      : campaigns.length
        ? html`<div class="stack">${campaigns.map((c) => campaignCard(h, c, settings))}</div>`
        : emptyState({
            icon: "campaigns",
            title: "Your first campaign is three steps away",
            text: "Pick who to email, write a short sequence with follow-ups, and send through your own mailbox. Replies stop the sequence and move the deal to Engaged.",
            actions: [
              { label: templates.length ? "New campaign" : "Write a template", primary: true, run: () => (templates.length ? newCampaign() : ((h.ui.campTab = "templates"), (h.ui.modal = { kind: "template", template: null }), h.refresh())) },
              ...(senders.length ? [] : [{ label: "Connect a sender", run: () => { h.ui.campTab = "senders"; h.ui.modal = { kind: "sender" }; h.refresh(); } }]),
            ],
          });
  }

  return html`
    ${setupGaps.length && tab !== "senders"
      ? html`<div class="glass banner"><span class="warn">●</span><span style="flex:1">Before sending: ${setupGaps.join(", ")}.</span><button class="btn sm" @click=${() => { h.ui.campTab = "senders"; h.refresh(); }}>Open settings</button></div>`
      : nothing}
    ${tabsBar}
    ${body}
    ${md?.kind === "builder" && md.draft ? builderModal(h, md.draft, templates, segments, senders) : nothing}
    ${md?.kind === "start" && md.campaign ? startModal(h, md.campaign, settings) : nothing}
    ${md?.kind === "template" ? templateModal(h, md.template ?? null) : nothing}
    ${md?.kind === "sender" ? senderModal(h) : nothing}
    ${md?.kind === "sendOne" && md.contact ? sendOneModal(h, md.contact, templates, senders) : nothing}
    ${md?.kind === "segment"
      ? (() => {
          const d = h.ui.segDraft as { name: string; filter: SegmentFilter };
          return modal(
            h,
            "New audience",
            html`<label class="field" style="margin-bottom:12px">Name<input class="input" .value=${d.name} placeholder="Warm leads in Texas" @input=${(e: Event) => (d.name = (e.target as HTMLInputElement).value)} /></label>${audienceFields(h, d.filter)}`,
            html`<button class="btn" @click=${() => close(h)}>Cancel</button><button class="btn primary" @click=${async () => { if (!d.name.trim()) return h.showToast("Name the audience.", true); if (await h.act("hub.email.segments.save", { name: d.name, filter: { ...d.filter, hasEmail: true } }, "Audience saved", "camp")) close(h); }}>Save audience</button>`,
            true,
          );
        })()
      : nothing}
  `;
}
