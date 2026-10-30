import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";

export type BrowserSiteDecision = "allow" | "ask" | "block";

export type BrowserSiteRule = {
  pattern: string;
  decision: BrowserSiteDecision;
};

export type BrowserExtensionProfile = {
  id: string;
  name: string;
  extensionId: string;
  createdAt: number;
  lastSeenAt: number;
  connected: boolean;
};

export type BrowserAuditEntry = {
  id: string;
  at: number;
  runId: string;
  profileId?: string;
  targetId?: string;
  url?: string;
  action: string;
  outcome: "allowed" | "blocked" | "approval_required" | "error";
  detail?: string;
};

type StoredProfile = Omit<BrowserExtensionProfile, "connected"> & { tokenHash: string };
type StoredState = {
  version: 1;
  killSwitch: boolean;
  defaultDecision: BrowserSiteDecision;
  rules: BrowserSiteRule[];
  profiles: StoredProfile[];
};

type PairingCode = { hash: string; name: string; expiresAt: number };
type TabLock = { runId: string; profileId?: string; at: number };

const DEFAULT_STATE: StoredState = {
  version: 1,
  killSwitch: false,
  defaultDecision: "ask",
  rules: [
    { pattern: "localhost", decision: "allow" },
    { pattern: "127.0.0.1", decision: "allow" },
  ],
  profiles: [],
};

const PAIRING_TTL_MS = 10 * 60_000;
const TAB_LOCK_TTL_MS = 2 * 60_000;
const MAX_AUDIT_ENTRIES = 2_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cleanName(value: unknown): string {
  const name = String(value ?? "Chrome")
    .trim()
    .replace(/[^a-zA-Z0-9 _.-]+/g, "")
    .slice(0, 48);
  return name || "Chrome";
}

function makeCode(): string {
  const bytes = randomBytes(8);
  let value = "";
  for (let i = 0; i < bytes.length; i += 1)
    value += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function normalizePattern(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

export function siteRuleMatches(pattern: string, rawUrl: string): boolean {
  let host = "";
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    host = normalizePattern(rawUrl).split("/")[0] ?? "";
  }
  const p = normalizePattern(pattern);
  if (!p || !host) return false;
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === p;
}

export function sensitiveBrowserAction(params: Record<string, unknown>): string | null {
  const action = String(params.action ?? "").toLowerCase();
  const haystack = [params.text, params.value, params.code, params.url]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  if (action === "evaluate") return "running JavaScript in the page";
  if (action === "type" || action === "fill" || action === "press" || action === "click") {
    if (
      /password|passcode|one[- ]?time|\b2fa\b|verification code|security code|otp/.test(haystack)
    ) {
      return "entering a password or verification code";
    }
    if (
      /purchase|buy now|checkout|payment|credit card|place order|subscribe|send money|transfer/.test(
        haystack,
      )
    ) {
      return "making a purchase or payment";
    }
    if (/send email|send message|post now|publish|tweet|comment/.test(haystack)) {
      return "sending an external message or post";
    }
    if (
      /delete|remove account|close account|change password|security settings|account settings/.test(
        haystack,
      )
    ) {
      return "deleting data or changing account settings";
    }
  }
  return null;
}

export class BrowserExtensionGovernance {
  private state: StoredState;
  private readonly pairing = new Map<string, PairingCode>();
  private readonly connected = new Set<string>();
  private readonly locks = new Map<string, TabLock>();
  private readonly audit: BrowserAuditEntry[] = [];
  private readonly temporaryRunRules = new Map<string, Map<string, number>>();

  constructor(
    private readonly stateFile = path.join(resolveStateDir(), "browser", "extension.json"),
  ) {
    this.state = this.readState();
    this.audit.push(...this.readAudit());
  }

  private auditFile(): string {
    return path.join(path.dirname(this.stateFile), "extension-audit.jsonl");
  }

  private readAudit(): BrowserAuditEntry[] {
    try {
      return fs
        .readFileSync(this.auditFile(), "utf8")
        .trim()
        .split("\n")
        .slice(-MAX_AUDIT_ENTRIES)
        .map((line) => JSON.parse(line) as BrowserAuditEntry);
    } catch {
      return [];
    }
  }

  private readState(): StoredState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as Partial<StoredState>;
      return {
        ...DEFAULT_STATE,
        ...raw,
        rules: Array.isArray(raw.rules) ? raw.rules : DEFAULT_STATE.rules,
        profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
      };
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }

  createPairingCode(name?: string): { code: string; expiresAt: number; profileName: string } {
    const code = makeCode();
    const entry = {
      hash: sha256(code),
      name: cleanName(name),
      expiresAt: Date.now() + PAIRING_TTL_MS,
    };
    this.pairing.set(entry.hash, entry);
    return { code, expiresAt: entry.expiresAt, profileName: entry.name };
  }

  pair(input: { code: string; name?: string; extensionId?: string }): {
    token: string;
    profile: BrowserExtensionProfile;
  } {
    const hash = sha256(
      String(input.code ?? "")
        .trim()
        .toUpperCase(),
    );
    const pending = this.pairing.get(hash);
    this.pairing.delete(hash);
    if (!pending || pending.expiresAt < Date.now())
      throw new Error("Pairing code is invalid or expired.");
    const token = randomBytes(32).toString("base64url");
    const id = randomBytes(12).toString("hex");
    const now = Date.now();
    const record: StoredProfile = {
      id,
      name: cleanName(input.name || pending.name),
      extensionId: cleanName(input.extensionId || "unknown"),
      createdAt: now,
      lastSeenAt: now,
      tokenHash: sha256(token),
    };
    this.state.profiles.push(record);
    this.save();
    return { token, profile: { ...record, connected: false } };
  }

  authenticate(token: string): BrowserExtensionProfile | null {
    const tokenHash = sha256(String(token ?? ""));
    const record = this.state.profiles.find((p) => p.tokenHash === tokenHash);
    if (!record) return null;
    record.lastSeenAt = Date.now();
    this.save();
    return { ...record, connected: this.connected.has(record.id) };
  }

  setConnected(profileId: string, connected: boolean): void {
    if (connected) this.connected.add(profileId);
    else this.connected.delete(profileId);
    const record = this.state.profiles.find((p) => p.id === profileId);
    if (record) {
      record.lastSeenAt = Date.now();
      this.save();
    }
  }

  revoke(profileId: string): boolean {
    const before = this.state.profiles.length;
    this.state.profiles = this.state.profiles.filter((p) => p.id !== profileId);
    this.connected.delete(profileId);
    if (this.state.profiles.length !== before) this.save();
    return this.state.profiles.length !== before;
  }

  status() {
    return {
      killSwitch: this.state.killSwitch,
      defaultDecision: this.state.defaultDecision,
      rules: this.state.rules.map((r) => ({ ...r })),
      profiles: this.state.profiles.map(({ tokenHash: _tokenHash, ...p }) => ({
        ...p,
        connected: this.connected.has(p.id),
      })),
      locks: [...this.locks.entries()].map(([targetId, lock]) => ({ targetId, ...lock })),
      audit: this.audit.slice(-100).reverse(),
    };
  }

  setKillSwitch(enabled: boolean): void {
    this.state.killSwitch = enabled;
    this.save();
  }

  isKilled(): boolean {
    return this.state.killSwitch;
  }

  setRules(rules: BrowserSiteRule[], defaultDecision = this.state.defaultDecision): void {
    this.state.rules = rules
      .map((r) => ({ pattern: normalizePattern(r.pattern), decision: r.decision }))
      .filter((r) => r.pattern && ["allow", "ask", "block"].includes(r.decision));
    this.state.defaultDecision = defaultDecision;
    this.save();
  }

  allowSiteForRun(url: string, runId: string, ttlMs = 4 * 60 * 60_000): void {
    const host = (() => {
      try {
        return new URL(url).hostname.toLowerCase();
      } catch {
        return "";
      }
    })();
    if (!host || !runId.trim()) throw new Error("A valid URL and run id are required");
    const rules = this.temporaryRunRules.get(runId) ?? new Map<string, number>();
    rules.set(host, Date.now() + Math.max(60_000, ttlMs));
    this.temporaryRunRules.set(runId, rules);
  }

  revokeRunAllowances(runId: string): void {
    this.temporaryRunRules.delete(runId);
  }

  decisionForUrl(url: string, runId?: string): BrowserSiteDecision {
    if (runId) {
      const rules = this.temporaryRunRules.get(runId);
      const now = Date.now();
      for (const [host, expiresAt] of rules ?? []) {
        if (expiresAt <= now) rules?.delete(host);
        else if (siteRuleMatches(host, url)) return "allow";
      }
      if (rules && !rules.size) this.temporaryRunRules.delete(runId);
    }
    for (const rule of this.state.rules)
      if (siteRuleMatches(rule.pattern, url)) return rule.decision;
    return this.state.defaultDecision;
  }

  lockTab(targetId: string, runId: string, profileId?: string): void {
    const now = Date.now();
    const existing = this.locks.get(targetId);
    if (existing && existing.runId !== runId && now - existing.at < TAB_LOCK_TTL_MS) {
      throw new Error(`Tab ${targetId} is locked by another agent run.`);
    }
    this.locks.set(targetId, { runId, profileId, at: now });
  }

  unlockTab(targetId: string, runId: string): boolean {
    const existing = this.locks.get(targetId);
    if (!existing || existing.runId !== runId) return false;
    this.locks.delete(targetId);
    return true;
  }

  auditAction(entry: Omit<BrowserAuditEntry, "id" | "at">): BrowserAuditEntry {
    const record = { id: randomBytes(8).toString("hex"), at: Date.now(), ...entry };
    this.audit.push(record);
    if (this.audit.length > MAX_AUDIT_ENTRIES)
      this.audit.splice(0, this.audit.length - MAX_AUDIT_ENTRIES);
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.auditFile(), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return record;
  }
}

let singleton: BrowserExtensionGovernance | null = null;

export function getBrowserExtensionGovernance(): BrowserExtensionGovernance {
  singleton ??= new BrowserExtensionGovernance();
  return singleton;
}

export function _resetBrowserExtensionGovernanceForTests(): void {
  singleton = null;
}
