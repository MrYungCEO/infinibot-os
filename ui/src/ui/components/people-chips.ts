/**
 * <ib-people-chips> — the people from My Network linked to one workspace
 * object (project, task, note, document, file, idea, opportunity…), as a
 * compact chip row with a "Link person" picker.
 *
 *   <ib-people-chips .client=${client} objectType="project" objectId=${id}></ib-people-chips>
 *
 * Data: `network.links.list {objectType, objectId}` (people + warm score
 * context), link via `network.links.add {kind:"contact"}`, unlink direct links
 * via `network.links.remove {relationId}`. People reached through a linked
 * connection show with a "via" hint and are unlinked from the network side.
 *
 * Self-contained (own shadow styles on glass tokens) so it drops into any page
 * with one line. The picker is mounted on document.body so `overflow: hidden`
 * cards can't clip it. If the gateway predates the RPCs (or the Business &
 * Agency plugin is off) the row renders nothing.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { TYPE_COLORS } from "../controllers/people-network";

export interface PeopleChipsClient {
  request(method: string, params?: unknown): Promise<unknown>;
}

interface LinkedPerson {
  contactId: string;
  name: string;
  org: string;
  role: string;
  contactType: string;
  via: "contact" | "connection";
  relationId: string;
  linkRole: string;
  relationshipValue: number;
  pipelineValue: number;
  openOpportunities: number;
}

interface ContactHit {
  id: string;
  name: string;
  org: string;
  role: string;
  contactType: string;
  client?: { name: string } | null;
}

const TONE = TYPE_COLORS;

function money(n: number): string {
  if (!n) return "";
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;
}

function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? (p[p.length - 1]?.[0] ?? "") : "")).toUpperCase() || "?";
}

/** Bumped on every link/unlink so sibling rows for the same object refresh. */
const CHANGED = "ib-people-links-changed";

@customElement("ib-people-chips")
export class PeopleChips extends LitElement {
  @property({ attribute: false }) client: PeopleChipsClient | null = null;
  @property({ type: String }) objectType = "";
  @property({ type: String }) objectId = "";
  /** Optional heading text (default "People"). */
  @property({ type: String }) label = "People";

  @state() private people: LinkedPerson[] | null = null;
  @state() private unavailable = false;
  @state() private busy = false;
  @state() private err = "";

  private loadedKey = "";
  private picker: HTMLElement | null = null;
  private onChanged = (e: Event) => {
    const d = (e as CustomEvent<{ key: string }>).detail;
    if (d?.key === this.key && e.target !== this) void this.load(true);
  };

  static styles = css`
    :host { display: block; font: 500 12px/1.3 var(--font-ui, var(--wgk-ui, system-ui, sans-serif)); color: var(--glass-fg-2, #c9c2b3); }
    :host([hidden]) { display: none; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 28px; }
    .lbl { display: inline-flex; align-items: center; gap: 5px; margin-right: 2px; font: 650 10px/1 var(--font-ui, system-ui); letter-spacing: 0.12em; text-transform: uppercase; color: var(--glass-fg-3, #8f897c); }
    .lbl svg { color: var(--glass-gold, #d9b45f); }
    .chip { display: inline-flex; align-items: center; gap: 6px; max-width: 260px; padding: 2px 4px 2px 2px; border-radius: 999px; border: 1px solid var(--glass-stroke, rgba(255,255,255,0.1)); background: var(--glass-1, rgba(255,255,255,0.04)); color: var(--glass-fg, #f4f1ea); }
    .chip:hover { border-color: var(--glass-stroke-gold, rgba(217,180,95,0.4)); }
    .chip button.open { display: inline-flex; align-items: center; gap: 6px; min-width: 0; border: 0; background: none; padding: 0; color: inherit; font: inherit; cursor: pointer; }
    .av { flex: 0 0 22px; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--tone); color: rgba(12,10,6,0.86); font: 750 9.5px/1 var(--font-ui, system-ui); }
    .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 620; }
    .meta { color: var(--glass-gold-hi, #f1d38a); font-variant-numeric: tabular-nums; font-size: 11px; }
    .via { color: var(--glass-fg-3, #8f897c); font-size: 10.5px; }
    .x { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; border: 0; background: none; color: var(--glass-fg-3, #8f897c); cursor: pointer; font: 600 12px/1 system-ui; }
    .x:hover { color: var(--glass-fg, #fff); background: rgba(255,255,255,0.08); }
    .add { display: inline-flex; align-items: center; gap: 5px; min-height: 26px; padding: 0 10px; border-radius: 999px; border: 1px dashed var(--glass-stroke-gold, rgba(217,180,95,0.45)); background: none; color: var(--glass-gold-hi, #f1d38a); font: 600 11.5px/1 var(--font-ui, system-ui); cursor: pointer; }
    .add:hover { background: var(--glass-gold-a06, rgba(217,180,95,0.08)); }
    .add:focus-visible, .chip button:focus-visible, .x:focus-visible { outline: 2px solid var(--glass-gold, #d9b45f); outline-offset: 2px; }
    .empty { color: var(--glass-fg-3, #8f897c); font-size: 11.5px; }
    .err { color: #f0a24a; font-size: 11.5px; }
    .sk { width: 120px; height: 22px; border-radius: 999px; background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.09), rgba(255,255,255,0.04)); }
  `;

  private get key() {
    return `${this.objectType}:${this.objectId}`;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(CHANGED, this.onChanged);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(CHANGED, this.onChanged);
    this.closePicker();
  }

  updated() {
    if (this.client && this.objectType && this.objectId && this.loadedKey !== this.key) void this.load();
  }

  private async load(force = false) {
    if (!this.client || !this.objectType || !this.objectId) return;
    const key = this.key;
    if (!force) {
      this.loadedKey = key;
      this.people = null;
    }
    try {
      const r = (await this.client.request("network.links.list", { objectType: this.objectType, objectId: this.objectId })) as { people?: LinkedPerson[] };
      if (key !== this.key) return;
      this.people = r.people ?? [];
      this.unavailable = false;
    } catch (e) {
      if (key !== this.key) return;
      const msg = e instanceof Error ? e.message : String(e);
      // Gateway without the RPC / plugin disabled → hide quietly.
      this.unavailable = /unknown method|not found|disabled|unavailable|forbidden/i.test(msg);
      this.people = [];
      if (!this.unavailable) this.err = msg;
    }
  }

  private announce() {
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: { key: this.key } }));
  }

  private openPerson(p: LinkedPerson) {
    const url = `/people-network?contact=${encodeURIComponent(p.contactId)}`;
    window.history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  private async unlink(p: LinkedPerson) {
    if (!this.client || this.busy) return;
    this.busy = true;
    try {
      await this.client.request("network.links.remove", { relationId: p.relationId });
      await this.load(true);
      this.announce();
    } catch (e) {
      this.err = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  private async link(c: ContactHit) {
    if (!this.client) return;
    this.closePicker();
    this.busy = true;
    this.err = "";
    try {
      await this.client.request("network.links.add", { kind: "contact", id: c.id, objectType: this.objectType, objectId: this.objectId });
      await this.load(true);
      this.announce();
    } catch (e) {
      this.err = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  private closePicker() {
    this.picker?.remove();
    this.picker = null;
  }

  /** Searchable contact picker, mounted on body and anchored to the button. */
  private openPicker(anchor: HTMLElement) {
    if (!this.client) return;
    this.closePicker();
    const client = this.client;
    const linked = new Set((this.people ?? []).map((p) => p.contactId));
    // Not enough room under the button (phones, rows low on the page): scroll
    // it up first so the picker opens below instead of covering the chips.
    if (anchor.getBoundingClientRect().bottom + 330 > window.innerHeight)
      this.scrollIntoView({ block: "start", behavior: "instant" as ScrollBehavior });
    const rect = anchor.getBoundingClientRect();
    const box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Link a person");
    box.className = "ib-people-picker";
    const w = Math.min(320, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    const below = rect.bottom + 6;
    const top = below + 320 > window.innerHeight ? Math.max(8, rect.top - 326) : below;
    Object.assign(box.style, {
      position: "fixed",
      zIndex: "2147483000",
      left: `${left}px`,
      top: `${top}px`,
      width: `${w}px`,
      maxHeight: "320px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      padding: "10px",
      borderRadius: "14px",
      border: "1px solid var(--glass-stroke-gold, rgba(217,180,95,0.4))",
      background: "var(--glass-2, rgba(20,18,14,0.96))",
      backdropFilter: "blur(14px)",
      boxShadow: "0 18px 50px rgba(0,0,0,0.5)",
      color: "var(--glass-fg, #f4f1ea)",
      font: "500 12.5px/1.3 var(--font-ui, system-ui, sans-serif)",
    } satisfies Partial<CSSStyleDeclaration>);
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Search your network…";
    input.setAttribute("aria-label", "Search people in your network");
    Object.assign(input.style, {
      width: "100%",
      boxSizing: "border-box",
      minHeight: "34px",
      padding: "0 10px",
      borderRadius: "9px",
      border: "1px solid var(--glass-stroke, rgba(255,255,255,0.12))",
      background: "var(--glass-1, rgba(255,255,255,0.04))",
      color: "inherit",
      font: "inherit",
      outline: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    const list = document.createElement("div");
    Object.assign(list.style, { overflowY: "auto", display: "flex", flexDirection: "column", gap: "2px" });
    box.append(input, list);
    let seq = 0;
    const search = async () => {
      const mine = ++seq;
      list.textContent = "Searching…";
      list.style.color = "var(--glass-fg-3, #8f897c)";
      try {
        const r = (await client.request("network.contacts.list", { query: input.value.trim(), limit: 30 })) as { contacts: ContactHit[] };
        if (mine !== seq) return;
        list.textContent = "";
        list.style.color = "";
        const rows = (r.contacts ?? []).filter((c) => !linked.has(c.id)).slice(0, 30);
        if (!rows.length) {
          list.textContent = input.value ? "No one matches." : "Everyone in your network is already linked.";
          list.style.color = "var(--glass-fg-3, #8f897c)";
          return;
        }
        for (const c of rows) {
          const b = document.createElement("button");
          b.type = "button";
          const name = c.name || c.client?.name || "(unnamed)";
          Object.assign(b.style, {
            display: "flex",
            alignItems: "center",
            gap: "8px",
            width: "100%",
            padding: "6px 8px",
            border: "0",
            borderRadius: "8px",
            background: "none",
            color: "inherit",
            font: "inherit",
            textAlign: "left",
            cursor: "pointer",
          } satisfies Partial<CSSStyleDeclaration>);
          const av = document.createElement("span");
          av.textContent = initials(name);
          Object.assign(av.style, {
            flex: "0 0 24px",
            width: "24px",
            height: "24px",
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            background: TONE[c.contactType] ?? TONE.other,
            color: "rgba(12,10,6,0.86)",
            font: "750 10px/1 system-ui",
          } satisfies Partial<CSSStyleDeclaration>);
          const txt = document.createElement("span");
          txt.style.minWidth = "0";
          const nm = document.createElement("b");
          nm.textContent = name;
          nm.style.display = "block";
          nm.style.fontWeight = "620";
          const sub = document.createElement("small");
          sub.textContent = [c.role, c.org].filter(Boolean).join(" · ") || c.contactType;
          Object.assign(sub.style, { display: "block", color: "var(--glass-fg-3, #8f897c)", fontSize: "11px" });
          txt.append(nm, sub);
          b.append(av, txt);
          b.addEventListener("mouseenter", () => (b.style.background = "var(--glass-gold-a06, rgba(217,180,95,0.1))"));
          b.addEventListener("mouseleave", () => (b.style.background = "none"));
          b.addEventListener("click", () => void this.link(c));
          list.append(b);
        }
      } catch (e) {
        if (mine !== seq) return;
        list.textContent = e instanceof Error ? e.message : String(e);
        list.style.color = "#f0a24a";
      }
    };
    let t: ReturnType<typeof setTimeout> | null = null;
    input.addEventListener("input", () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void search(), 180);
    });
    const onDoc = (ev: Event) => {
      if (!box.isConnected) return document.removeEventListener("pointerdown", onDoc, true);
      if (!ev.composedPath().includes(box) && !ev.composedPath().includes(anchor)) {
        this.closePicker();
        document.removeEventListener("pointerdown", onDoc, true);
      }
    };
    box.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        this.closePicker();
        anchor.focus();
      }
    });
    document.addEventListener("pointerdown", onDoc, true);
    document.body.append(box);
    // The app may apply CSS zoom to the page: fixed coordinates are then
    // scaled relative to getBoundingClientRect. Measure and correct.
    const got = box.getBoundingClientRect();
    const scale = got.width > 0 ? got.width / w : 1;
    if (Math.abs(scale - 1) > 0.02) {
      const vw = window.innerWidth / scale;
      const vh = window.innerHeight / scale;
      const ww = w / scale > vw - 16 ? vw - 16 : w;
      box.style.width = `${ww}px`;
      const l = Math.max(8, Math.min(rect.left / scale, vw - ww - 8));
      const below2 = rect.bottom / scale + 6;
      const t = below2 + 320 > vh ? Math.max(8, rect.top / scale - 326) : below2;
      box.style.left = `${l}px`;
      box.style.top = `${t}px`;
    }
    this.picker = box;
    input.focus();
    void search();
  }

  render() {
    if (this.unavailable || !this.objectType || !this.objectId) return nothing;
    const people = this.people;
    return html`<div class="row" role="group" aria-label=${`${this.label} linked from My Network`}>
      <span class="lbl"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13.5c.6-2.4 2.3-3.8 4.5-3.8s3.9 1.4 4.5 3.8"/><circle cx="11.5" cy="6" r="2"/><path d="M11 9.8c1.8.1 3 1.3 3.5 3.2"/></svg>${this.label}</span>
      ${people === null
        ? html`<span class="sk" aria-hidden="true"></span>`
        : people.map((p) => {
            const value = money(p.relationshipValue + p.pipelineValue);
            const title = [
              p.name,
              [p.role, p.org].filter(Boolean).join(" @ "),
              p.linkRole ? `role here: ${p.linkRole}` : "",
              p.openOpportunities ? `${p.openOpportunities} open opportunit${p.openOpportunities === 1 ? "y" : "ies"}` : "",
              p.via === "connection" ? "linked through a connection" : "",
            ]
              .filter(Boolean)
              .join(" · ");
            return html`<span class="chip" style="--tone:${TONE[p.contactType] ?? TONE.other}" title=${title}>
              <button class="open" @click=${() => this.openPerson(p)} aria-label=${`Open ${p.name} in My Network`}>
                <span class="av">${initials(p.name)}</span>
                <span class="nm">${p.name}</span>
                ${value ? html`<span class="meta">${value}</span>` : nothing}
                ${p.via === "connection" ? html`<span class="via">via link</span>` : nothing}
              </button>
              ${p.via === "contact"
                ? html`<button class="x" ?disabled=${this.busy} aria-label=${`Unlink ${p.name}`} title="Unlink" @click=${() => this.unlink(p)}>×</button>`
                : nothing}
            </span>`;
          })}
      ${people && !people.length ? html`<span class="empty">No one linked</span>` : nothing}
      <button class="add" ?disabled=${this.busy} aria-haspopup="dialog" @click=${(e: Event) => this.openPicker(e.currentTarget as HTMLElement)}>+ Link person</button>
      ${this.err ? html`<span class="err" role="alert">${this.err}</span>` : nothing}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-people-chips": PeopleChips;
  }
}
