/**
 * Wake-word cross-tab coordinator.
 *
 * Solves two problems that fall out of running multiple InfiniBot tabs at
 * once in the same browser:
 *
 *   1. Multiple mics. Every tab opened a separate getUserMedia stream and
 *      ran its own Whisper capture. The user heard their fans spin and got
 *      duplicate wake-detections — every tab fired on every "hey projects".
 *
 *   2. No codename routing. Saying "hey delta projects" did nothing
 *      special; whichever tab heard it first won. There was no way to
 *      direct a phrase to a *specific* window.
 *
 * Design:
 *
 *   - A single BroadcastChannel ("infinibot-wake-coord") shared across all
 *     same-origin tabs.
 *   - Every tab announces itself with a `spawnedAt` timestamp. Leader =
 *     the peer with the smallest spawnedAt (ties broken lexicographically
 *     by peerId). First-spawned coordinates.
 *   - Followers tear down their own capture via setFollowerMode(true).
 *     Only the leader runs the mic. Followers still keep their local
 *     panel registrations — they just don't listen directly.
 *   - Each peer broadcasts its phrase list. The leader aggregates every
 *     peer's phrases and:
 *       a) Registers the raw phrase ("hey projects") with a callback
 *          that broadcasts to the owner peer — *unless* the leader also
 *          has that phrase, in which case the leader's own handler
 *          fires (current-window default for ambiguous commands).
 *       b) Generates and registers codename-prefixed variants
 *          ("hey delta projects" for peer Delta with phrase "hey
 *          projects") — these always route to the codename owner.
 *   - When the leader's matcher fires a remote-registered phrase, it
 *     broadcasts `{ type: "wake-fire", targetPeerId, phrase }`. The
 *     target peer receives it and dispatches locally via
 *     dispatchWakeWord, which runs through its own handleWakeDetection
 *     and fires the original callback.
 *
 * Leader handoff: if the leader's tab closes (beforeunload broadcasts
 * `bye`) or stops sending heartbeats, the next-oldest peer becomes
 * leader on the next reconcile tick and starts capture.
 */

import {
  registerPanelWakeWord,
  setFollowerMode,
  listRegisteredWakePhrases,
  onWakePhrasesChange,
  dispatchWakeWord,
  startWakeListener,
} from "./wake-word.js";

const CHANNEL_NAME = "infinibot-wake-coord";
const HEARTBEAT_MS = 3000;
const PEER_TIMEOUT_MS = 8000;

interface Peer {
  peerId: string;
  spawnedAt: number;
  codename: string;
  instanceId: string;
  lastSeen: number;
  phrases: string[];
}

interface BaseMessage {
  type: string;
  peerId: string;
}

interface HelloMessage extends BaseMessage {
  type: "hello" | "heartbeat";
  spawnedAt: number;
  codename: string;
  instanceId: string;
  phrases: string[];
}

interface ByeMessage extends BaseMessage {
  type: "bye";
}

interface WakeFireMessage extends BaseMessage {
  type: "wake-fire";
  targetPeerId: string;
  phrase: string;
}

type CoordMessage = HelloMessage | ByeMessage | WakeFireMessage;

// ── Self ────────────────────────────────────────────────────
const selfPeerId =
  (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? (crypto as Crypto).randomUUID()
    : `peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const selfSpawnedAt = Date.now();
let selfCodename = "";
let selfInstanceId = "";
let selfPhrases: string[] = [];

const peers = new Map<string, Peer>();
let channel: BroadcastChannel | null = null;
let isLeader = false;
let initialized = false;

// Remote-phrase registrations the leader maintains. Key = phrase, value
// = { peerId we'd route to, unsubscribe fn }.
const remoteRegistry = new Map<string, { peerId: string; unsubscribe: () => void }>();

function nowMs(): number {
  return Date.now();
}

function selfDescriptor(): Omit<HelloMessage, "type"> {
  return {
    peerId: selfPeerId,
    spawnedAt: selfSpawnedAt,
    codename: selfCodename,
    instanceId: selfInstanceId,
    phrases: selfPhrases,
  };
}

function broadcast(msg: CoordMessage): void {
  if (!channel) return;
  try {
    channel.postMessage(msg);
  } catch (err) {
    console.warn("[wake-coord] broadcast failed:", err);
  }
}

function pickLeaderId(): string {
  // Inline self into the candidate set rather than mutating `peers`.
  let bestId = selfPeerId;
  let bestSpawn = selfSpawnedAt;
  for (const p of peers.values()) {
    if (p.spawnedAt < bestSpawn || (p.spawnedAt === bestSpawn && p.peerId < bestId)) {
      bestId = p.peerId;
      bestSpawn = p.spawnedAt;
    }
  }
  return bestId;
}

function dropStalePeers(): boolean {
  const cutoff = nowMs() - PEER_TIMEOUT_MS;
  let changed = false;
  for (const [id, p] of peers) {
    if (p.lastSeen < cutoff) {
      peers.delete(id);
      changed = true;
    }
  }
  return changed;
}

function reconcile(): void {
  dropStalePeers();
  const leaderId = pickLeaderId();
  const wasLeader = isLeader;
  isLeader = leaderId === selfPeerId;
  if (isLeader !== wasLeader) {
    if (isLeader) {
      console.log("[wake-coord] became LEADER (peers:", peers.size + 1, ")");
      setFollowerMode(false);
    } else {
      console.log("[wake-coord] became FOLLOWER, leader =", leaderId);
      setFollowerMode(true);
      clearRemoteRegistrations();
    }
  }
  if (isLeader) syncRemoteRegistrations();
}

// ── Phrase-tail helper ──────────────────────────────────────
// "hey projects" → "projects"  (strip the wake prefix so we can re-prefix
// with the peer's codename: "hey delta projects").
function phraseTail(phrase: string): string {
  const norm = phrase.toLowerCase().trim();
  if (norm.startsWith("hey ")) return norm.slice(4).trim();
  return norm;
}

function codenamedVariant(codename: string, phrase: string): string {
  const tail = phraseTail(phrase);
  if (!codename || !tail) return phrase;
  return `hey ${codename.toLowerCase().trim()} ${tail}`;
}

function clearRemoteRegistrations(): void {
  for (const reg of remoteRegistry.values()) {
    try { reg.unsubscribe(); } catch { /* ignore */ }
  }
  remoteRegistry.clear();
}

/**
 * Reconcile remote-phrase registrations. Called only when this tab is
 * leader. For every peer P (NOT self), register:
 *   - P's raw phrases that self doesn't already have (so the leader's
 *     local matcher can detect them and broadcast to P)
 *   - The codenamed variant `hey <P.codename> <tail>` for every phrase
 *     P advertised — so the user can disambiguate routing by speaking
 *     the codename.
 * Also registers `hey <selfCodename> <tail>` variants for self's own
 * phrases so "hey oscar projects" routes locally on Oscar.
 */
function syncRemoteRegistrations(): void {
  if (!isLeader) return;

  const desired = new Map<string, string>(); // phrase → targetPeerId ("self" for local)
  const selfPhraseSet = new Set(selfPhrases.map((p) => p.toLowerCase().trim()));

  // Self codenamed variants (fire local).
  if (selfCodename) {
    for (const phrase of selfPhrases) {
      const variant = codenamedVariant(selfCodename, phrase);
      if (variant && !selfPhraseSet.has(variant)) desired.set(variant, "self");
    }
  }

  // Peer phrases (route to that peer).
  for (const peer of peers.values()) {
    for (const phrase of peer.phrases) {
      const clean = phrase.toLowerCase().trim();
      if (!clean) continue;
      // Raw phrase: register only if leader doesn't already own it. If
      // leader owns the same phrase, leader fires locally (current-window
      // default for ambiguous commands).
      if (!selfPhraseSet.has(clean) && !desired.has(clean)) {
        desired.set(clean, peer.peerId);
      }
      // Codenamed variant always wins routing to its owner.
      if (peer.codename) {
        const variant = codenamedVariant(peer.codename, clean);
        if (variant) desired.set(variant, peer.peerId);
      }
    }
  }

  // Apply diff
  for (const [phrase, target] of desired) {
    const existing = remoteRegistry.get(phrase);
    if (existing && existing.peerId === target) continue;
    if (existing) {
      try { existing.unsubscribe(); } catch { /* ignore */ }
      remoteRegistry.delete(phrase);
    }
    const targetId = target;
    const unsubscribe = registerPanelWakeWord({
      panelId: `coord:${phrase}`,
      enabled: true,
      wakeWord: phrase,
      callback: () => {
        if (targetId === "self") {
          // Codenamed-self variant ("hey oscar projects" on Oscar). Re-
          // enter the local matcher with the codename stripped so the
          // owning panel ("hey projects" → tab-wake → switch tab) fires.
          const stripped = stripSelfCodename(phrase);
          if (stripped !== phrase) {
            dispatchWakeWord(stripped);
            // dispatchWakeWord → handleWakeDetection on the inner phrase
            // already opens the right panel/voice flow. No mic restart
            // needed here; the standard flow handles it.
          }
          return;
        }
        console.log(`[wake-coord] → routing "${phrase}" → ${targetId}`);
        broadcast({
          type: "wake-fire",
          peerId: selfPeerId,
          targetPeerId: targetId,
          phrase,
        });
        // The outer handleWakeDetection just stopped our mic but no
        // local voice panel will open (the action runs on a remote
        // peer), so nothing else would restart capture. Re-arm it so
        // the leader keeps listening for the next phrase.
        setTimeout(() => { try { startWakeListener(); } catch { /* ignore */ } }, 100);
      },
    });
    remoteRegistry.set(phrase, { peerId: targetId, unsubscribe });
  }

  // Drop registrations no longer desired
  for (const [phrase, reg] of remoteRegistry) {
    if (!desired.has(phrase)) {
      try { reg.unsubscribe(); } catch { /* ignore */ }
      remoteRegistry.delete(phrase);
    }
  }
}

function handleMessage(msg: CoordMessage): void {
  if (!msg || msg.peerId === selfPeerId) return;

  if (msg.type === "hello" || msg.type === "heartbeat") {
    const existing = peers.get(msg.peerId);
    const peer: Peer = {
      peerId: msg.peerId,
      spawnedAt: msg.spawnedAt,
      codename: msg.codename ?? "",
      instanceId: msg.instanceId ?? "",
      phrases: Array.isArray(msg.phrases) ? msg.phrases : [],
      lastSeen: nowMs(),
    };
    peers.set(msg.peerId, peer);
    if (msg.type === "hello") {
      // Newcomer just joined — respond with our descriptor so it learns
      // about us immediately rather than waiting for the next heartbeat.
      broadcast({ type: "heartbeat", ...selfDescriptor() });
    }
    const phraseSetChanged =
      !existing ||
      existing.phrases.join("|") !== peer.phrases.join("|") ||
      existing.codename !== peer.codename;
    reconcile();
    if (isLeader && phraseSetChanged) syncRemoteRegistrations();
    return;
  }

  if (msg.type === "bye") {
    if (peers.delete(msg.peerId)) reconcile();
    return;
  }

  if (msg.type === "wake-fire") {
    if (msg.targetPeerId !== selfPeerId) return;
    // The leader detected a phrase intended for us. Strip an optional
    // codename prefix so the local matcher sees a phrase shape it
    // actually has registered.
    const codenameStripped = stripSelfCodename(msg.phrase);
    dispatchWakeWord(codenameStripped);
    return;
  }
}

function stripSelfCodename(phrase: string): string {
  if (!selfCodename) return phrase;
  const cn = selfCodename.toLowerCase().trim();
  const norm = phrase.toLowerCase().trim();
  const prefix = `hey ${cn} `;
  if (norm.startsWith(prefix)) return `hey ${norm.slice(prefix.length)}`;
  return phrase;
}

// ── Public API ───────────────────────────────────────────────

export function initWakeCoordinator(): void {
  if (initialized) return;
  if (typeof BroadcastChannel === "undefined") {
    console.warn("[wake-coord] BroadcastChannel unavailable — running in solo mode");
    setFollowerMode(false); // be the leader by default
    initialized = true;
    return;
  }

  try {
    selfInstanceId = sessionStorage.getItem("infinibot.tabInstanceId") ?? selfPeerId;
  } catch {
    selfInstanceId = selfPeerId;
  }

  selfPhrases = listRegisteredWakePhrases();

  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (e: MessageEvent<CoordMessage>) => handleMessage(e.data);

  broadcast({ type: "hello", ...selfDescriptor() });

  // Periodic heartbeat + reconciliation. Cheap — single postMessage.
  setInterval(() => {
    broadcast({ type: "heartbeat", ...selfDescriptor() });
    reconcile();
  }, HEARTBEAT_MS);

  // Watch our own phrase set; when it changes, rebroadcast so the leader
  // can keep its remote-phrase registry in sync.
  onWakePhrasesChange(() => {
    const next = listRegisteredWakePhrases();
    if (next.join("|") === selfPhrases.join("|")) return;
    selfPhrases = next;
    broadcast({ type: "heartbeat", ...selfDescriptor() });
    if (isLeader) syncRemoteRegistrations();
  });

  window.addEventListener("beforeunload", () => {
    broadcast({ type: "bye", peerId: selfPeerId });
  });

  initialized = true;
  reconcile();
  console.log(`[wake-coord] initialized — peerId=${selfPeerId.slice(0, 8)} spawnedAt=${selfSpawnedAt}`);
}

/** Hook from app-gateway.ts — called when the codename resolves. */
export function setWakeCoordSelfCodename(codename: string): void {
  const next = (codename || "").trim();
  if (next === selfCodename) return;
  selfCodename = next;
  console.log(`[wake-coord] self codename = "${selfCodename}"`);
  broadcast({ type: "heartbeat", ...selfDescriptor() });
  if (isLeader) syncRemoteRegistrations();
}

/** Devtools / diagnostic. */
export function listWakeCoordPeers(): Array<{ peerId: string; codename: string; spawnedAt: number; phrases: number; isLeader: boolean }> {
  const out: Array<{ peerId: string; codename: string; spawnedAt: number; phrases: number; isLeader: boolean }> = [];
  out.push({ peerId: selfPeerId, codename: selfCodename, spawnedAt: selfSpawnedAt, phrases: selfPhrases.length, isLeader });
  for (const p of peers.values()) {
    out.push({ peerId: p.peerId, codename: p.codename, spawnedAt: p.spawnedAt, phrases: p.phrases.length, isLeader: false });
  }
  return out;
}

export function isWakeCoordLeader(): boolean {
  return isLeader;
}

if (typeof window !== "undefined") {
  (window as unknown as { infinibotWakeCoordPeers?: typeof listWakeCoordPeers }).infinibotWakeCoordPeers =
    listWakeCoordPeers;
}
