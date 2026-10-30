/**
 * Business hub › Imports — drop a CSV / XLSX / vCard / Google Contacts export,
 * check the auto-detected column mapping and the validation report, pick the
 * dedupe rule, import, and undo any batch later.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { BusinessHubApp } from "../app";
import { date, num, relTime } from "../format";
import { icons } from "../icons";
import type { ImportBatch } from "../types";
import { emptyState } from "./ui";

type Preview = { batch: ImportBatch; headers: string[]; sample: string[][]; fields: string[] };

const FIELD_LABELS: Record<string, string> = {
  name: "Full name", firstName: "First name", lastName: "Last name", email: "Email", email2: "Email (2nd)", phone: "Phone", phone2: "Phone (2nd)",
  title: "Job title", company: "Company", website: "Website", industry: "Industry", address: "Street address", city: "City", region: "State / region",
  postalCode: "Postal code", country: "Country", tags: "Tags", notes: "Notes", lifecycle: "Lifecycle", score: "Score", linkedin: "LinkedIn",
  instagram: "Instagram", facebook: "Facebook", twitter: "X / Twitter", dealValue: "Deal value", dealStage: "Deal stage", source: "Source",
  optIn: "Email consent", createdAt: "Created date",
};

async function readFile(h: BusinessHubApp, file: File) {
  if (file.size > 25 * 1024 * 1024) {
    h.showToast("That file is over 25 MB — split it and import the parts.", true);
    return;
  }
  h.ui.importBusy = true;
  h.refresh();
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const res = await h.act<Preview>("hub.imports.preview", { fileName: file.name, contentBase64: btoa(bin), options: { strategy: "fill", createDeals: false } });
  h.ui.importBusy = false;
  if (res) {
    h.ui.importPreview = res;
    h.ui.importMapping = { ...res.batch.mapping };
    h.ui.importOptions = { strategy: "fill", createDeals: false, tags: [], sourceName: "" };
  }
  h.refresh();
}

function dropzone(h: BusinessHubApp): TemplateResult {
  const busy = Boolean(h.ui.importBusy);
  return html`<label class="glass card empty" style="cursor:pointer;border:0"
      @dragover=${(e: DragEvent) => { e.preventDefault(); (e.currentTarget as HTMLElement).style.boxShadow = "var(--bh-shadow-lift)"; }}
      @dragleave=${(e: DragEvent) => ((e.currentTarget as HTMLElement).style.boxShadow = "")}
      @drop=${(e: DragEvent) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) void readFile(h, f); }}>
    <div class="glyph">${icons.imports()}</div>
    <h2>${busy ? "Reading your file…" : "Drop a customer list"}</h2>
    <p>CSV, Excel (.xlsx), vCard (.vcf) or a Google Contacts / Outlook export. Columns are matched automatically, duplicates are merged, and every import can be undone.</p>
    ${busy ? html`<div class="progress indet" style="width:220px"><i></i></div>` : html`<span class="btn primary">${icons.file()} Choose file</span>`}
    <input type="file" hidden accept=".csv,.tsv,.txt,.xlsx,.vcf,.vcard,text/csv" @change=${(e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void readFile(h, f); }} />
  </label>`;
}

function previewView(h: BusinessHubApp, p: Preview): TemplateResult {
  const mapping = h.ui.importMapping as Record<string, string>;
  const opts = h.ui.importOptions as { strategy: string; createDeals: boolean; tags: string[]; sourceName: string };
  const r = p.batch.report;
  const used = new Set(Object.values(mapping));
  const revalidate = async () => {
    const res = await h.act<{ batch: ImportBatch }>("hub.imports.revalidate", { id: p.batch.id, mapping, options: opts });
    if (res) {
      p.batch = res.batch;
      h.refresh();
    }
  };
  return html`
    <div class="kpis k4">
      <div class="glass kpi"><div class="label">Rows</div><div class="value">${num(r?.total)}</div><div class="foot">${p.batch.fileName}</div></div>
      <div class="glass kpi"><div class="label">New contacts</div><div class="value ok">${num(r?.willCreate)}</div><div class="foot">will be created</div></div>
      <div class="glass kpi"><div class="label">Matches</div><div class="value">${num(r?.willUpdate)}</div><div class="foot">existing contacts — ${opts.strategy === "skip" ? "skipped" : opts.strategy === "overwrite" ? "overwritten" : "empty fields filled"}</div></div>
      <div class="glass kpi"><div class="label">Needs attention</div><div class="value ${r?.errors ? "bad" : r?.warnings ? "warn" : ""}">${num((r?.errors ?? 0) + (r?.warnings ?? 0))}</div><div class="foot">${num(r?.errors)} skipped · ${num(r?.duplicatesInFile)} duplicate rows merged</div></div>
    </div>
    <div class="grid cols-2">
      <section class="glass card">
        <div class="card-head"><h2>Column mapping</h2><span class="meta">auto-detected — adjust anything</span></div>
        <div class="stack">
          ${p.headers.map((hd, i) => html`<div class="maprow">
            <div style="min-width:0"><b class="small">${hd}</b><div class="faint small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.sample.slice(0, 3).map((row) => row[i]).filter(Boolean).join(" · ") || "empty"}</div></div>
            <select class="input" aria-label=${`Map ${hd}`} @change=${(e: Event) => { mapping[hd] = (e.target as HTMLSelectElement).value; void revalidate(); }}>
              <option value="ignore" ?selected=${mapping[hd] === "ignore"}>Don't import</option>
              ${p.fields.map((f) => html`<option value=${f} ?selected=${mapping[hd] === f} ?disabled=${used.has(f) && mapping[hd] !== f}>${FIELD_LABELS[f] ?? f}</option>`)}
              <option value=${`custom:${hd.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`} ?selected=${mapping[hd]?.startsWith("custom:")}>Keep as custom field</option>
            </select>
          </div>`)}
        </div>
      </section>
      <div class="grid" style="align-content:start">
        <section class="glass card stack">
          <h2>Rules</h2>
          <label class="field">When a contact already exists
            <select class="input" @change=${(e: Event) => { opts.strategy = (e.target as HTMLSelectElement).value; void revalidate(); }}>
              <option value="fill" ?selected=${opts.strategy === "fill"}>Merge — only fill empty fields (safest)</option>
              <option value="overwrite" ?selected=${opts.strategy === "overwrite"}>Merge — file wins</option>
              <option value="skip" ?selected=${opts.strategy === "skip"}>Skip them</option>
            </select>
          </label>
          <label class="field">Tag everyone in this import<input class="input" placeholder="e.g. expo-2026, newsletter" .value=${opts.tags.join(", ")} @change=${(e: Event) => (opts.tags = (e.target as HTMLInputElement).value.split(",").map((t) => t.trim()).filter(Boolean))} /></label>
          <label class="field">Source name<input class="input" placeholder=${p.batch.fileName} .value=${opts.sourceName} @change=${(e: Event) => (opts.sourceName = (e.target as HTMLInputElement).value)} /></label>
          <label class="check"><input type="checkbox" .checked=${opts.createDeals} @change=${(e: Event) => (opts.createDeals = (e.target as HTMLInputElement).checked)} /> Open a deal in the pipeline for each new lead</label>
        </section>
        ${r?.issues.length
          ? html`<section class="glass card"><div class="card-head"><h2>Validation</h2><span class="meta">first ${Math.min(r.issues.length, 200)}</span></div>
              <div class="list" style="max-height:260px;overflow:auto">${r.issues.map((i) => html`<div class="li"><span class="chip">row ${i.row}</span><div class="grow"><span style="white-space:normal;color:var(--bh-text-2)">${i.message}</span></div></div>`)}</div></section>`
          : html`<section class="glass card"><div class="row"><span class="ok">${icons.check()}</span><span>Every row looks good.</span></div></section>`}
      </div>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:16px;flex-wrap:wrap">
      <button class="btn" @click=${() => { h.ui.importPreview = null; h.refresh(); }}>Cancel</button>
      <button class="btn primary" ?disabled=${!r?.valid} @click=${async () => {
        const res = await h.act<{ batch: ImportBatch }>("hub.imports.commit", { id: p.batch.id, mapping, options: opts }, (x) => `Imported: ${x.batch.created} new, ${x.batch.updated} updated`, ["imports", "contacts", "overview", "deals"]);
        if (res) {
          h.ui.importPreview = null;
          h.showToast(`Imported ${res.batch.created + res.batch.updated} contacts`, false, { label: "Undo", run: () => void h.act("hub.imports.undo", { id: res.batch.id }, "Import undone", ["imports", "contacts", "overview", "deals"]) });
        }
      }}>Import ${num((r?.willCreate ?? 0) + (opts.strategy === "skip" ? 0 : (r?.willUpdate ?? 0)))} contacts</button>
    </div>`;
}

export function renderImports(h: BusinessHubApp): TemplateResult {
  const preview = h.ui.importPreview as Preview | null;
  if (preview) return previewView(h, preview);
  const hist = h.load<{ imports: ImportBatch[] }>("imports:list", "hub.imports.list", {});
  const list = (hist.data?.imports ?? []).filter((b) => b.status !== "previewed");
  return html`
    ${dropzone(h)}
    <section class="glass card" style="margin-top:16px">
      <div class="card-head"><h2>Import history</h2><span class="meta">undo restores what each import changed</span></div>
      ${list.length
        ? html`<div class="list">${list.map(
            (b) => html`<div class="li">
              ${icons.file()}
              <div class="grow"><b>${b.fileName}</b><span>${b.format.toUpperCase()} · ${date(b.committedAt ?? b.createdAt, true)} · ${b.created} new · ${b.updated} updated${b.skipped ? ` · ${b.skipped} skipped` : ""}${b.failed ? ` · ${b.failed} invalid` : ""}${b.tags.length ? ` · tagged ${b.tags.join(", ")}` : ""}</span></div>
              ${b.status === "committed"
                ? html`<button class="btn sm" @click=${() => { if (confirm(`Undo "${b.fileName}"? Contacts it created are deleted and updated ones restored.`)) void h.act<{ undo: { deleted: number; restored: number } }>("hub.imports.undo", { id: b.id }, (x) => `Undone: ${x.undo.deleted} removed, ${x.undo.restored} restored`, ["imports", "contacts", "overview", "deals"]); }}>${icons.undo()} Undo</button>`
                : html`<span class="chip">${b.status}${b.undoneAt ? ` ${relTime(b.undoneAt)}` : ""}</span>`}
            </div>`,
          )}</div>`
        : emptyState({ icon: "file", title: "No imports yet", text: "Your first import shows up here with its counts and an undo button.", inline: true })}
    </section>
    ${nothing}
  `;
}
