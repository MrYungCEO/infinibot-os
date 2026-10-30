/**
 * Agent group chat orchestration.
 *
 * A user message is appended to the group transcript, then a "round" decides
 * who answers (@mentions > mode). Each agent turn runs in that agent's own
 * member session through the normal agent pipeline (so replies stream and
 * tools work), with the group messages it hasn't seen yet as context. Replies
 * are appended to the group transcript with attribution; an agent's
 * @mention hands the floor to another member.
 *
 * Workflows run a DAG of agent steps layer by layer (parallel inside a layer),
 * feeding each step every upstream output; outputs and status land in the
 * group transcript tagged with the run id.
 *
 * Concurrency: rounds are serialized per group; turns are serialized per
 * member session (a member never runs two turns at once). The user can always
 * interject — the message is recorded immediately and answered after the
 * current round, and agents still speaking see it on their next turn.
 */
import { getSecureModeRuntime } from "../../secure-mode/runtime.js";
import { isSecureSessionKey, SECURE_GROUP_PREFIX } from "../../secure-mode/session-key.js";
import { randomUUID } from "node:crypto";

import {
  groupCommandsHelp,
  parseGroupCommand,
  parseModeArg,
  type ParsedGroupCommand,
} from "../../shared/group-chat/commands.js";

import {
  groupChatKey,
  groupMemberKey,
  isGroupChatKey,
  newGroupId,
} from "../../shared/group-chat/keys.js";
import {
  buildStepPrompt,
  buildTurnPrompt,
  handoffsFromReply,
  isPassReply,
  MAX_TURNS_PER_ROUND,
  messageText,
  planRound,
  type GroupMember,
} from "../../shared/group-chat/planner.js";
import { type ToolActivity } from "../../shared/group-chat/activity.js";
import {
  buildGroupMemberContext,
  type GroupContextMember,
  type RepoInfo,
} from "../../shared/group-chat/context.js";
import { checkReplyClaims } from "../../shared/group-chat/truth-guard.js";
import {
  applySettingsPatch,
  effectiveSettings,
  normalizeSettingsPatch,
  pruneMemberSettings,
  type GroupRunSettings,
  type GroupRunSettingsPatch,
} from "../../shared/group-chat/settings.js";
import {
  GROUP_CHAT_MODES,
  type GroupChatBinding,
  type ChatPanelRef,
  type GroupImageBlock,
  type GroupChatEvent,
  type GroupChatMeta,
  type GroupChatMode,
  type GroupTranscriptMessage,
  type WorkflowGraph,
  type WorkflowRunRecord,
} from "../../shared/group-chat/types.js";
import {
  normalizeWorkflow,
  predecessorsOf,
  topologicalLayers,
  validateWorkflow,
} from "../../shared/group-chat/workflow-graph.js";
import { makeGroupMessage, type GroupChatStore, type GroupRecord } from "./store.js";

export type AgentTurnResult = {
  text: string;
  error?: string;
  /** Tool calls the turn made and their real results (shared activity ledger). */
  activity?: ToolActivity[];
  /** Raw tool output text of the turn (URL / fact evidence for the post-check). */
  evidenceText?: string;
  /** Chat panels (show_panel / plugin cards) the run produced. */
  panels?: ChatPanelRef[];
  /** "provider/model" the run used, when known. */
  model?: string;
};

export type AgentTurnRunner = (params: {
  sessionKey: string;
  agentId: string;
  message: string;
  runId: string;
  signal: AbortSignal;
  /** Shared group context block for the member's system prompt. */
  systemPrompt?: string;
  /** Shared repo: cwd of the member's exec/read/write/edit tools. */
  cwd?: string;
  /** Effective model / thinking for this member (member override > group > agent default). */
  settings: GroupRunSettings;
  /** Images the user attached to the message this turn answers. */
  images?: GroupImageBlock[];
}) => Promise<AgentTurnResult>;

/** Per-member settings patches keyed by agent id (`null` drops the override). */
export type MemberSettingsPatch = Record<string, GroupRunSettingsPatch | null>;

export type GroupChatServiceDeps = {
  store: GroupChatStore;
  runTurn: AgentTurnRunner;
  emit: (event: GroupChatEvent) => void;
  /** Called after the transcript/list changed (sessions.changed broadcast). */
  onSessionsChanged?: (key: string, reason: string) => void;
  log?: { warn: (msg: string) => void };
  /** Real git state of a bound workdir (gateway: repo-info.ts). */
  probeRepo?: (dir: string) => RepoInfo;
  /** Roles / tool capabilities of members for the context block. */
  profileMembers?: (members: GroupMember[]) => GroupContextMember[];
  /** Owner display name + time zone for the context block. */
  ownerInfo?: () => { name?: string; timeZone?: string };
  /** Validate a binding patch (gateway: repo-info.ts normalizeBindingPatch). */
  normalizeBinding?: (
    raw: unknown,
    prev: GroupChatBinding | undefined,
  ) => GroupChatBinding | undefined;
  /**
   * Check a settings patch before it is stored (the gateway resolves the model
   * against the catalog/allowlist exactly like sessions.patch). Throw to reject.
   */
  checkSettings?: (patch: GroupRunSettingsPatch, agentId?: string) => Promise<void> | void;
};

export type PostResult = {
  message: GroupTranscriptMessage;
  agents: string[];
  /** Set when the text was a group slash command (handled, not sent to agents). */
  command?: { name: string; ok: boolean; reply: string };
};

const MAX_RUNS_KEPT = 20;
const OUTPUT_PREVIEW_CHARS = 600;
const MAX_MEMBERS = 12;

type GroupRuntime = {
  /** Tail of the serialized round queue. */
  tail: Promise<void>;
  /** Bumped by abort(); queued work from an older generation is dropped. */
  generation: number;
  controllers: Set<AbortController>;
  pendingRounds: number;
  activeTurns: Map<string, { agentId: string; memberKey: string; workflowRunId?: string }>;
};

export class GroupChatError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "INVALID" = "INVALID",
  ) {
    super(message);
  }
}

export class GroupChatService {
  private readonly runtimes = new Map<string, GroupRuntime>();
  private readonly memberLocks = new Map<string, Promise<void>>();

  constructor(private readonly deps: GroupChatServiceDeps) {}

  // ── groups ─────────────────────────────────────────────────────────────

  async createGroup(params: {
    ownerAgentId: string;
    title?: string;
    members: string[];
    mode?: GroupChatMode;
    moderatorId?: string;
    /** Shared repo / project / purpose (raw client input, validated here). */
    binding?: unknown;
    settings?: unknown;
    memberSettings?: unknown;
    /**
     * Secure Mode group: its id gets the secure prefix so every member run is
     * in the secure lane (local models, no network tools, RAM transcripts).
     * The title/binding live in the plaintext session index, so they are
     * replaced with neutral values.
     */
    secure?: boolean;
  }): Promise<GroupRecord> {
    const members = sanitizeMembers(params.members);
    if (params.secure && !getSecureModeRuntime().isUnlocked()) {
      throw new GroupChatError("Turn Secure Mode on before creating a secure group chat");
    }
    const binding = params.secure ? undefined : this.normalizeBinding(params.binding, undefined);
    if (members.length < 1) throw new GroupChatError("Pick at least one agent for the group");
    const mode = GROUP_CHAT_MODES.includes(params.mode as GroupChatMode)
      ? (params.mode as GroupChatMode)
      : "everyone";
    const settingsPatch = this.parseSettings(params.settings);
    const memberPatch = this.parseMemberSettings(params.memberSettings);
    await this.checkAll(settingsPatch, memberPatch);
    const named = this.deps.store.resolveMembers(members);
    const title = params.secure
      ? "Secure group"
      : params.title?.trim().slice(0, 120) ||
        `${named.map((m) => m.name).join(", ")}`.slice(0, 120);
    const key = groupChatKey(
      params.ownerAgentId,
      params.secure ? `${SECURE_GROUP_PREFIX}${newGroupId()}` : newGroupId(),
    );
    const meta: GroupChatMeta = {
      version: 1,
      members,
      mode,
      moderatorId:
        params.moderatorId && members.includes(params.moderatorId)
          ? params.moderatorId
          : members[0],
      rrIndex: 0,
      cursors: {},
      workflows: [],
      runs: [],
      ...(binding ? { binding } : {}),
      createdAt: Date.now(),
    };
    const settings = applySettingsPatch(undefined, settingsPatch);
    if (settings) meta.settings = settings;
    const memberSettings = pruneMemberSettings(
      mergeMemberSettings(undefined, memberPatch),
      members,
    );
    if (memberSettings) meta.memberSettings = memberSettings;
    const rec = await this.deps.store.createGroup(key, title, meta);
    this.deps.onSessionsChanged?.(key, "create");
    return rec;
  }

  getGroup(key: string): GroupRecord {
    if (!isGroupChatKey(key)) throw new GroupChatError("Not a group chat", "NOT_FOUND");
    const rec = this.deps.store.getGroup(key);
    if (!rec) throw new GroupChatError("Group chat not found", "NOT_FOUND");
    return rec;
  }

  private normalizeBinding(
    raw: unknown,
    prev: GroupChatBinding | undefined,
  ): GroupChatBinding | undefined {
    if (raw === undefined) return prev;
    try {
      if (this.deps.normalizeBinding) return this.deps.normalizeBinding(raw, prev);
    } catch (err) {
      throw new GroupChatError(err instanceof Error ? err.message : String(err));
    }
    if (raw === null) return undefined;
    if (typeof raw !== "object") throw new GroupChatError("binding must be an object");
    const r = raw as Record<string, unknown>;
    const next: GroupChatBinding = { ...prev };
    for (const k of ["workdir", "projectId", "projectName", "purpose"] as const) {
      if (!(k in r)) continue;
      const v = r[k];
      if (typeof v === "string" && v.trim()) next[k] = v.trim();
      else delete next[k];
    }
    return Object.keys(next).length ? next : undefined;
  }

  /** System-prompt context block + tool cwd for one member turn. */
  memberContext(rec: GroupRecord, self: GroupMember): { systemPrompt: string; cwd?: string } {
    const members = this.deps.store.resolveMembers(rec.meta.members);
    const profiles = this.deps.profileMembers?.(members) ?? members;
    const selfProfile = profiles.find((m) => m.id === self.id) ?? self;
    const binding = rec.meta.binding;
    const repo =
      binding?.workdir && this.deps.probeRepo ? this.deps.probeRepo(binding.workdir) : null;
    const owner = this.deps.ownerInfo?.() ?? {};
    const systemPrompt = buildGroupMemberContext({
      groupTitle: rec.title,
      self: selfProfile,
      members: profiles,
      binding,
      repo,
      timeZone: owner.timeZone,
      ownerName: owner.name,
    });
    const cwd = binding?.workdir && (!repo || repo.exists) ? binding.workdir : undefined;
    return { systemPrompt, cwd };
  }

  /** Activity other members recorded since the last user message (evidence for relayed claims). */
  private recentGroupActivity(key: string, excludeAgentId: string): ToolActivity[] {
    const all = this.deps.store.readMessages(key);
    const out: ToolActivity[] = [];
    for (let i = all.length - 1; i >= 0 && i >= all.length - 40; i--) {
      const m = all[i];
      if (m.groupChat?.kind === "user") break;
      if (m.groupChat?.agentId === excludeAgentId) continue;
      if (m.groupChat?.activity) out.push(...m.groupChat.activity);
    }
    return out;
  }

  /** Post-check a reply against the turn's real tool results. */
  private reviewReply(
    key: string,
    self: GroupMember,
    prompt: string,
    system: string,
    res: AgentTurnResult,
  ) {
    const unverified = checkReplyClaims({
      reply: res.text,
      own: res.activity,
      groupActivity: this.recentGroupActivity(key, self.id),
      knownText: [system, prompt, res.evidenceText ?? ""].join("\n"),
    });
    return {
      ...(res.activity?.length ? { activity: res.activity } : {}),
      ...(unverified.length ? { unverified } : {}),
    };
  }

  describe(key: string) {
    const rec = this.getGroup(key);
    const rt = this.runtimes.get(key);
    return {
      key,
      title: rec.title,
      members: this.deps.store.resolveMembers(rec.meta.members),
      mode: rec.meta.mode,
      moderatorId: rec.meta.moderatorId ?? rec.meta.members[0],
      settings: rec.meta.settings ?? {},
      memberSettings: rec.meta.memberSettings ?? {},
      effective: Object.fromEntries(
        rec.meta.members.map((id) => [id, effectiveSettings(rec.meta, id)]),
      ),
      workflows: rec.meta.workflows ?? [],
      runs: rec.meta.runs ?? [],
      binding: rec.meta.binding ?? null,
      repo:
        rec.meta.binding?.workdir && this.deps.probeRepo
          ? this.deps.probeRepo(rec.meta.binding.workdir)
          : null,
      busy: Boolean(rt && (rt.pendingRounds > 0 || rt.activeTurns.size > 0)),
      activeTurns: rt ? [...rt.activeTurns.entries()].map(([runId, t]) => ({ runId, ...t })) : [],
      updatedAt: rec.updatedAt,
    };
  }

  async updateGroup(
    key: string,
    patch: {
      title?: string;
      members?: string[];
      mode?: GroupChatMode;
      moderatorId?: string;
      /** Binding patch: fields set to null/"" are cleared; `null` clears the whole binding. */
      binding?: unknown;
      /** Group-wide model / thinking patch (`null` fields clear). */
      settings?: unknown;
      /** Per-member overrides: `{ agentId: patch | null }`. */
      memberSettings?: unknown;
    },
  ): Promise<GroupRecord> {
    if (isSecureSessionKey(key)) {
      // Secure groups keep neutral metadata in the plaintext session index.
      patch = { ...patch, title: undefined, binding: undefined };
    }
    const current = this.getGroup(key);
    const binding =
      patch.binding !== undefined
        ? this.normalizeBinding(patch.binding, current.meta.binding)
        : current.meta.binding;
    const settingsPatch =
      patch.settings === undefined ? undefined : this.parseSettings(patch.settings);
    const memberPatch =
      patch.memberSettings === undefined
        ? undefined
        : this.parseMemberSettings(patch.memberSettings);
    await this.checkAll(settingsPatch ?? {}, memberPatch ?? {});
    const members = patch.members ? sanitizeMembers(patch.members) : undefined;
    if (members && members.length < 1) throw new GroupChatError("A group needs at least one agent");
    if (patch.mode && !GROUP_CHAT_MODES.includes(patch.mode))
      throw new GroupChatError(`Unknown mode ${patch.mode}`);
    const rec = await this.deps.store.updateGroup(key, (meta) => {
      if (members) meta.members = members;
      if (patch.mode) meta.mode = patch.mode;
      if (patch.moderatorId !== undefined) meta.moderatorId = patch.moderatorId;
      if (patch.binding !== undefined) {
        if (binding) meta.binding = binding;
        else delete meta.binding;
      }
      if (!meta.moderatorId || !meta.members.includes(meta.moderatorId))
        meta.moderatorId = meta.members[0];
      if (settingsPatch) {
        const next = applySettingsPatch(meta.settings, settingsPatch);
        if (next) meta.settings = next;
        else delete meta.settings;
      }
      const ms = pruneMemberSettings(
        memberPatch ? mergeMemberSettings(meta.memberSettings, memberPatch) : meta.memberSettings,
        meta.members,
      );
      if (ms) meta.memberSettings = ms;
      else delete meta.memberSettings;
      return { meta, label: patch.title?.trim() ? patch.title.trim().slice(0, 120) : undefined };
    });
    if (!rec) throw new GroupChatError("Group chat not found", "NOT_FOUND");
    this.deps.emit({ type: "meta", groupKey: key });
    this.deps.onSessionsChanged?.(key, "patch");
    return rec;
  }

  /** Record a member's finished background run (verified outcome) in the group transcript. */
  recordMemberRunResult(key: string, agentId: string, text: string): void {
    this.getGroup(key);
    this.appendStatus(key, text.trim().slice(0, 4000), { agentId });
    this.deps.onSessionsChanged?.(key, "message");
  }

  private parseSettings(raw: unknown): GroupRunSettingsPatch {
    try {
      return normalizeSettingsPatch(raw);
    } catch (err) {
      throw new GroupChatError(err instanceof Error ? err.message : String(err));
    }
  }

  private parseMemberSettings(raw: unknown): MemberSettingsPatch {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object" || Array.isArray(raw))
      throw new GroupChatError("memberSettings must be an object keyed by agent id");
    const out: MemberSettingsPatch = {};
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      const agentId = id.trim().toLowerCase();
      if (!agentId) continue;
      out[agentId] = v === null ? null : this.parseSettings(v);
    }
    return out;
  }

  private async checkAll(group: GroupRunSettingsPatch, members: MemberSettingsPatch) {
    const check = this.deps.checkSettings;
    if (!check) return;
    try {
      if (group.model || group.thinkingLevel) await check(group);
      for (const [id, p] of Object.entries(members)) {
        if (p && (p.model || p.thinkingLevel)) await check(p, id);
      }
    } catch (err) {
      if (err instanceof GroupChatError) throw err;
      throw new GroupChatError(err instanceof Error ? err.message : String(err));
    }
  }

  // ── conversation ───────────────────────────────────────────────────────

  /** Record a user message and queue the agents' round. Returns immediately. */
  async postUserMessage(
    key: string,
    text: string,
    opts: { images?: GroupImageBlock[]; attachmentContext?: string } = {},
  ): Promise<PostResult> {
    const rec = this.getGroup(key);
    const body = text.trim();
    const images = (opts.images ?? []).filter((i) => i?.data && i.mimeType);
    if (!body && images.length === 0) throw new GroupChatError("Message is empty");
    if (images.length === 0) {
      const cmd = parseGroupCommand(body, this.deps.store.resolveMembers(rec.meta.members));
      if (cmd) return await this.runCommand(key, body, cmd);
    }
    const message = this.deps.store.appendMessage(
      key,
      makeGroupMessage({
        role: "user",
        text: body,
        images,
        meta: {
          kind: "user",
          ...(opts.attachmentContext ? { attachmentContext: opts.attachmentContext } : {}),
        },
      }),
    );
    this.deps.emit({ type: "message", groupKey: key, message });
    this.deps.onSessionsChanged?.(key, "message");

    const members = this.deps.store.resolveMembers(rec.meta.members);
    const plan = planRound({
      text: body,
      members,
      mode: rec.meta.mode,
      moderatorId: rec.meta.moderatorId,
      rrIndex: rec.meta.rrIndex,
    });
    if (plan.rrIndex !== (rec.meta.rrIndex ?? 0)) {
      await this.deps.store.updateGroup(key, (meta) => {
        meta.rrIndex = plan.rrIndex;
        return { meta };
      });
    }
    const cue = plan.reason === "mention" ? "You were @mentioned by the user." : undefined;
    void this.enqueueRound(key, plan.agents, cue, images.length ? images : undefined);
    return { message, agents: plan.agents };
  }

  /** A group slash command: record it, apply it, answer with a status line. */
  private async runCommand(
    key: string,
    body: string,
    cmd: ParsedGroupCommand,
  ): Promise<PostResult> {
    const message = this.deps.store.appendMessage(
      key,
      makeGroupMessage({ role: "user", text: body, meta: { kind: "user", command: true } }),
    );
    this.deps.emit({ type: "message", groupKey: key, message });
    let ok = true;
    let reply: string;
    try {
      reply = await this.applyCommand(key, cmd);
    } catch (err) {
      ok = false;
      reply = err instanceof Error ? err.message : String(err);
    }
    this.appendStatus(key, reply, { command: true });
    this.deps.onSessionsChanged?.(key, "message");
    return { message, agents: [], command: { name: cmd.name, ok, reply } };
  }

  private async applyCommand(key: string, cmd: ParsedGroupCommand): Promise<string> {
    const rec = this.getGroup(key);
    const who = cmd.agentId
      ? (this.deps.store.resolveMembers([cmd.agentId])[0]?.name ?? cmd.agentId)
      : "every member";
    const settingsFor = (patch: GroupRunSettingsPatch) =>
      cmd.agentId ? { memberSettings: { [cmd.agentId]: patch } } : { settings: patch };
    switch (cmd.name) {
      case "help":
        return groupCommandsHelp();
      case "stop": {
        const { aborted } = this.abort(key);
        return aborted
          ? `Stopped ${aborted} running repl${aborted === 1 ? "y" : "ies"}.`
          : "Nothing was running.";
      }
      case "mode": {
        const mode = parseModeArg(cmd.arg);
        if (!mode) throw new GroupChatError(`Use /mode ${GROUP_CHAT_MODES.join("|")}`);
        await this.updateGroup(key, { mode });
        return `Reply mode: ${mode}.`;
      }
      case "model": {
        if (!cmd.arg) {
          const lines = rec.meta.members.map((id) => {
            const eff = effectiveSettings(rec.meta, id);
            return `@${id}: ${eff.model ?? "agent default"}${eff.source.model === "member" ? " (override)" : ""}`;
          });
          return ["Models:", ...lines].join("\n");
        }
        await this.updateGroup(key, settingsFor({ model: cmd.arg }));
        const model = normalizeSettingsPatch({ model: cmd.arg }).model;
        return `Model for ${who}: ${model ?? "agent default"}.`;
      }
      case "think": {
        if (!cmd.arg) {
          const lines = rec.meta.members.map(
            (id) => `@${id}: ${effectiveSettings(rec.meta, id).thinkingLevel ?? "agent default"}`,
          );
          return ["Thinking:", ...lines].join("\n");
        }
        await this.updateGroup(key, settingsFor({ thinkingLevel: cmd.arg }));
        const level = normalizeSettingsPatch({ thinkingLevel: cmd.arg }).thinkingLevel;
        return `Thinking for ${who}: ${level ?? "agent default"}.`;
      }
    }
    return "Unknown command.";
  }

  private runtime(key: string): GroupRuntime {
    let rt = this.runtimes.get(key);
    if (!rt) {
      rt = {
        tail: Promise.resolve(),
        generation: 0,
        controllers: new Set(),
        pendingRounds: 0,
        activeTurns: new Map(),
      };
      this.runtimes.set(key, rt);
    }
    return rt;
  }

  private enqueueRound(
    key: string,
    agents: string[],
    cue?: string,
    images?: GroupImageBlock[],
  ): Promise<void> {
    const rt = this.runtime(key);
    const gen = rt.generation;
    rt.pendingRounds += 1;
    const run = async () => {
      try {
        if (rt.generation !== gen) return;
        await this.runRound(key, agents, gen, cue, images);
      } catch (err) {
        this.deps.log?.warn(`groupchat round failed (${key}): ${String(err)}`);
      } finally {
        rt.pendingRounds -= 1;
      }
    };
    rt.tail = rt.tail.then(run, run);
    return rt.tail;
  }

  /** Resolves when every queued round/turn for the group has finished (tests, shutdown). */
  async idle(key: string): Promise<void> {
    const rt = this.runtimes.get(key);
    if (!rt) return;
    let prev: Promise<void> | null = null;
    while (prev !== rt.tail) {
      prev = rt.tail;
      await prev;
    }
    await Promise.all(this.memberLocks.values());
  }

  private async runRound(
    key: string,
    initial: string[],
    gen: number,
    cue?: string,
    images?: GroupImageBlock[],
  ): Promise<void> {
    const rt = this.runtime(key);
    const queue = [...initial];
    const cues = new Map<string, string | undefined>(initial.map((id) => [id, cue]));
    let turns = 0;
    this.deps.emit({ type: "round.start", groupKey: key, agents: [...queue] });
    try {
      while (queue.length > 0 && turns < MAX_TURNS_PER_ROUND) {
        if (rt.generation !== gen) return;
        const agentId = queue.shift()!;
        const rec = this.deps.store.getGroup(key);
        if (!rec || !rec.meta.members.includes(agentId)) continue;
        turns += 1;
        const reply = await this.runConversationTurn(key, rec, agentId, cues.get(agentId), images);
        if (!reply || rt.generation !== gen) continue;
        const members = this.deps.store.resolveMembers(rec.meta.members);
        const handoffs = handoffsFromReply({
          reply,
          speakerId: agentId,
          members,
          queued: queue,
          turnsSoFar: turns,
        });
        for (const id of handoffs) {
          queue.push(id);
          const speaker = members.find((m) => m.id === agentId)?.name ?? agentId;
          cues.set(id, `${speaker} handed you the floor with an @mention.`);
        }
      }
    } finally {
      this.deps.emit({ type: "round.end", groupKey: key });
    }
  }

  /** One conversational turn; returns the reply text (null when the agent passed or failed). */
  private async runConversationTurn(
    key: string,
    rec: GroupRecord,
    agentId: string,
    cue?: string,
    images?: GroupImageBlock[],
  ): Promise<string | null> {
    const members = this.deps.store.resolveMembers(rec.meta.members);
    const self = members.find((m) => m.id === agentId) ?? { id: agentId, name: agentId };
    return await this.withMemberLock(groupMemberKey(agentId, groupIdOf(key)), async () => {
      const all = this.deps.store.readMessages(key);
      const cursor = Math.min(
        this.deps.store.getGroup(key)?.meta.cursors?.[agentId] ?? 0,
        all.length,
      );
      const unseen = all
        .slice(cursor)
        .filter((m) => !(m.groupChat?.kind === "agent" && m.groupChat.agentId === agentId))
        // Slash commands configure the group; as context their text would be
        // re-parsed as inline directives (/think, /model) by the agent pipeline.
        .filter((m) => !m.groupChat?.command);
      const prompt = buildTurnPrompt({
        groupTitle: rec.title,
        self,
        members,
        unseen,
        firstTurn: cursor === 0,
        cue,
      });
      const ctx = this.memberContext(this.deps.store.getGroup(key) ?? rec, self);
      const result = await this.executeTurn(key, rec, self, prompt, undefined, ctx, images);
      await this.deps.store.updateGroup(key, (meta) => {
        meta.cursors = { ...meta.cursors, [agentId]: all.length };
        return { meta };
      });
      const review = this.reviewReply(key, self, prompt, ctx.systemPrompt, result);
      if (result.error) {
        this.appendAgentMessage(key, self, `Could not reply: ${result.error}`, {
          error: true,
          ...review,
        });
        return null;
      }
      const extra = {
        panels: result.panels?.length ? result.panels : undefined,
        model: result.model,
      };
      if (isPassReply(result.text)) {
        // Tools ran but the member said nothing: still record what really happened.
        if (review.activity)
          this.appendStatus(key, `${self.name} ran tools without replying.`, {
            agentId: self.id,
            ...review,
          });
        // An agent that only showed a panel still contributed something.
        if (extra.panels) this.appendAgentMessage(key, self, "", { ...review, ...extra });
        return null;
      }
      this.appendAgentMessage(key, self, result.text, { ...review, ...extra });
      return result.text;
    });
  }

  private appendAgentMessage(
    key: string,
    self: GroupMember,
    text: string,
    extra: {
      workflowId?: string;
      workflowRunId?: string;
      stepNodeId?: string;
      error?: boolean;
      activity?: ToolActivity[];
      unverified?: ReturnType<typeof checkReplyClaims>;
      panels?: ChatPanelRef[];
      model?: string;
    } = {},
  ): GroupTranscriptMessage {
    const message = this.deps.store.appendMessage(
      key,
      makeGroupMessage({
        role: "assistant",
        text,
        meta: { kind: "agent", agentId: self.id, agentName: self.name, ...dropUndefined(extra) },
      }),
    );
    this.deps.emit({ type: "message", groupKey: key, message });
    this.deps.onSessionsChanged?.(key, "message");
    return message;
  }

  private appendStatus(
    key: string,
    text: string,
    extra: {
      workflowId?: string;
      workflowRunId?: string;
      agentId?: string;
      activity?: ToolActivity[];
      unverified?: ReturnType<typeof checkReplyClaims>;
      command?: boolean;
    } = {},
  ) {
    const message = this.deps.store.appendMessage(
      key,
      makeGroupMessage({ role: "assistant", text, meta: { kind: "status", ...extra } }),
    );
    this.deps.emit({ type: "message", groupKey: key, message });
  }

  private async executeTurn(
    key: string,
    rec: GroupRecord,
    self: GroupMember,
    prompt: string,
    workflowRunId?: string,
    ctx?: { systemPrompt: string; cwd?: string },
    images?: GroupImageBlock[],
  ): Promise<AgentTurnResult> {
    const rt = this.runtime(key);
    const memberKey = groupMemberKey(self.id, groupIdOf(key));
    const runId = `gc-${randomUUID()}`;
    const controller = new AbortController();
    rt.controllers.add(controller);
    rt.activeTurns.set(runId, { agentId: self.id, memberKey, workflowRunId });
    this.deps.emit({
      type: "turn.start",
      groupKey: key,
      agentId: self.id,
      memberKey,
      runId,
      workflowRunId,
    });
    let ok = false;
    try {
      await this.deps.store
        .ensureMemberSession(memberKey, `${rec.title} · ${self.name}`)
        .catch((err) =>
          this.deps.log?.warn(`groupchat member session label failed: ${String(err)}`),
        );
      // Settings are read fresh: a /model or picker change applies to the very next turn.
      const latest = this.deps.store.getGroup(key)?.meta ?? rec.meta;
      const { source: _source, ...settings } = effectiveSettings(latest, self.id);
      const res = await this.deps.runTurn({
        sessionKey: memberKey,
        agentId: self.id,
        message: prompt,
        runId,
        signal: controller.signal,
        ...(ctx ? { systemPrompt: ctx.systemPrompt, ...(ctx.cwd ? { cwd: ctx.cwd } : {}) } : {}),
        settings,
        ...(images?.length ? { images } : {}),
      });
      if (controller.signal.aborted) return { text: "", error: "stopped" };
      ok = !res.error;
      return res;
    } catch (err) {
      if (controller.signal.aborted) return { text: "", error: "stopped" };
      return { text: "", error: err instanceof Error ? err.message : String(err) };
    } finally {
      rt.controllers.delete(controller);
      rt.activeTurns.delete(runId);
      this.deps.emit({ type: "turn.end", groupKey: key, agentId: self.id, runId, ok });
    }
  }

  private async withMemberLock<T>(memberKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.memberLocks.get(memberKey) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.memberLocks.set(memberKey, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.memberLocks.get(memberKey) === tail) this.memberLocks.delete(memberKey);
    }
  }

  /** Stop every running turn and drop queued rounds/workflow steps for the group. */
  abort(key: string): { aborted: number } {
    const rt = this.runtimes.get(key);
    if (!rt) return { aborted: 0 };
    rt.generation += 1;
    const n = rt.controllers.size;
    for (const c of rt.controllers) c.abort();
    return { aborted: n };
  }

  // ── workflows ──────────────────────────────────────────────────────────

  async saveWorkflow(key: string, raw: unknown): Promise<WorkflowGraph> {
    this.getGroup(key);
    const wf = normalizeWorkflow(raw);
    // Drafts may be saved incomplete (no steps yet, an agent not in the group);
    // only a structurally broken graph is rejected. startWorkflow validates fully.
    try {
      topologicalLayers(wf);
    } catch (err) {
      throw new GroupChatError(err instanceof Error ? err.message : String(err));
    }
    await this.deps.store.updateGroup(key, (meta) => {
      const list = (meta.workflows ?? []).filter((w) => w.id !== wf.id);
      meta.workflows = [...list, wf];
      return { meta };
    });
    this.deps.emit({ type: "meta", groupKey: key });
    return wf;
  }

  async deleteWorkflow(key: string, workflowId: string): Promise<void> {
    this.getGroup(key);
    await this.deps.store.updateGroup(key, (meta) => {
      meta.workflows = (meta.workflows ?? []).filter((w) => w.id !== workflowId);
      return { meta };
    });
    this.deps.emit({ type: "meta", groupKey: key });
  }

  /** Validate + start a workflow run; resolves with the run record once started (`done` resolves at the end). */
  async startWorkflow(
    key: string,
    workflowId: string,
    input: string,
    opts: { images?: GroupImageBlock[] } = {},
  ): Promise<{ run: WorkflowRunRecord; done: Promise<WorkflowRunRecord> }> {
    const images = (opts.images ?? []).filter((i) => i?.data && i.mimeType);
    const rec = this.getGroup(key);
    const wf = (rec.meta.workflows ?? []).find((w) => w.id === workflowId);
    if (!wf) throw new GroupChatError("Workflow not found", "NOT_FOUND");
    const check = validateWorkflow(wf, { members: rec.meta.members });
    if (!check.valid) throw new GroupChatError(check.errors.join("; "));
    const layers = topologicalLayers(wf);
    const run: WorkflowRunRecord = {
      id: `run-${randomUUID().slice(0, 12)}`,
      workflowId: wf.id,
      workflowName: wf.name,
      status: "running",
      input: input.trim(),
      startedAt: Date.now(),
      steps: layers.flatMap((layer, i) =>
        layer.map((n) => ({
          nodeId: n.id,
          agentId: n.agentId,
          label: n.label,
          status: "pending" as const,
          layer: i,
        })),
      ),
    };
    await this.saveRun(key, run);
    if (run.input || images.length) {
      const message = this.deps.store.appendMessage(
        key,
        makeGroupMessage({
          role: "user",
          text: run.input,
          images,
          meta: { kind: "user", workflowId: wf.id, workflowRunId: run.id },
        }),
      );
      this.deps.emit({ type: "message", groupKey: key, message });
    }
    this.appendStatus(
      key,
      `Workflow "${wf.name}" started — ${run.steps.length} step${run.steps.length === 1 ? "" : "s"} in ${layers.length} stage${layers.length === 1 ? "" : "s"}.`,
      { workflowId: wf.id, workflowRunId: run.id },
    );
    const done = this.executeWorkflow(key, rec, wf, run, images.length ? images : undefined);
    return { run: structuredClone(run), done };
  }

  private async executeWorkflow(
    key: string,
    rec: GroupRecord,
    wf: WorkflowGraph,
    run: WorkflowRunRecord,
    images?: GroupImageBlock[],
  ): Promise<WorkflowRunRecord> {
    const rt = this.runtime(key);
    const gen = rt.generation;
    const members = this.deps.store.resolveMembers(rec.meta.members);
    const memberOf = (id: string): GroupMember =>
      members.find((m) => m.id === id) ?? { id, name: id };
    const outputs = new Map<string, string>();
    const layers = topologicalLayers(wf);
    const total = run.steps.length;
    let index = 0;
    try {
      for (const layer of layers) {
        if (rt.generation !== gen) throw new AbortedRun();
        const results = await Promise.all(
          layer.map(async (node) => {
            const stepNo = ++index;
            const step = run.steps.find((s) => s.nodeId === node.id)!;
            const self = memberOf(node.agentId);
            const label = node.label?.trim() || `${self.name} step`;
            const upstream = predecessorsOf(wf, node.id).map((pid) => {
              const pn = wf.nodes.find((n) => n.id === pid)!;
              return {
                label: pn.label?.trim() || `${memberOf(pn.agentId).name} step`,
                agent: memberOf(pn.agentId),
                output: outputs.get(pid) ?? "",
              };
            });
            const prompt = buildStepPrompt({
              groupTitle: rec.title,
              workflowName: wf.name,
              self,
              stepLabel: label,
              stepPrompt: node.prompt ?? "",
              input: run.input,
              upstream,
              stepIndex: stepNo,
              stepCount: total,
            });
            step.status = "running";
            step.startedAt = Date.now();
            await this.saveRun(key, run);
            const ctx = this.memberContext(this.deps.store.getGroup(key) ?? rec, self);
            const res: AgentTurnResult = await this.withMemberLock(
              groupMemberKey(node.agentId, groupIdOf(key)),
              () =>
                rt.generation !== gen
                  ? Promise.resolve({ text: "", error: "stopped" })
                  : this.executeTurn(key, rec, self, prompt, run.id, ctx, images),
            );
            const review = this.reviewReply(key, self, prompt, ctx.systemPrompt, res);
            step.endedAt = Date.now();
            if (res.error) {
              step.status = "error";
              step.error = res.error;
              this.appendAgentMessage(key, self, `${label} failed: ${res.error}`, {
                workflowId: wf.id,
                workflowRunId: run.id,
                stepNodeId: node.id,
                error: true,
                ...review,
              });
              return false;
            }
            const text = isPassReply(res.text) ? "" : res.text.trim();
            outputs.set(node.id, text);
            step.status = "done";
            step.output =
              text.length > OUTPUT_PREVIEW_CHARS
                ? `${text.slice(0, OUTPUT_PREVIEW_CHARS - 1)}…`
                : text;
            this.appendAgentMessage(key, self, text || (res.panels?.length ? "" : "(no output)"), {
              workflowId: wf.id,
              workflowRunId: run.id,
              stepNodeId: node.id,
              ...review,
              panels: res.panels?.length ? res.panels : undefined,
              model: res.model,
            });
            await this.saveRun(key, run);
            return true;
          }),
        );
        if (results.some((ok) => !ok)) {
          if (rt.generation !== gen) throw new AbortedRun();
          throw new Error("a step failed");
        }
      }
      run.status = "done";
      run.endedAt = Date.now();
      this.appendStatus(
        key,
        `Workflow "${wf.name}" finished — ${total} step${total === 1 ? "" : "s"} done.`,
        {
          workflowId: wf.id,
          workflowRunId: run.id,
        },
      );
    } catch (err) {
      const aborted = err instanceof AbortedRun || rt.generation !== gen;
      run.status = aborted ? "aborted" : "error";
      run.endedAt = Date.now();
      run.error = aborted ? "Stopped" : err instanceof Error ? err.message : String(err);
      for (const s of run.steps)
        if (s.status === "pending" || s.status === "running") s.status = "skipped";
      this.appendStatus(
        key,
        aborted ? `Workflow "${wf.name}" stopped.` : `Workflow "${wf.name}" failed: ${run.error}.`,
        { workflowId: wf.id, workflowRunId: run.id },
      );
    }
    await this.saveRun(key, run);
    return structuredClone(run);
  }

  private async saveRun(key: string, run: WorkflowRunRecord): Promise<void> {
    const snapshot = structuredClone(run);
    await this.deps.store.updateGroup(key, (meta) => {
      const runs = (meta.runs ?? []).filter((r) => r.id !== run.id);
      meta.runs = [...runs, snapshot].slice(-MAX_RUNS_KEPT);
      return { meta };
    });
    this.deps.emit({ type: "workflow", groupKey: key, run: snapshot });
  }

  /** Text of a transcript message (exported for handlers). */
  static text(msg: GroupTranscriptMessage): string {
    return messageText(msg);
  }
}

class AbortedRun extends Error {
  constructor() {
    super("stopped");
  }
}

function dropUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function mergeMemberSettings(
  base: Record<string, GroupRunSettings> | undefined,
  patch: MemberSettingsPatch,
): Record<string, GroupRunSettings> | undefined {
  const out: Record<string, GroupRunSettings> = { ...base };
  for (const [id, p] of Object.entries(patch)) {
    const next = p === null ? undefined : applySettingsPatch(out[id], p);
    if (next) out[id] = next;
    else delete out[id];
  }
  return Object.keys(out).length ? out : undefined;
}

function groupIdOf(key: string): string {
  const m = /:groupchat-(.+)$/.exec(key);
  if (!m) throw new GroupChatError("Not a group chat", "NOT_FOUND");
  return m[1];
}

function sanitizeMembers(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = raw.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_MEMBERS) break;
  }
  return out;
}
