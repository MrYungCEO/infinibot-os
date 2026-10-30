/**
 * What a satellite shares with its master (`federation.share` in config).
 *
 * The master reaches a satellite's resources in three ways: proxied gateway
 * calls (`gateway.proxy.invoke` → terminal.*, coder spawns, chat), federated
 * session spawns (`session.spawn`), and the capabilities the satellite
 * advertises in its manifest (local models / GPU the master may delegate to).
 * Each category below can be switched off by the satellite's owner; an unset
 * category (or no `share` block at all, as in every config written before
 * this existed) stays shared, so existing federations behave exactly as before.
 *
 * Pure: no I/O.
 */

export type FederationShare = {
  /** Interactive terminals (terminal.* over the federation). */
  terminals?: boolean;
  /** Coder CLIs (Claude Code, Codex, OpenCode) spawned on this machine. */
  coders?: boolean;
  /** Agent runs and chat sessions executed on this machine. */
  agents?: boolean;
  /** Local models and GPU (Ollama, ComfyUI) advertised for delegation. */
  compute?: boolean;
};

export type ShareCategory = keyof FederationShare;

export const SHARE_CATEGORIES: readonly ShareCategory[] = [
  "terminals",
  "coders",
  "agents",
  "compute",
];

/** Which share category a proxied gateway method belongs to (null: always allowed). */
export function shareCategoryForMethod(method: string): ShareCategory | null {
  const m = method.trim();
  if (m === "terminal.spawnAgent" || m.startsWith("coder.") || m.startsWith("coders."))
    return "coders";
  if (m.startsWith("terminal.")) return "terminals";
  if (
    m === "agent" ||
    m.startsWith("agent.") ||
    m.startsWith("chat.") ||
    m.startsWith("sessions.") ||
    m.startsWith("session.")
  ) {
    return "agents";
  }
  return null;
}

/** True unless the owner switched this category off. */
export function isShareAllowed(
  share: FederationShare | undefined | null,
  category: ShareCategory,
): boolean {
  return share?.[category] !== false;
}

/** May the master run `method` on this satellite? */
export function isMethodShared(share: FederationShare | undefined | null, method: string): boolean {
  const category = shareCategoryForMethod(method);
  return category === null || isShareAllowed(share, category);
}

const CATEGORY_LABEL: Record<ShareCategory, string> = {
  terminals: "terminals",
  coders: "coder CLIs",
  agents: "agent runs",
  compute: "local models and GPU",
};

/** The error the master sees when it asks for something this satellite keeps to itself. */
export function notSharedMessage(category: ShareCategory): string {
  return `This satellite does not share its ${CATEGORY_LABEL[category]} (federation.share.${category} is off).`;
}

/** Hide local models / GPU from the advertised capabilities when compute isn't shared. */
export function applyShareToCapabilities<
  T extends {
    hasOllama?: boolean;
    ollamaModels?: string[];
    hasComfyUI?: boolean;
    gpu?: string;
    gpuVRAM?: number;
  },
>(share: FederationShare | undefined | null, capabilities: T): T {
  if (isShareAllowed(share, "compute")) return capabilities;
  return {
    ...capabilities,
    hasOllama: false,
    ollamaModels: undefined,
    hasComfyUI: false,
    gpu: undefined,
    gpuVRAM: undefined,
  };
}

/** Normalize untrusted input (a wizard request) into a share block: booleans only. */
export function normalizeShare(raw: unknown): FederationShare {
  const out: FederationShare = {};
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const key of SHARE_CATEGORIES) {
    if (typeof obj[key] === "boolean") out[key] = obj[key] as boolean;
  }
  return out;
}
