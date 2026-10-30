/**
 * People / Resources (K.I.S. Object 9) view — team & capacity roster.
 *
 * A Notion-style roster of the humans who run the business (founders, employees,
 * contractors, partners) with a per-person derived capacity readout, plus a
 * full-field create/edit modal. Black & gold glassmorphism to match the issues /
 * notes / kanban surfaces. Data + CRUD live in `controllers/person.ts`.
 *
 * NOTE: this is the *business* People/Resources surface — NOT the AI agent
 * roster. Do not conflate them.
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import {
  ACCESS_LEVELS,
  PERSON_STATUSES,
  PRIORITIES,
  RELATIONSHIP_TYPES,
  closeModal,
  deletePerson,
  loadPeople,
  openCreate,
  openEdit,
  personState,
  savePerson,
  setField,
  type Person,
  type PersonDraft,
} from "../controllers/person";
import {
  KIS_STYLE,
  avatar,
  bar,
  bulkBar,
  chip,
  createFeedback,
  createSelection,
  createSort,
  emptyState,
  errorBanner,
  filterChip,
  filterGroup,
  ghostButton,
  icon,
  primaryButton,
  selectBox,
  skeletonRows,
  sortBy,
  sortHeader,
  stagger,
  statCard,
  statStrip,
  statusChip,
  statusLine,
  tableShell,
  toolbar,
  type Tone,
} from "./kis-shared";
import { wgAurora, wgHero } from "./work-glass";
import { wgkField, wgkModal, wgkSection, wgkSelect } from "./work-glass/kis-form";

// ── Page-level UI state the controller doesn't persist ──────────────────────
const sel = createSelection();
const sort = createSort("workload", "desc");
const fb = createFeedback();

const RELATIONSHIP_TONES: Record<string, Tone> = {
  Founder: "gold",
  Employee: "ok",
  Contractor: "info",
  Partner: "warn",
};
const PERSON_STATUS_TONES: Record<string, Tone> = {
  Active: "ok",
  Inactive: "muted",
  Onboarding: "warn",
};

const COLS = "26px 2fr 0.9fr 1.4fr 0.9fr 1.5fr 1.2fr";


// ── Field helpers ──
function textField(
  app: AppViewState,
  label: string,
  key: keyof PersonDraft,
  opts: { area?: boolean; type?: string; placeholder?: string; span?: boolean } = {},
) {
  const val = (personState.draft[key] as string) ?? "";
  return wgkField(label, val, (v) => setField(app, key, v), { rows: 2, ...opts });
}

function selectField(app: AppViewState, label: string, key: keyof PersonDraft, options: string[]) {
  const val = (personState.draft[key] as string) ?? "";
  return wgkSelect(label, val, options, (v) => setField(app, key, v));
}

// ── Modal ──
function renderModal(app: AppViewState, client: GatewayBrowserClient) {
  if (!personState.modalOpen) return nothing;
  const isEdit = Boolean(personState.editingId);
  return wgkModal({
    eyebrow: "Operations · Person",
    title: isEdit ? "Edit Person / Resource" : "Add Person / Resource",
    onClose: () => closeModal(app),
    width: 820,
    error: personState.error,
    body: html`
      ${wgkSection("Identity")}
      ${textField(app, "Name *", "name", { placeholder: "Full name" })}
      ${selectField(app, "Relationship Type", "relationshipType", RELATIONSHIP_TYPES)}
      ${textField(app, "Role", "role", { placeholder: "e.g. Head of Growth" })}
      ${selectField(app, "Status", "status", PERSON_STATUSES)}

      ${wgkSection("Capability")}
      ${textField(app, "Capabilities / Skills (comma-separated)", "capabilitiesText", { area: true, placeholder: "e.g. Copywriting, Paid ads, Figma", span: true })}

      ${wgkSection("Capacity & Cost")}
      ${textField(app, "Availability / Capacity", "availability", { placeholder: "e.g. Full-time, 20 hrs/week" })}
      ${textField(app, "Cost / Rate", "costRate", { placeholder: "e.g. $120/hr" })}

      ${wgkSection("Access & Contact")}
      ${selectField(app, "Access Level", "accessLevel", ACCESS_LEVELS)}
      ${textField(app, "Email", "email", { type: "email" })}
      ${textField(app, "Phone", "phone")}
      ${textField(app, "Other Contact Info", "contactInfo", { placeholder: "Slack, timezone, address…" })}

      ${wgkSection("Accountability")}
      ${textField(app, "Owner (accountable manager)", "owner")}
      ${selectField(app, "Priority", "priority", PRIORITIES)}
    `,
    foot: html`
      ${isEdit
        ? html`<button class="wgk-btn wgk-btn--danger" @click=${() => deletePerson(app, client, personState.editingId!)}>
            ${icon("trash", 13)}<span>Delete</span>
          </button>`
        : nothing}
      <div class="wgk-modal__foot-end">
        <button class="wgk-btn" @click=${() => closeModal(app)}>Cancel</button>
        <button class="wgk-btn wgk-btn--primary" ?disabled=${personState.saving} @click=${() => savePerson(app, client)}>
          ${personState.saving ? "Saving…" : isEdit ? "Save Changes" : "Add Person"}
        </button>
      </div>
    `,
  });
}

// ── Roster row ──
// ── Workload cell — a real capacity bar, not a text fragment ────────────────
/** Busiest active-task count on the roster, so every bar shares one scale. */
function workloadCeiling(): number {
  let max = 0;
  for (const w of Object.values(personState.workloads)) max = Math.max(max, w.activeTaskCount || 0);
  return Math.max(max, 4);
}

function workloadCell(id: string) {
  const w = personState.workloads[id];
  if (!w) return html`<span class="kis-td-sub">—</span>`;
  const ceiling = workloadCeiling();
  const load = w.activeTaskCount || 0;
  const pct = load / ceiling;
  const tone: Tone = pct >= 0.9 ? "danger" : pct >= 0.6 ? "warn" : load === 0 ? "muted" : "ok";
  return html`
    <span class="per-load">
      ${bar(load, ceiling, {
        tone,
        width: 68,
        label: `${load} active of ${w.taskCount} tasks across ${w.projectCount} projects (busiest on the roster: ${ceiling})`,
      })}
      <span class="per-load-nums kis-num">
        <b class="per-load-active per-load-active--${tone}">${load}</b>
        <span>/ ${w.taskCount}t · ${w.projectCount}p</span>
      </span>
    </span>
  `;
}

// ── Row ──────────────────────────────────────────────────────────────────────
function personRow(app: AppViewState, p: Person, index: number) {
  const selected = sel.has(p.id);
  const unverified = p.dataQuality && p.dataQuality !== "Verified";
  return html`
    <div
      class="kis-tr ${selected ? "is-selected" : ""}"
      role="row"
      tabindex="0"
      style="animation-delay:${stagger(index)}"
      @click=${() => openEdit(app, p)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openEdit(app, p);
        }
      }}
    >
      ${selectBox(selected, () => {
        sel.toggle(p.id);
        app.requestUpdate?.();
      }, { label: `Select ${p.name || "unnamed person"}` })}

      <div class="kis-td kis-td--flex">
        ${avatar(p.name, { size: 24 })}
        <span class="kis-td-stack">
          <span class="kis-td--strong per-name">${p.name || "(unnamed)"}</span>
          ${p.email ? html`<span class="kis-td-sub">${p.email}</span>` : nothing}
        </span>
        ${unverified
          ? html`<span
              class="per-flag"
              role="img"
              aria-label=${`Data quality: ${p.dataQuality}`}
              title=${`Data quality: ${p.dataQuality}`}
            >${icon("alert", 10)}</span>`
          : nothing}
      </div>

      <div class="kis-td" data-label="Type">${chip(p.relationshipType || "—", RELATIONSHIP_TONES[p.relationshipType] ?? "muted")}</div>
      <div class="kis-td" data-label="Role">${p.role || "—"}</div>
      <div class="kis-td" data-label="Status">${statusChip(p.status, PERSON_STATUS_TONES)}</div>
      <div class="kis-td" data-label="Workload">${workloadCell(p.id)}</div>
      <div class="kis-td" data-label="Availability">${p.availability || "—"}</div>
    </div>
  `;
}

// ── Main render ──────────────────────────────────────────────────────────────
export function renderPerson(app: AppViewState, client: GatewayBrowserClient) {
  if (!personState.loaded && !personState.loading) {
    void loadPeople(app, client);
  }
  const rerender = () => app.requestUpdate?.();

  const people = personState.people;
  const active = people.filter((p) => p.status === "Active").length;
  const onboarding = people.filter((p) => p.status === "Onboarding").length;
  const contractors = people.filter((p) => p.relationshipType === "Contractor").length;
  const loads = people.map((p) => personState.workloads[p.id]?.activeTaskCount ?? 0);
  const totalActive = loads.reduce((s, n) => s + n, 0);
  const ceiling = workloadCeiling();
  const overloaded = people.filter((p) => (personState.workloads[p.id]?.activeTaskCount ?? 0) >= ceiling * 0.9 && ceiling > 0 && (personState.workloads[p.id]?.activeTaskCount ?? 0) > 0).length;
  const idle = people.filter((p) => p.status === "Active" && (personState.workloads[p.id]?.activeTaskCount ?? 0) === 0).length;

  const rows = sortBy(people, sort, {
    name: (p) => (p.name || "").toLowerCase(),
    relationshipType: (p) => (p.relationshipType || "").toLowerCase(),
    role: (p) => (p.role || "").toLowerCase(),
    status: (p) => (p.status || "").toLowerCase(),
    workload: (p) => personState.workloads[p.id]?.activeTaskCount ?? -1,
    availability: (p) => (p.availability || "￿").toLowerCase(),
  });

  const pageIds = rows.map((p) => p.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => sel.has(id));
  const someSelected = !allSelected && pageIds.some((id) => sel.has(id));

  const bulkStatus = (next: string) =>
    void fb.run(`Marking ${sel.size} ${next.toLowerCase()}`, async () => {
      for (const id of [...sel.ids]) await client.request("person.update", { id, status: next });
      sel.clear();
      await loadPeople(app, client);
    }, rerender);

  const bulkDelete = () =>
    void fb.run(`Removing ${sel.size} ${sel.size === 1 ? "person" : "people"}`, async () => {
      for (const id of [...sel.ids]) await deletePerson(app, client, id);
      sel.clear();
      await loadPeople(app, client);
    }, rerender);

  return html`
    <div class="kis kis-per wg-page wg-kis">
      ${wgAurora()}
      ${KIS_STYLE}
      ${PER_STYLE}

      ${wgHero({
        eyebrow: "Operations · Object 9",
        title: html`People <span class="wg-gold">& Resources</span>`,
        sub: html`The team and capacity roster — founders, employees, contractors and partners. Workload is derived from linked tasks and projects.
          ${overloaded || idle || onboarding
            ? html`<span class="wgk-callouts">
                ${overloaded ? chip(`${overloaded} at capacity`, "danger") : nothing}
                ${idle ? chip(`${idle} unloaded`, "warn") : nothing}
                ${onboarding ? chip(`${onboarding} onboarding`, "info") : nothing}
              </span>`
            : nothing}`,
        actions: html`
          ${ghostButton("Refresh", () => void fb.run("Refreshing", () => loadPeople(app, client), rerender), {
            iconName: "refresh",
            state: personState.loading ? "busy" : "idle",
          })}
          ${primaryButton("Add Person", () => openCreate(app), { iconName: "plus" })}
        `,
      })}

      ${statStrip([
        statCard({ label: "Roster", value: people.length, tone: "gold", iconName: "user", sub: "people tracked" }),
        statCard({ label: "Active", value: active, tone: "ok", sub: "available to assign" }),
        statCard({ label: "Contractors", value: contractors, tone: "info", sub: "external capacity" }),
        statCard({ label: "Active tasks", value: totalActive, tone: "gold", sub: "assigned across the roster" }),
        statCard({ label: "At capacity", value: overloaded, tone: overloaded ? "danger" : "ok", sub: "≥90% of the busiest load" }),
        statCard({ label: "Unloaded", value: idle, tone: idle ? "warn" : "ok", sub: "active but no open work" }),
      ])}

      ${toolbar({
        search: {
          value: personState.search,
          placeholder: "Search name / role / skills / email…",
          onInput: (v) => {
            personState.search = v;
          },
          onCommit: () => void loadPeople(app, client),
        },
        filters: html`
          ${filterGroup(
            "Type",
            html`
              ${filterChip("All", personState.filterRelationship === "", () => {
                personState.filterRelationship = "";
                void loadPeople(app, client);
              })}
              ${RELATIONSHIP_TYPES.map((t) =>
                filterChip(t, personState.filterRelationship === t, () => {
                  personState.filterRelationship = t;
                  void loadPeople(app, client);
                }),
              )}
            `,
          )}
          ${filterGroup(
            "Status",
            html`
              ${filterChip("All", personState.filterStatus === "", () => {
                personState.filterStatus = "";
                void loadPeople(app, client);
              })}
              ${PERSON_STATUSES.map((st) =>
                filterChip(st, personState.filterStatus === st, () => {
                  personState.filterStatus = st;
                  void loadPeople(app, client);
                }),
              )}
            `,
          )}
        `,
        trailing: statusLine(fb),
      })}

      ${personState.error ? errorBanner(personState.error, () => void loadPeople(app, client)) : nothing}

      <div class="kis-tablewrap">
        ${tableShell({
          caption: "People and resources roster",
          cols: COLS,
          head: html`
            ${selectBox(allSelected, () => {
              sel.setAll(pageIds, !allSelected);
              rerender();
            }, { label: allSelected ? "Deselect everyone" : "Select everyone", indeterminate: someSelected })}
            ${sortHeader("Name", "name", sort, rerender)}
            ${sortHeader("Type", "relationshipType", sort, rerender)}
            ${sortHeader("Role", "role", sort, rerender)}
            ${sortHeader("Status", "status", sort, rerender)}
            ${sortHeader("Workload", "workload", sort, rerender, { natural: "desc" })}
            ${sortHeader("Availability", "availability", sort, rerender)}
          `,
          body: personState.loading && !people.length
            ? skeletonRows(6, COLS)
            : rows.length === 0
              ? emptyState({
                  iconName: "user",
                  title:
                    personState.search || personState.filterRelationship || personState.filterStatus
                      ? "Nobody matches these filters"
                      : "The roster is empty",
                  hint:
                    personState.search || personState.filterRelationship || personState.filterStatus
                      ? "Clear the type or status filter to see everyone on the roster."
                      : "Add the founders, employees, contractors and partners who do the work — capacity and workload are derived automatically from what they are linked to.",
                  actionLabel: "Add the first person",
                  onAction: () => openCreate(app),
                })
              : rows.map((p, i) => personRow(app, p, i)),
        })}
        ${bulkBar({
          count: sel.size,
          noun: "person",
          onClear: () => {
            sel.clear();
            rerender();
          },
          actions: html`
            ${ghostButton("Mark active", () => bulkStatus("Active"), { iconName: "check", tone: "ok", state: fb.state === "busy" ? "busy" : "idle" })}
            ${ghostButton("Mark inactive", () => bulkStatus("Inactive"), { iconName: "x", state: fb.state === "busy" ? "busy" : "idle" })}
            ${ghostButton("Remove", bulkDelete, { iconName: "trash", tone: "danger", state: fb.state === "busy" ? "busy" : "idle" })}
          `,
        })}
      </div>

      ${people.length
        ? html`<p class="kis-footnote">
            ${rows.length} of ${people.length} people shown · ${totalActive} active tasks · busiest load
            <span class="kis-num">${ceiling}</span>
          </p>`
        : nothing}

      ${renderModal(app, client)}
    </div>
  `;
}

// ── Person-specific styling (layered on the shared .kis system) ──────────────
const PER_STYLE = html`
  <style>
    .kis-per .per-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
    .kis-per .per-flag { color: var(--warn); display: flex; flex: 0 0 auto; }
    .kis-per .per-load { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .kis-per .per-load-nums { display: inline-flex; align-items: baseline; gap: 4px; font-size: 9.5px; color: var(--fg-muted); white-space: nowrap; }
    .kis-per .per-load-active { font-size: 11px; font-weight: 800; }
    .kis-per .per-load-active--ok { color: var(--ok); }
    .kis-per .per-load-active--warn { color: var(--warn); }
    .kis-per .per-load-active--danger { color: var(--danger); }
    .kis-per .per-load-active--muted { color: var(--fg-muted); }
  </style>
`;
