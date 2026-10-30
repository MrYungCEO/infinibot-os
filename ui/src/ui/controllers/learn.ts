/**
 * Learn controller — drives the dashboard's `/learn` page (interactive
 * walkthroughs). Talks to `learn.*` gateway methods and tracks the
 * stepper state for the active track.
 */

import type { GatewayBrowserClient } from "../gateway";

// ── Types (mirror server) ───────────────────────────────────

export type StepVerify =
  | { kind: "manual" }
  | { kind: "tab_visited"; tab: string }
  | { kind: "method_called"; method: string }
  | { kind: "feature_used"; feature: string };

export interface WalkthroughStep {
  id: string;
  title: string;
  body: string;
  cta?: { label: string; tab?: string; url?: string };
  verify?: StepVerify;
  estMinutes?: number;
}

export interface Walkthrough {
  id: string;
  title: string;
  description: string;
  audience: "user" | "admin" | "all";
  prerequisites?: string[];
  defaultForNewUsers?: boolean;
  order?: number;
  category?: string;
  steps: WalkthroughStep[];
  badge?: string;
}

export interface UserProgress {
  userId: string;
  trackId: string;
  currentStepId: string | null;
  completedSteps: string[];
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  notes: string;
}

export interface TrackSummary extends Walkthrough {
  progress?: UserProgress | null;
  totalSteps: number;
  completedCount: number;
  percent: number;
}

export interface AdminUserRow {
  user: { id: string; username: string; role: "admin" | "user"; language: string };
  progress: TrackSummary[];
}

export type LearnTab = "my-tracks" | "library" | "certification" | "admin-users" | "author";

export type CertTier = "apprentice" | "practitioner" | "master";

export interface CertEligibility {
  tier: CertTier;
  missing: string[];
  earned: string[];
  total: number;
  percent: number;
  awarded: boolean;
}

export interface Certificate {
  id: string;
  userId: string;
  tier: CertTier;
  awardedAt: number;
  hash: string;
  displayName: string;
}

export interface LearnState {
  loading: boolean;
  error: string | null;
  success: string | null;
  tab: LearnTab;
  /** Library — every track with caller progress attached. */
  tracks: TrackSummary[];
  /** Track currently expanded in the stepper view. */
  activeTrackId: string | null;
  /** Hydrated track + progress for the stepper. */
  active: { track: Walkthrough; progress: UserProgress | null } | null;
  /** Step id currently shown in the stepper. */
  currentStepId: string | null;
  /** Per-user notes draft (dirty until saved). */
  notesDraft: string;
  notesDirty: boolean;
  /** Admin: aggregate progress table. */
  adminUsers: AdminUserRow[];
  /** Admin authoring: the JSON the admin is editing. */
  authorDraft: string;
  authorTrackId: string | null;
  /** Cert eligibility ladder + already-earned certs. */
  certEligibility: CertEligibility[];
  certificates: Certificate[];
  /** Currently-displayed certificate SVG (when the user clicks View). */
  certSvg: { tier: CertTier; svg: string } | null;
}

export function createInitialLearnState(): LearnState {
  return {
    loading: false,
    error: null,
    success: null,
    tab: "my-tracks",
    tracks: [],
    activeTrackId: null,
    active: null,
    currentStepId: null,
    notesDraft: "",
    notesDirty: false,
    adminUsers: [],
    authorDraft: "",
    authorTrackId: null,
    certEligibility: [],
    certificates: [],
    certSvg: null,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function flash(state: { learn: LearnState; requestUpdate?: () => void }, kind: "error" | "success", value: string | null, ms = 3000) {
  state.learn[kind] = value;
  if (value) setTimeout(() => { if (state.learn[kind] === value) state.learn[kind] = null; state.requestUpdate?.(); }, ms);
}

// ── API actions ──────────────────────────────────────────────

export async function loadTracks(state: { learn: LearnState; requestUpdate?: () => void }, client: GatewayBrowserClient): Promise<void> {
  state.learn.loading = true;
  state.learn.error = null;
  state.requestUpdate?.();
  try {
    const res = (await client.request("learn.tracks.list", {})) as { tracks: TrackSummary[] };
    state.learn.tracks = res.tracks ?? [];
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.learn.loading = false;
    state.requestUpdate?.();
  }
}

export async function openTrack(state: { learn: LearnState; requestUpdate?: () => void }, client: GatewayBrowserClient, trackId: string): Promise<void> {
  state.learn.activeTrackId = trackId;
  state.learn.active = null;
  state.requestUpdate?.();
  try {
    const res = (await client.request("learn.track.get", { id: trackId })) as { track: Walkthrough; progress: UserProgress | null };
    state.learn.active = res;
    state.learn.currentStepId = res.progress?.currentStepId ?? res.track.steps[0]?.id ?? null;
    state.learn.notesDraft = res.progress?.notes ?? "";
    state.learn.notesDirty = false;
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.requestUpdate?.();
  }
}

export async function assignTrack(state: { learn: LearnState; requestUpdate?: () => void }, client: GatewayBrowserClient, trackId: string): Promise<void> {
  try {
    await client.request("learn.tracks.assign", { trackId });
    flash(state, "success", "Track assigned");
    await loadTracks(state, client);
    await openTrack(state, client, trackId);
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  }
}

export async function setCurrentStep(state: { learn: LearnState; requestUpdate?: () => void }, client: GatewayBrowserClient, stepId: string): Promise<void> {
  if (!state.learn.active) return;
  state.learn.currentStepId = stepId;
  state.requestUpdate?.();
  try {
    await client.request("learn.progress.setCurrent", { trackId: state.learn.active.track.id, stepId });
  } catch { /* non-fatal */ }
}

export async function completeStep(state: { learn: LearnState; requestUpdate?: () => void }, client: GatewayBrowserClient, stepId: string): Promise<void> {
  if (!state.learn.active) return;
  try {
    const res = (await client.request("learn.progress.completeStep", {
      trackId: state.learn.active.track.id,
      stepId,
    })) as { progress: UserProgress };
    state.learn.active = { track: state.learn.active.track, progress: res.progress };
    state.learn.currentStepId = res.progress.currentStepId ?? stepId;
    flash(state, "success", res.progress.completedAt ? "Track complete!" : "Step complete");
    // Refresh library so the track-card progress bars move.
    await loadTracks(state, client);
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.requestUpdate?.();
  }
}

export function setNotes(state: { learn: LearnState; requestUpdate?: () => void }, value: string): void {
  state.learn.notesDraft = value;
  state.learn.notesDirty = true;
  state.requestUpdate?.();
}

export async function saveNotes(state: { learn: LearnState; requestUpdate?: () => void }, client: GatewayBrowserClient): Promise<void> {
  if (!state.learn.active) return;
  try {
    await client.request("learn.progress.setNotes", {
      trackId: state.learn.active.track.id,
      notes: state.learn.notesDraft,
    });
    state.learn.notesDirty = false;
    flash(state, "success", "Notes saved");
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  }
}

export async function loadAdminUsers(state: { learn: LearnState; requestUpdate?: () => void }, client: GatewayBrowserClient): Promise<void> {
  try {
    const res = (await client.request("learn.admin.allUsers", {})) as { users: AdminUserRow[] };
    state.learn.adminUsers = res.users ?? [];
    state.requestUpdate?.();
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  }
}

export async function saveAuthorDraft(state: { learn: LearnState; requestUpdate?: () => void }, client: GatewayBrowserClient): Promise<void> {
  try {
    const parsed = JSON.parse(state.learn.authorDraft);
    if (!parsed?.id || !Array.isArray(parsed?.steps)) {
      flash(state, "error", "Track JSON needs at least { id, steps[] }");
      return;
    }
    await client.request("learn.admin.upsertTrack", { track: parsed });
    flash(state, "success", "Track saved");
    await loadTracks(state, client);
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  }
}

export async function deleteAuthorTrack(state: { learn: LearnState; requestUpdate?: () => void }, client: GatewayBrowserClient, id: string): Promise<void> {
  if (!confirm(`Delete track "${id}"? Bundled tracks can't be deleted — only admin-authored copies.`)) return;
  try {
    await client.request("learn.admin.deleteTrack", { id });
    flash(state, "success", "Deleted");
    await loadTracks(state, client);
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  }
}

// ── Certificate actions ─────────────────────────────────────

export async function loadCertStatus(state: { learn: LearnState; requestUpdate?: () => void }, client: GatewayBrowserClient): Promise<void> {
  try {
    const res = (await client.request("learn.certificate.status", {})) as {
      eligibility: CertEligibility[];
      certificates: Certificate[];
    };
    state.learn.certEligibility = res.eligibility ?? [];
    state.learn.certificates = res.certificates ?? [];
    state.requestUpdate?.();
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  }
}

export async function viewCertificate(state: { learn: LearnState; requestUpdate?: () => void }, client: GatewayBrowserClient, tier: CertTier): Promise<void> {
  try {
    const res = (await client.request("learn.certificate.svg", { tier })) as { svg: string };
    state.learn.certSvg = { tier, svg: res.svg };
    state.requestUpdate?.();
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  }
}

export function closeCertificate(state: { learn: LearnState; requestUpdate?: () => void }): void {
  state.learn.certSvg = null;
  state.requestUpdate?.();
}

export function downloadCertificate(svg: string, tier: CertTier, displayName: string): void {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `infinibot-${tier}-${displayName.replace(/[^a-zA-Z0-9]/g, "_")}.svg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Local mutators ──────────────────────────────────────────

export function setLearnTab(state: { learn: LearnState; requestUpdate?: () => void }, tab: LearnTab): void {
  state.learn.tab = tab;
  state.requestUpdate?.();
}

export function setAuthorDraft(state: { learn: LearnState; requestUpdate?: () => void }, value: string, trackId?: string): void {
  state.learn.authorDraft = value;
  if (trackId !== undefined) state.learn.authorTrackId = trackId;
  state.requestUpdate?.();
}
