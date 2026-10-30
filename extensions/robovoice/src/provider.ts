/**
 * Robovoice as an InfiniBot voice provider.
 *
 * Capability: "realtime" only. Robovoice runs STT → LLM → TTS inside its own
 * LiveKit agent, so a session is all InfiniBot needs. Wake word stays in the
 * browser.
 *
 * Linkage is enforced here (src/link-guard.ts): a session exists only for an
 * install linked to a Robovoice organization, it is minted by THAT link's
 * deployment for THAT link's device (so Robovoice places the billing hold on
 * the org's wallet), and the character is one of that org's agents. An
 * unlinked install, or one whose agent has no character of its own org, is
 * refused — there is no fallback to a configured / legacy Robovoice URL, an
 * anonymous caller or "whatever Robovoice picks" (the deployment owner's
 * default agent, on the owner's wallet).
 */

import { VoiceProviderError } from "infinibot/plugin-sdk";
import type {
  VoiceProvider,
  VoiceProviderStatus,
  VoiceRealtimeRequest,
  VoiceRealtimeSession,
} from "infinibot/plugin-sdk";
import { agentFromRoomName, encodeAgentIdForRoom } from "./character-map.js";
import { RobovoiceClient, type RobovoicePipeline } from "./client.js";
import { RobovoiceEdgeApi } from "./edge-api.js";
import {
  assertOrgCharacter,
  isLinked,
  linkState,
  linkedCharacterFor,
  OrgRoster,
  requireLinked,
  type LinkedContext,
  type OrgCharacter,
} from "./link-guard.js";
import { assessRobovoiceSafety } from "./safety.js";
import type { RobovoiceSettings, RobovoiceSettingsStore } from "./settings.js";

export const ROBOVOICE_PROVIDER_ID = "robovoice";

/** Client for the LINKED Robovoice deployment + device, or null when this install isn't linked. */
export function clientFor(store: RobovoiceSettingsStore, fetchImpl?: typeof fetch): RobovoiceClient | null {
  const st = linkState(store);
  if (!st.linked) return null;
  return linkedClient(st.ctx, fetchImpl);
}

export function linkedClient(ctx: LinkedContext, fetchImpl?: typeof fetch): RobovoiceClient {
  return new RobovoiceClient({
    baseUrl: ctx.apiBase,
    deviceId: ctx.deviceId,
    deviceKey: ctx.deviceKey,
    edgeToken: ctx.edgeToken,
    fetchImpl,
  });
}

/** Unauthenticated health probe of a URL (the Connect form's "Test"). Never reads a roster or mints a call. */
export function probeClient(baseUrl: string, fetchImpl?: typeof fetch): RobovoiceClient {
  return new RobovoiceClient({ baseUrl, fetchImpl });
}

/** Effective pipelines of the org characters InfiniBot actually uses (never the deployment's own default). */
export async function relevantPipelines(
  client: RobovoiceClient,
  store: RobovoiceSettingsStore,
  roster?: OrgCharacter[],
): Promise<RobovoicePipeline[]> {
  const s = store.get();
  const ids = new Set<string>(Object.values(s.characterMap));
  for (const ch of Object.values(s.linkedCharacters)) if (ch.characterId) ids.add(ch.characterId);
  if (s.defaultCharacterId) ids.add(s.defaultCharacterId);
  const own = roster ? [...ids].filter((id) => roster.some((c) => c.id === id)) : [...ids];
  const locationId = s.link?.locationId;
  // In parallel: each lookup is a separate robovoice.io round trip (1–5 s).
  const got = await Promise.all(own.slice(0, 12).map((id) => client.pipeline(id, locationId).catch(() => null)));
  return got.filter((p): p is RobovoicePipeline => p !== null);
}

/** Display-only account block for the voice UI (org + location + who answers). */
export function accountOf(s: RobovoiceSettings, characters?: number): VoiceProviderStatus["account"] {
  const link = s.link && !s.link.unlinkedAt ? s.link : undefined;
  if (!link) return undefined;
  const voiceAgents = (s.linkedAgents ?? ["main"]).filter((id) => (s.agentOverrides[id]?.llm ?? "infinibot") === "infinibot");
  return {
    org: link.orgName,
    location: link.locationName ?? link.locationId,
    locationId: link.locationId,
    agents: characters,
    llm: s.mcpPublicUrl && voiceAgents.length ? "InfiniBot" : undefined,
  };
}

/** The InfiniBot agent a session request is for: explicit, else decoded from a `voice-emp_<agent>-<uuid>` room. */
export function agentForRequest(
  s: Pick<RobovoiceSettings, "characterMap" | "linkedCharacters">,
  req: VoiceRealtimeRequest,
): string {
  const explicit = req.agentId?.trim();
  if (explicit) return explicit;
  const encoded = agentFromRoomName(req.room);
  if (encoded) {
    for (const key of [...Object.keys(s.linkedCharacters), ...Object.keys(s.characterMap)]) {
      if (encodeAgentIdForRoom(key) === encoded) return key;
    }
  }
  return "main";
}

export type ProviderOptions = {
  fetchImpl?: typeof fetch;
  statusTtlMs?: number;
  /** Shared org-roster cache (the plugin's RPCs validate against the same one). */
  roster?: OrgRoster;
  /** Edge API for the linked org (tests inject a fake). */
  edgeApi?: (ctx: LinkedContext) => Pick<RobovoiceEdgeApi, "pipelineGet">;
};

export function createRobovoiceProvider(store: RobovoiceSettingsStore, opts: ProviderOptions = {}): VoiceProvider {
  const ttl = opts.statusTtlMs ?? 15_000;
  const roster = opts.roster ?? new OrgRoster();
  const edgeApi =
    opts.edgeApi ??
    ((ctx: LinkedContext) => new RobovoiceEdgeApi(ctx.apiBase, ctx.edgeToken, { fetchImpl: opts.fetchImpl }));
  let cached: { at: number; key: string; status: VoiceProviderStatus } | null = null;

  return {
    id: ROBOVOICE_PROVIDER_ID,
    label: "Robovoice",
    description: "Optional cloud voice on your Robovoice organization: its agents and pipeline. Free; local voice stays the default.",
    capabilities: ["realtime"],

    // Linked to a Robovoice org, or not usable at all (the gateway answers 409 robovoice_not_linked).
    configured: () => isLinked(store),

    async status(): Promise<VoiceProviderStatus> {
      const s = store.get();
      const deployment = s.deployment;
      const st = linkState(store);
      if (!st.linked) return { ready: false, deployment, error: st.message };
      const key = JSON.stringify([s, store.secretState()]);
      if (cached && cached.key === key && Date.now() - cached.at < ttl) return cached.status;
      let status: VoiceProviderStatus;
      try {
        const client = linkedClient(st.ctx, opts.fetchImpl);
        const [health, chars] = await Promise.all([client.health(), roster.get(st.ctx, edgeApi(st.ctx))]);
        const safety = assessRobovoiceSafety(s, await relevantPipelines(client, store, chars));
        const n = chars.length;
        status = {
          ready: health.ok && n > 0,
          deployment,
          detail: `${st.ctx.link.orgName} · ${n} agent${n === 1 ? "" : "s"}`,
          error: !health.ok
            ? `Robovoice health: ${health.status}`
            : n === 0
              ? "Your Robovoice organization has no agents at this location yet."
              : safety.cloudViolation
                ? "Non-commercial model in use on a cloud deployment (see safety labels)."
                : undefined,
          safety: safety.flags,
          account: accountOf(s, n),
        };
      } catch (err) {
        status = {
          ready: false,
          deployment,
          error: err instanceof Error ? err.message : String(err),
          account: accountOf(s),
        };
      }
      cached = { at: Date.now(), key, status };
      return status;
    },

    async createRealtimeSession(req: VoiceRealtimeRequest): Promise<VoiceRealtimeSession> {
      const ctx = requireLinked(store);
      const s = store.get();
      const agentId = agentForRequest(s, req);
      const choice = linkedCharacterFor(s, agentId);
      if (!choice) {
        throw new VoiceProviderError(
          `Agent "${agentId}" has no Robovoice voice in ${ctx.link.orgName} yet — turn it on under Voice → Voice agents.`,
          409,
          "robovoice_no_character",
        );
      }
      const own = assertOrgCharacter(choice.characterId, await roster.get(ctx, edgeApi(ctx)), ctx.link.orgName);
      // Free cloud voice: a busy/limit answer surfaces as cloud_voice_busy (the
      // UI offers a one-click switch to local voice). Never retried elsewhere.
      const details = await linkedClient(ctx, opts.fetchImpl).connectionDetails({
        characterId: own.id,
        locationId: ctx.locationId,
        expressive: s.expressive,
      });
      return {
        url: details.serverUrl,
        token: details.participantToken,
        room: details.roomName,
        participant: details.participantName,
        characterId: own.id,
        characterName: own.name,
      };
    },
  };
}
