/**
 * Robovoice linkage enforcement.
 *
 * A voice session, a call or a speech request goes through this plugin ONLY
 * when this install is linked to a Robovoice organization (device-code login →
 * `rve_` org token + this install's edge device + its location). Everything a
 * call uses is taken from that link, never from a fallback:
 *
 *   - the Robovoice deployment is `link.apiBase` (not a configured/legacy
 *     `baseUrl` or `ROBOVOICE_URL`, which used to point at the operator's own
 *     LAN stack);
 *   - the device is the link's device with its HMAC key (never an anonymous
 *     caller, which Robovoice serves from the deployment owner's roster and
 *     wallet);
 *   - the character is one THIS org owns at the linked location — an agent's
 *     own linked character, or a mapping / default validated against the org's
 *     roster. There is no "let Robovoice pick" any more: that picked the
 *     deployment default (RoboPark's Magnus & co.).
 *
 * The org roster comes from the authenticated edge pipeline view
 * (`/api/edge/infinibot/pipeline?location=`), never from the public
 * `/api/call/characters`, which lists the deployment owner's agents.
 */

import { VoiceProviderError } from "infinibot/plugin-sdk";

import type { RobovoiceEdgeApi } from "./edge-api.js";
import type { RobovoiceLink, RobovoiceSettings, RobovoiceSettingsStore } from "./settings.js";

export const NOT_LINKED_CODE = "robovoice_not_linked";
export const NOT_LINKED_MESSAGE =
  "Connect Robovoice first to use cloud voice (free): Voice page → Connect Robovoice. Local voice works without it.";

export type LinkedContext = {
  link: RobovoiceLink & { locationId: string; deviceId: string };
  apiBase: string;
  orgId: string;
  locationId: string;
  deviceId: string;
  deviceKey: string;
  edgeToken: string;
};

export type LinkState =
  | { linked: true; ctx: LinkedContext }
  | { linked: false; reason: "never_linked" | "unlinked" | "signed_out" | "incomplete"; message: string };

/** The linked org this install may use for voice, or why there is none. Local only (no network). */
export function linkState(store: RobovoiceSettingsStore): LinkState {
  const s = store.get();
  const secrets = store.secrets();
  const link = s.link;
  if (!link) return { linked: false, reason: "never_linked", message: NOT_LINKED_MESSAGE };
  if (link.unlinkedAt) return { linked: false, reason: "unlinked", message: NOT_LINKED_MESSAGE };
  if (!secrets.edgeToken) return { linked: false, reason: "signed_out", message: NOT_LINKED_MESSAGE };
  if (!link.locationId || !link.deviceId || !secrets.deviceKey) {
    return {
      linked: false,
      reason: "incomplete",
      message: "The Robovoice link is incomplete (no location or device) — reconnect Robovoice on the Voice page.",
    };
  }
  return {
    linked: true,
    ctx: {
      link: link as LinkedContext["link"],
      apiBase: link.apiBase,
      orgId: link.orgId,
      locationId: link.locationId,
      deviceId: link.deviceId,
      deviceKey: secrets.deviceKey,
      edgeToken: secrets.edgeToken,
    },
  };
}

export function isLinked(store: RobovoiceSettingsStore): boolean {
  return linkState(store).linked;
}

/** The linked context, or a 409 `robovoice_not_linked` error. */
export function requireLinked(store: RobovoiceSettingsStore): LinkedContext {
  const st = linkState(store);
  if (!st.linked) throw new VoiceProviderError(st.message, 409, NOT_LINKED_CODE);
  return st.ctx;
}

// --- the org's roster ---------------------------------------------------------

export type OrgCharacter = { id: string; name: string; infinibotAgentId?: string | null };

type PipelineReader = Pick<RobovoiceEdgeApi, "pipelineGet">;

/** Reuse an org roster answer this long (calls + the mapping UI ask together). */
export const ROSTER_FRESH_MS = 30_000;
/** Validate against the last good answer this long when Robovoice doesn't answer. */
export const ROSTER_STALE_MAX_MS = 10 * 60_000;

/**
 * The characters this org has at the linked location, from Robovoice's
 * authenticated edge pipeline view. Cached per (org, location) for
 * ROSTER_FRESH_MS; a failed read falls back to the last good answer for up to
 * ROSTER_STALE_MAX_MS, else throws (callers fail closed).
 */
export class OrgRoster {
  private cache: { key: string; at: number; characters: OrgCharacter[] } | null = null;
  private inflight: { key: string; promise: Promise<OrgCharacter[]> } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  invalidate(): void {
    this.cache = null;
  }

  async get(ctx: Pick<LinkedContext, "orgId" | "locationId">, api: PipelineReader): Promise<OrgCharacter[]> {
    const key = `${ctx.orgId}\n${ctx.locationId}`;
    const hit = this.cache?.key === key ? this.cache : null;
    if (hit && this.now() - hit.at < ROSTER_FRESH_MS) return hit.characters;
    try {
      const characters = await this.fetch(key, ctx.locationId, api);
      this.cache = { key, at: this.now(), characters };
      return characters;
    } catch (err) {
      if (hit && this.now() - hit.at < ROSTER_STALE_MAX_MS) return hit.characters;
      throw new VoiceProviderError(
        `Couldn't read your Robovoice organization's agents: ${err instanceof Error ? err.message : String(err)}`,
        503,
        "robovoice_roster_unavailable",
      );
    }
  }

  private fetch(key: string, locationId: string, api: PipelineReader): Promise<OrgCharacter[]> {
    if (this.inflight?.key === key) return this.inflight.promise;
    const promise = api
      .pipelineGet(locationId)
      .then((cfg) =>
        (Array.isArray(cfg.characters) ? cfg.characters : [])
          .filter((c) => c && typeof c.id === "string" && c.id)
          .map((c) => ({ id: c.id, name: typeof c.name === "string" && c.name ? c.name : c.id, infinibotAgentId: c.infinibot_agent_id ?? null })),
      )
      .finally(() => {
        if (this.inflight?.promise === promise) this.inflight = null;
      });
    this.inflight = { key, promise };
    return promise;
  }
}

// --- which character answers ----------------------------------------------------

export type LinkedCharacterChoice = {
  characterId: string;
  source: "linked" | "mapping" | "default";
  agentId: string;
};

/**
 * The character an InfiniBot agent's call runs as — only ids this install got
 * from (or pointed at in) its own org: the agent's synced character, else its
 * mapping, else the configured default. Null when there is none (the caller
 * refuses the call; Robovoice is never asked to pick).
 */
export function linkedCharacterFor(
  s: Pick<RobovoiceSettings, "linkedCharacters" | "characterMap" | "defaultCharacterId">,
  agentId: string,
): LinkedCharacterChoice | null {
  const linked = s.linkedCharacters[agentId]?.characterId;
  if (linked) return { characterId: linked, source: "linked", agentId };
  const mapped = s.characterMap[agentId];
  if (mapped) return { characterId: mapped, source: "mapping", agentId };
  if (s.defaultCharacterId) return { characterId: s.defaultCharacterId, source: "default", agentId };
  return null;
}

/** Throw unless `characterId` is one of the org's characters at the linked location. */
export function assertOrgCharacter(characterId: string, roster: OrgCharacter[], orgName?: string): OrgCharacter {
  const hit = roster.find((c) => c.id === characterId);
  if (!hit) {
    throw new VoiceProviderError(
      `Character ${characterId} isn't one of ${orgName ? `${orgName}'s` : "your Robovoice organization's"} agents at this location — pick one of your own agents under Voice → Voice agents.`,
      409,
      "robovoice_foreign_character",
    );
  }
  return hit;
}

// --- config validation ----------------------------------------------------------

export type ConfigIssue = {
  field: "characterMap" | "defaultCharacterId" | "linkedCharacters" | "pipelineLocationId";
  key?: string;
  value: string;
  problem: "not_in_org" | "not_linked";
  message: string;
};

/**
 * Org-scoped config that doesn't belong to the linked org: mappings / default
 * pointing at characters outside its roster, synced characters that vanished,
 * a pipeline location that isn't the linked one and isn't in the org.
 */
export function configIssues(
  s: RobovoiceSettings,
  roster: OrgCharacter[] | null,
  orgLocationIds?: string[] | null,
): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  const ids = roster ? new Set(roster.map((c) => c.id)) : null;
  const linked = Boolean(s.link && !s.link.unlinkedAt);
  const bad = (field: ConfigIssue["field"], value: string, key?: string): void => {
    out.push({
      field,
      key,
      value,
      problem: linked ? "not_in_org" : "not_linked",
      message: linked
        ? `${key ? `${key} → ` : ""}${value} isn't an agent of ${s.link?.orgName ?? "the linked organization"} at this location`
        : `${key ? `${key} → ` : ""}${value} is left over from a previous Robovoice link`,
    });
  };
  for (const [agentId, cid] of Object.entries(s.characterMap)) if (!linked || (ids && !ids.has(cid))) bad("characterMap", cid, agentId);
  if (s.defaultCharacterId && (!linked || (ids && !ids.has(s.defaultCharacterId)))) bad("defaultCharacterId", s.defaultCharacterId);
  for (const [agentId, ch] of Object.entries(s.linkedCharacters)) {
    if (ch.characterId && (!linked || (ids && !ids.has(ch.characterId)))) bad("linkedCharacters", ch.characterId, agentId);
  }
  if (s.pipelineLocationId && s.pipelineLocationId !== s.link?.locationId) {
    if (!linked || (orgLocationIds && !orgLocationIds.includes(s.pipelineLocationId))) bad("pipelineLocationId", s.pipelineLocationId);
  }
  return out;
}

/** Settings patch that clears every flagged id (mappings, default, synced characters, pipeline location). */
export function clearIssuesPatch(s: RobovoiceSettings, issues: ConfigIssue[]): Partial<RobovoiceSettings> {
  const patch: Partial<RobovoiceSettings> = {};
  const characterMap = { ...s.characterMap };
  const linkedCharacters = { ...s.linkedCharacters };
  let mapChanged = false;
  let linkedChanged = false;
  for (const i of issues) {
    if (i.field === "characterMap" && i.key) {
      delete characterMap[i.key];
      mapChanged = true;
    } else if (i.field === "linkedCharacters" && i.key) {
      delete linkedCharacters[i.key];
      linkedChanged = true;
    } else if (i.field === "defaultCharacterId") {
      patch.defaultCharacterId = undefined;
    } else if (i.field === "pipelineLocationId") {
      patch.pipelineLocationId = undefined;
    }
  }
  if (mapChanged) patch.characterMap = characterMap;
  if (linkedChanged) patch.linkedCharacters = linkedCharacters;
  return patch;
}

/**
 * Everything that belongs to ONE org and must not survive unlink / logout /
 * a switch to another org: character mappings and default, synced
 * characters, device + location, the pipeline location pick.
 */
export const ORG_SCOPED_CLEAR: Partial<RobovoiceSettings> = {
  characterMap: {},
  linkedCharacters: {},
  defaultCharacterId: undefined,
  deviceId: undefined,
  locationId: undefined,
  pipelineLocationId: undefined,
};
