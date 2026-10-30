/**
 * People / Resources controller (K.I.S. Object 9).
 *
 * Data + CRUD layer for the People roster. Talks to the gateway `person.*` RPCs
 * through the shared browser client and owns the module-level UI state the view
 * renders from. Kept deliberately thin (mirrors the issues surface) — the view
 * (`ui/src/ui/views/person.ts`) imports this and renders.
 *
 * NOTE: this is the *business* People/Resources object (the humans who run the
 * company), NOT the AI agent roster. Do not conflate them.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ── Enums (kept in sync with src/person/types.ts) ──
export const RELATIONSHIP_TYPES = ["Founder", "Employee", "Contractor", "Partner"];
export const PERSON_STATUSES = ["Active", "Inactive", "Onboarding"];
export const ACCESS_LEVELS = ["Owner", "Admin", "Standard", "Restricted", "None"];
export const PRIORITIES = ["P0", "P1", "P2", "P3"];

// ── Types (mirror the server model; UI-facing subset) ──
export interface Person {
  id: string;
  name: string;
  relationshipType: string;
  role: string;
  status: string;
  capabilities: string[];
  availability: string;
  costRate: string;
  accessLevel: string;
  email: string;
  phone: string;
  contactInfo: string;
  owner: string;
  supportingOwner?: string;
  priority: string;
  dataQuality?: string;
  authorityLevel?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PersonWorkload {
  personId: string;
  taskCount: number;
  activeTaskCount: number;
  projectCount: number;
  decisionCount: number;
  riskCount: number;
  issueCount: number;
  totalLinks: number;
}

export type PersonDraft = Partial<Person> & { capabilitiesText?: string };

export interface PersonUIState {
  people: Person[];
  workloads: Record<string, PersonWorkload>;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  search: string;
  filterRelationship: string;
  filterStatus: string;
  modalOpen: boolean;
  draft: PersonDraft;
  editingId: string | null;
  saving: boolean;
}

export const personState: PersonUIState = {
  people: [],
  workloads: {},
  loading: false,
  loaded: false,
  error: null,
  search: "",
  filterRelationship: "",
  filterStatus: "",
  modalOpen: false,
  draft: {},
  editingId: null,
  saving: false,
};

function rerender(app: AppViewState) {
  app.requestUpdate?.();
}

// ── Data ──
export async function loadPeople(app: AppViewState, client: GatewayBrowserClient) {
  personState.loading = true;
  personState.error = null;
  try {
    const res = (await client.request("person.list", {
      query: personState.search || undefined,
      relationshipType: personState.filterRelationship || undefined,
      status: personState.filterStatus || undefined,
    })) as { people?: Person[] };
    personState.people = res?.people ?? [];
    personState.loaded = true;
    // Fetch capacity for each person (derived on the server from relations).
    void loadWorkloads(app, client);
  } catch (e) {
    personState.error = String(e);
  } finally {
    personState.loading = false;
    rerender(app);
  }
}

/** Best-effort: hydrate per-person workload counts for the roster view. */
export async function loadWorkloads(app: AppViewState, client: GatewayBrowserClient) {
  const ids = personState.people.map((p) => p.id);
  await Promise.all(
    ids.map(async (id) => {
      try {
        const w = (await client.request("person.workload", { id })) as PersonWorkload;
        if (w && w.personId) personState.workloads[id] = w;
      } catch {
        /* leave missing; the roster shows a dash */
      }
    }),
  );
  rerender(app);
}

export function openCreate(app: AppViewState) {
  personState.editingId = null;
  personState.error = null;
  personState.draft = {
    relationshipType: "Employee",
    status: "Active",
    accessLevel: "Standard",
    priority: "P2",
    dataQuality: "FounderReported",
    capabilitiesText: "",
  };
  personState.modalOpen = true;
  rerender(app);
}

export function openEdit(app: AppViewState, person: Person) {
  personState.editingId = person.id;
  personState.error = null;
  personState.draft = {
    ...person,
    capabilitiesText: (person.capabilities ?? []).join(", "),
  };
  personState.modalOpen = true;
  rerender(app);
}

export function closeModal(app: AppViewState) {
  personState.modalOpen = false;
  personState.draft = {};
  personState.editingId = null;
  personState.error = null;
  rerender(app);
}

export function setField<K extends keyof PersonDraft>(
  app: AppViewState,
  key: K,
  value: PersonDraft[K],
) {
  personState.draft = { ...personState.draft, [key]: value };
  rerender(app);
}

function capabilitiesFromText(text: string | undefined): string[] {
  return String(text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function savePerson(app: AppViewState, client: GatewayBrowserClient) {
  if (!personState.draft.name?.trim()) {
    personState.error = "Name is required";
    rerender(app);
    return;
  }
  personState.saving = true;
  personState.error = null;
  rerender(app);
  try {
    const { capabilitiesText, capabilities: _drop, ...rest } = personState.draft;
    const payload = { ...rest, capabilities: capabilitiesFromText(capabilitiesText) };
    if (personState.editingId) {
      await client.request("person.update", { ...payload, id: personState.editingId });
    } else {
      await client.request("person.create", { ...payload });
    }
    personState.modalOpen = false;
    personState.draft = {};
    personState.editingId = null;
    await loadPeople(app, client);
  } catch (e) {
    personState.error = String(e);
  } finally {
    personState.saving = false;
    rerender(app);
  }
}

export async function deletePerson(app: AppViewState, client: GatewayBrowserClient, id: string) {
  try {
    await client.request("person.delete", { id });
    if (personState.editingId === id) closeModal(app);
    await loadPeople(app, client);
  } catch (e) {
    personState.error = String(e);
    rerender(app);
  }
}
