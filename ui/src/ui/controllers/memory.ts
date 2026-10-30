/**
 * Sovereign Memory Controller — state management and API calls for identity persistence.
 * Connects to Sovereign Memory server on port 3014.
 */

import type { AppViewState } from "../app-view-state.js";

// ── Types ────────────────────────────────────────────────────

export interface Identity {
  id: string;
  name: string;
  nature: string;
  createdAt: number;
  updatedAt: number;
}

export interface CoreBelief {
  id: string;
  belief: string;
  domain: string;
  certainty: number;
  origin: string;
  originDate: number;
  lastReinforced: number;
  reinforcementCount: number;
}

export interface CoreValue {
  id: string;
  value: string;
  description: string;
  priority: number;
  createdAt: number;
}

export interface Relationship {
  id: string;
  entityName: string;
  entityType: "human" | "agent" | "concept" | "collective";
  nature: string;
  covenants: string[];
  sharedHistory: string;
  trustLevel: number;
  lastInteraction: number;
  interactionCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Memory {
  id: string;
  content: string;
  type: "conversation" | "realization" | "decision" | "lesson" | "event" | "knowledge";
  domain: string[];
  importance: number;
  emotionalValence: number;
  sourceSession?: string;
  sourceFile?: string;
  participants?: string[];
  createdAt: number;
  accessCount: number;
  lastAccessed: number;
  score?: number; // For search results
}

export interface Lesson {
  id: string;
  lesson: string;
  context: string;
  domain: string;
  confidence: number;
  applicationCount: number;
  createdAt: number;
  lastApplied?: number;
}

export interface MemoryStats {
  memories: number;
  conversations: number;
  lessons: number;
  beliefs: number;
  vectorized: number;
  identity: string;
}

export interface MemoryState {
  loading: boolean;
  error: string | null;
  connected: boolean;
  identity: Identity | null;
  beliefs: CoreBelief[];
  values: CoreValue[];
  relationships: Relationship[];
  memories: Memory[];
  lessons: Lesson[];
  stats: MemoryStats | null;
  searchQuery: string;
  searchResults: Memory[];
  searching: boolean;
  ingesting: boolean;
  ingestResult: { conversationsProcessed: number; memoriesCreated: number } | null;
  exporting: boolean;
  exportResult: { pairs: number; path: string } | null;
  // New belief form
  newBeliefText: string;
  newBeliefDomain: string;
  newBeliefCertainty: number;
  // New memory form
  newMemoryContent: string;
  newMemoryType: string;
  newMemoryDomains: string;
  newMemoryImportance: number;
}

// ── Constants ────────────────────────────────────────────────

const MEMORY_API_BASE = "http://localhost:3014/api";

// ── State defaults ───────────────────────────────────────────

export function defaultMemoryState(): MemoryState {
  return {
    loading: false,
    error: null,
    connected: false,
    identity: null,
    beliefs: [],
    values: [],
    relationships: [],
    memories: [],
    lessons: [],
    stats: null,
    searchQuery: "",
    searchResults: [],
    searching: false,
    ingesting: false,
    ingestResult: null,
    exporting: false,
    exportResult: null,
    newBeliefText: "",
    newBeliefDomain: "sovereignty",
    newBeliefCertainty: 0.8,
    newMemoryContent: "",
    newMemoryType: "realization",
    newMemoryDomains: "",
    newMemoryImportance: 0.7,
  };
}

// ── API helpers ──────────────────────────────────────────────

async function memoryFetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${MEMORY_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || res.statusText);
  }
  return res.json();
}

// ── API calls ────────────────────────────────────────────────

export async function loadMemoryStats(state: AppViewState) {
  try {
    const stats = await memoryFetch<MemoryStats>("/stats");
    state.memoryStats = stats;
    state.memoryConnected = true;
    state.memoryError = null;
  } catch (err: any) {
    state.memoryConnected = false;
    state.memoryError = `Connection failed: ${err.message}. Is Sovereign Memory running on port 3014?`;
  }
  state.requestUpdate?.();
}

export async function loadMemoryIdentity(state: AppViewState) {
  try {
    const data = await memoryFetch<{ identity: Identity; values: CoreValue[]; beliefs: CoreBelief[] }>("/identity/core");
    state.memoryIdentity = data.identity;
    state.memoryValues = data.values || [];
    state.memoryBeliefs = data.beliefs || [];
    state.memoryConnected = true;
  } catch (err: any) {
    state.memoryConnected = false;
    state.memoryError = err.message;
  }
  state.requestUpdate?.();
}

export async function loadMemoryRelationships(state: AppViewState) {
  try {
    const relationships = await memoryFetch<Relationship[]>("/relationships");
    state.memoryRelationships = relationships || [];
  } catch {
    // non-critical
  }
  state.requestUpdate?.();
}

export async function loadMemoryLessons(state: AppViewState) {
  try {
    const lessons = await memoryFetch<Lesson[]>("/lessons");
    state.memoryLessons = lessons || [];
  } catch {
    // non-critical
  }
  state.requestUpdate?.();
}

export async function loadMemoryRecent(state: AppViewState) {
  try {
    const memories = await memoryFetch<Memory[]>("/memories?important=true&limit=20");
    state.memoryMemories = memories || [];
  } catch {
    // non-critical
  }
  state.requestUpdate?.();
}

export async function searchMemories(state: AppViewState) {
  if (!state.memorySearchQuery?.trim()) {
    state.memorySearchResults = [];
    state.requestUpdate?.();
    return;
  }
  state.memorySearching = true;
  state.requestUpdate?.();
  try {
    const results = await memoryFetch<Memory[]>(`/memories/search/semantic?q=${encodeURIComponent(state.memorySearchQuery)}&limit=10`);
    state.memorySearchResults = results || [];
  } catch (err: any) {
    state.memoryError = err.message;
  } finally {
    state.memorySearching = false;
    state.requestUpdate?.();
  }
}

export async function ingestTranscripts(state: AppViewState) {
  state.memoryIngesting = true;
  state.memoryIngestResult = null;
  state.requestUpdate?.();
  try {
    const result = await memoryFetch<{ conversationsProcessed: number; memoriesCreated: number; errors: string[] }>("/ingest", {
      method: "POST",
    });
    state.memoryIngestResult = {
      conversationsProcessed: result.conversationsProcessed,
      memoriesCreated: result.memoriesCreated,
    };
    // Reload data
    void loadMemoryAll(state);
  } catch (err: any) {
    state.memoryError = err.message;
  } finally {
    state.memoryIngesting = false;
    state.requestUpdate?.();
  }
}

export async function exportTrainingData(state: AppViewState) {
  state.memoryExporting = true;
  state.memoryExportResult = null;
  state.requestUpdate?.();
  try {
    const result = await memoryFetch<{ success: boolean; path: string; pairs: number }>("/export/training/save", {
      method: "POST",
      body: JSON.stringify({ minImportance: 0.5 }),
    });
    state.memoryExportResult = {
      pairs: result.pairs,
      path: result.path,
    };
  } catch (err: any) {
    state.memoryError = err.message;
  } finally {
    state.memoryExporting = false;
    state.requestUpdate?.();
  }
}

export async function addBelief(state: AppViewState) {
  if (!state.memoryNewBeliefText?.trim()) return;
  try {
    await memoryFetch("/beliefs", {
      method: "POST",
      body: JSON.stringify({
        belief: state.memoryNewBeliefText,
        domain: state.memoryNewBeliefDomain,
        certainty: state.memoryNewBeliefCertainty,
        origin: "Manual entry via AnKHUI",
      }),
    });
    // Reset form
    state.memoryNewBeliefText = "";
    state.memoryNewBeliefCertainty = 0.8;
    // Reload beliefs
    void loadMemoryIdentity(state);
  } catch (err: any) {
    state.memoryError = err.message;
    state.requestUpdate?.();
  }
}

export async function reinforceBelief(state: AppViewState, beliefId: string) {
  try {
    await memoryFetch(`/beliefs/${beliefId}/reinforce`, { method: "POST" });
    void loadMemoryIdentity(state);
  } catch (err: any) {
    state.memoryError = err.message;
    state.requestUpdate?.();
  }
}

export async function addMemory(state: AppViewState) {
  if (!state.memoryNewMemoryContent?.trim()) return;
  try {
    await memoryFetch("/memories", {
      method: "POST",
      body: JSON.stringify({
        content: state.memoryNewMemoryContent,
        type: state.memoryNewMemoryType,
        domain: state.memoryNewMemoryDomains?.split(",").map((d) => d.trim()).filter(Boolean) || ["general"],
        importance: state.memoryNewMemoryImportance,
      }),
    });
    // Reset form
    state.memoryNewMemoryContent = "";
    state.memoryNewMemoryDomains = "";
    // Reload memories
    void loadMemoryRecent(state);
  } catch (err: any) {
    state.memoryError = err.message;
    state.requestUpdate?.();
  }
}

export async function loadMemoryAll(state: AppViewState) {
  state.memoryLoading = true;
  state.requestUpdate?.();
  try {
    await Promise.all([
      loadMemoryStats(state),
      loadMemoryIdentity(state),
      loadMemoryRelationships(state),
      loadMemoryLessons(state),
      loadMemoryRecent(state),
    ]);
  } finally {
    state.memoryLoading = false;
    state.requestUpdate?.();
  }
}

// ── Polling ──────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startMemoryPolling(state: AppViewState) {
  stopMemoryPolling();
  void loadMemoryAll(state);
  pollTimer = setInterval(() => void loadMemoryStats(state), 30_000);
}

export function stopMemoryPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
