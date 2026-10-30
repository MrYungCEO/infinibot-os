/** Autopilot inbox — classified replies with approval-first response drafts. */

import { html, nothing, type TemplateResult } from "lit";
import type { BusinessHubApp } from "../app";
import { icons } from "../icons";
import { emptyState, skeletonRows } from "./ui";

type Reply = {
  id: string; contact_id: string; contact_name: string; email: string; offer_name: string; campaign_name: string;
  subject: string | null; body: string; classification: string; confidence: number; draft_response: string | null;
  status: string; received_at: number;
};

const tone = (kind: string) => kind === "interested" ? "ok" : kind === "unsubscribe" ? "bad" : kind === "objection" ? "warn" : kind === "ooo" ? "" : "gold";

export function renderAutopilotInbox(h: BusinessHubApp): TemplateResult {
  const state = h.load<{ replies: Reply[] }>("autopilot.inbox", "hub.autopilot.inbox.list", {}, { maxAgeMs: 8_000 });
  if (state.loading) return skeletonRows(7);
  if (state.error) return emptyState({ icon: "inbox", title: "Inbox unavailable", text: state.error });
  const replies = state.data?.replies ?? [];
  const selectedId = String(h.ui.apReplySelected ?? replies[0]?.id ?? "");
  const selected = replies.find((r) => r.id === selectedId);
  if (!replies.length) return emptyState({ icon: "inbox", title: "No replies yet", text: "Replies from active Autopilot conversations will be classified and drafted here.", actions: [{ label: "Open Autopilot", primary: true, run: () => h.go("autopilot") }] });
  return html`<div class="section-head"><div><div class="eyebrow">Autopilot inbox</div><h2>Replies that need a human eye</h2></div><span class="chip gold">Default · approval required</span></div><div class="inbox-layout"><section class="glass card inbox-list">${replies.map((r) => html`<button class="reply-row ${selected?.id === r.id ? "active" : ""}" @click=${() => { h.ui.apReplySelected = r.id; h.refresh(); }}><span class="reply-avatar">${r.contact_name?.slice(0,1).toUpperCase() || "?"}</span><span class="grow"><b>${r.contact_name || r.email}</b><small>${r.campaign_name} · ${new Date(r.received_at).toLocaleDateString()}</small></span><span class="chip ${tone(r.classification)}">${r.classification.replace("_", " ")}</span></button>`)}</section><section class="glass card reply-detail">${selected ? html`<div class="section-head"><div><div class="eyebrow">${selected.offer_name}</div><h3>${selected.subject || `Reply from ${selected.contact_name}`}</h3></div><span class="chip ${tone(selected.classification)}">${Math.round(selected.confidence * 100)}% ${selected.classification.replace("_", " ")}</span></div><div class="reply-copy"><div class="reply-original"><small>Inbound reply</small><p>${selected.body}</p></div><label><span>AI-drafted answer · offer playbook applied</span><textarea class="input area reply-draft" id="reply-draft">${selected.draft_response ?? ""}</textarea></label></div><div class="modal-actions"><button class="btn" @click=${() => h.act("hub.autopilot.inbox.update", { id: selected.id, status: "dismissed" }, "Dismissed", "autopilot.inbox")}>Dismiss</button><button class="btn" @click=${async () => { const area = h.renderRoot.querySelector<HTMLTextAreaElement>("#reply-draft"); await h.act("hub.autopilot.inbox.update", { id: selected.id, status: "approved", draftResponse: area?.value }, "Approved as draft", "autopilot.inbox"); }}>${icons.check()} Approve draft</button><button class="btn primary" title="Sending remains a separately confirmed email action" disabled>${icons.mail()} Send after confirmation</button></div>` : nothing}</section></div>`;
}
