/**
 * Quickstart RPC handlers — read/write helpers the new web onboarding UI
 * needs. Designed so the UI never has to know about clack/TUI prompts; it
 * just calls these methods to get a snapshot, applies changes, and reads
 * back.
 *
 * Naming convention: `quickstart.<step>.<action>`. Steps mirror the
 * onboarding flow: status, auth, channels, models, gateway, hooks,
 * federation, finalize.
 *
 * The Notion step has its own namespace (`notion.wizard.*`) — see
 * `notion-wizard.ts`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function resolveInstalledRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
import { loadConfig, readConfigFileSnapshot, writeConfigFile } from "../../config/io.js";
import { sanitizeMergedConfig } from "../../config/sanitize.js";
import { describeKanbanState, resolveKanbanDatabase } from "../../databases/kanban-store-ops.js";
import { migrateLegacyNotionKanban } from "../../databases/notion-kanban-migration.js";
import {
  getStatus as getNotionStatus,
  listAccessibleDatabases,
} from "../../databases/notion-wizard.js";
import { getNotionConfig } from "../../databases/notion-config.js";
import { importFromNotion } from "../../databases/notion-import.js";
import { getDatabasesStore } from "../../databases/store.js";
import {
  DEFAULT_CLOUD_CONFIG,
  DEFAULT_NATIVE_CONFIG,
  VOICE_SIGNUP_URLS,
  buildVoiceCatalog,
  isVoiceConfigured as isVoiceStackConfigured,
  loadVoiceConfig,
  normalizeVoiceConfig,
  resolveSttApiKey,
  resolveTtsApiKey,
  saveVoiceConfig,
} from "../voice/config.js";
import { probeVoiceRuntime } from "../voice/runtime-status.js";
import { ensureVoiceStackHealthy } from "../voice/docker-manager.js";
import type { SelectOption } from "../../databases/types.js";
import type { GatewayRequestHandlers } from "./types.js";

interface KanbanOptionEdit {
  /** Option name as displayed. Required. */
  name: string;
  /** Hex color "#rrggbb". Optional — falls back to a neutral grey. */
  color?: string;
  /** Stable id; auto-assigned when missing so renames don't lose existing rows. */
  id?: string;
}

interface QuickstartStatus {
  version: string;
  hasConfig: boolean;
  steps: Array<{
    id: string;
    label: string;
    state: "pending" | "complete" | "skipped";
    summary?: string;
  }>;
  /**
   * Re-hydration payload for the Models step — the saved primary model choice
   * derived from `agents.defaults.model.primary` plus the matching provider
   * block. The web UI uses this to repopulate the form on revisit so users
   * don't see an empty form after a successful save. `apiKey` is intentionally
   * omitted; only `hasApiKey` is exposed so secrets never travel back.
   */
  modelChoice: {
    primary: string;
    provider: string;
    model: string;
    hasApiKey: boolean;
    baseUrl?: string;
    endpoint?: string;
  } | null;
  notion: Awaited<ReturnType<typeof getNotionStatus>>;
  kanban: ReturnType<typeof describeKanbanState>;
  /**
   * Re-hydration payload for the Gateway step. The wizard form needs port,
   * bind, and auth mode to repopulate after revisit. We expose only
   * `hasPassword` (not the password itself) so a saved password is never
   * round-tripped to the browser; the form clears the input but shows a
   * "saved" hint instead.
   */
  gateway: {
    port: number | null;
    bind: string | null;
    authMode: "token" | "password" | null;
    hasPassword: boolean;
    hasToken: boolean;
  };
  /**
   * Re-hydration payload for the Channels step. The wizard form needs to
   * round-trip enabled/policy/allowlist values so a revisit doesn't reset
   * the user's allowlist to empty. Tokens are surfaced as `hasToken` only
   * (the value never travels back to the browser).
   */
  channels: Record<
    string,
    {
      enabled: boolean;
      hasToken: boolean;
      dmPolicy?: string;
      groupPolicy?: string;
      allowFrom: string[];
      groupAllowFrom: string[];
    }
  >;
  /**
   * Re-hydration payload for the Federation step. Lets the wizard detect
   * "this device is already configured as a satellite" on revisit and
   * switch the downstream steps into read-only / mirrored mode without
   * re-running the pairing flow.
   */
  federation: {
    mode: "standalone" | "master" | "satellite" | null;
    masterUrl: string | null;
  };
}

export const quickstartHandlers: GatewayRequestHandlers = {
  /**
   * Snapshot — drives the entry screen of the web UI. Tells the user which
   * steps are already complete so we can skip them on re-runs.
   */
  "quickstart.status": async ({ respond }) => {
    try {
      const config = loadConfig();
      const notion = await getNotionStatus();
      const kanban = describeKanbanState();

      const modelChoice = deriveModelChoice(config);
      const primaryConfigured = Boolean(modelChoice?.primary);

      const steps: QuickstartStatus["steps"] = [
        deriveStep("auth", "Auth", () => primaryConfigured),
        deriveStep("models", "Models", () => primaryConfigured),
        deriveStep("gateway", "Gateway", () => Boolean((config.gateway as any)?.port)),
        deriveStep(
          "channels",
          "Channels",
          () => countActiveChannels(config) > 0,
          () => `${countActiveChannels(config)} channel(s) configured`,
        ),
        deriveStep(
          "hooks",
          "Hooks",
          () =>
            Array.isArray((config.hooks as any)?.internal?.entries) &&
            (config.hooks as any).internal.entries.length > 0,
        ),
        deriveStep(
          "voice",
          "Voice",
          () => isVoiceStackConfigured(),
          () => {
            const v = loadVoiceConfig();
            return v ? `${v.mode}: ${v.stt.provider}/${v.tts.provider}` : "not configured";
          },
        ),
        deriveStep("federation", "Federation", () => Boolean((config.federation as any)?.mode)),
        deriveStep(
          "notion",
          "Notion sync",
          () => notion.configured,
          () =>
            notion.configured
              ? `${notion.syncMode} mode${notion.reachable === false ? " — unreachable" : ""}`
              : "optional",
        ),
        deriveStep(
          "kanban",
          "Kanban",
          () => true,
          () =>
            `Local SQLite${kanban.notionConfigured ? " + Notion sync" : ""} (${kanban.syncMode})`,
        ),
      ];

      const gw = (config.gateway as Record<string, unknown> | undefined) ?? {};
      const gwAuth = (gw.auth as Record<string, unknown> | undefined) ?? {};
      const authModeRaw = gwAuth.mode;
      const channels = summarizeChannelsForWizard(config);
      const fed = (config.federation as Record<string, unknown> | undefined) ?? {};
      const fedModeRaw = fed.mode;
      const status: QuickstartStatus = {
        version: (config as any)?.version ?? "dev",
        hasConfig: Object.keys(config).length > 0,
        steps,
        modelChoice,
        notion,
        kanban,
        gateway: {
          port: typeof gw.port === "number" ? gw.port : null,
          bind: typeof gw.bind === "string" ? gw.bind : null,
          authMode: authModeRaw === "token" || authModeRaw === "password" ? authModeRaw : null,
          // Surface only presence — never the value. The Gateway form uses this
          // to render "A password is already saved. Leave blank to keep it."
          hasPassword: typeof gwAuth.password === "string" && gwAuth.password.length > 0,
          hasToken: typeof gwAuth.token === "string" && gwAuth.token.length > 0,
        },
        channels,
        federation: {
          mode:
            fedModeRaw === "master" || fedModeRaw === "satellite" || fedModeRaw === "standalone"
              ? fedModeRaw
              : null,
          masterUrl: typeof fed.masterUrl === "string" ? fed.masterUrl : null,
        },
      };

      respond(true, status);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Apply a free-form config patch — used by the channel/model/gateway/hooks
   * steps to write their captured values without each step needing its own
   * RPC. The UI sends the partial update and we deep-merge into the existing
   * config.
   */
  "quickstart.applyPatch": async ({ params, respond }) => {
    try {
      const patch = (params.patch as Record<string, unknown>) ?? {};
      if (typeof patch !== "object" || patch === null) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "patch must be an object" });
        return;
      }
      // Read raw on-disk config rather than loadConfig(): loadConfig returns {}
      // when validation/env-substitution fails (see io.ts loadConfig catch),
      // and round-tripping that empty object through writeConfigFile silently
      // wipes top-level blocks the user has set (notion, channels, etc).
      const current = await readRawBaseConfig();
      const merged = deepMerge(current, patch);
      // Self-heal known schema requirements that strict validators reject when
      // a previous quickstart attempt wrote partial state. Each provider entry
      // under models.providers must have a `models` array; backfill an empty
      // one when missing so validation passes.
      sanitizeMergedConfig(merged);
      await writeConfigFile(merged as never);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Voice step — initial render payload. Returns the provider catalog (with
   * per-provider env-key detection + the current redacted config) plus the
   * signup URLs and the cloud/native defaults so the wizard never has to
   * hardcode provider metadata. Mirrors `voice up` in src/cli/voice-cli.ts;
   * both read from the single source of truth in src/gateway/voice/config.ts.
   */
  "quickstart.voice.get": async ({ respond }) => {
    try {
      respond(true, {
        catalog: buildVoiceCatalog(),
        signupUrls: VOICE_SIGNUP_URLS,
        defaults: { cloud: DEFAULT_CLOUD_CONFIG, native: DEFAULT_NATIVE_CONFIG },
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Voice step — persist the chosen stack to ~/.infinibot/voice.json. Reuses
   * `normalizeVoiceConfig` + `saveVoiceConfig` (the exact helpers the CLI's
   * `voice up` / `voice set` use) so there is no duplicated config-writing
   * logic between the CLI and the wizard. For the cloud path we require a
   * resolvable API key (config value OR provider env var) for each non-native
   * provider before writing, matching the CLI wizard's validation.
   */
  "quickstart.voice.save": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        mode?: string;
        sttProvider?: string;
        ttsProvider?: string;
        sttKey?: string;
        ttsKey?: string;
        sttModel?: string;
        ttsVoice?: string;
      };
      const trim = (v: unknown): string | undefined =>
        typeof v === "string" && v.trim() ? v.trim() : undefined;
      // normalizeVoiceConfig fills provider/model/voice defaults and clamps the
      // mode to cloud|native|docker, so partial input from the wizard is safe.
      const cfg = normalizeVoiceConfig({
        mode: p.mode,
        stt: { provider: p.sttProvider, model: p.sttModel, apiKey: trim(p.sttKey) },
        tts: { provider: p.ttsProvider, voice: p.ttsVoice, apiKey: trim(p.ttsKey) },
      });
      if (cfg.mode === "cloud") {
        const missing: string[] = [];
        if (cfg.stt.provider !== "native" && !resolveSttApiKey(cfg.stt)) {
          missing.push(`${cfg.stt.provider} (speech-to-text)`);
        }
        if (cfg.tts.provider !== "native" && !resolveTtsApiKey(cfg.tts)) {
          missing.push(`${cfg.tts.provider} (text-to-speech)`);
        }
        if (missing.length > 0) {
          respond(false, undefined, {
            code: "MISSING_KEY",
            message: `An API key is required for: ${missing.join(", ")}.`,
          });
          return;
        }
      }
      saveVoiceConfig(cfg);

      // Docker mode: actually PROVISION the local stack as part of the save so
      // the wizard's "save" == "it's running". ensureVoiceStackHealthy preflights
      // GPU/creds, starts only host-runnable core services, and awaits health —
      // so a non-GPU host comes up with Kokoro (TTS) and reports Speaches (STT)
      // as needing a GPU rather than hanging. Best-effort; failures surface as
      // warnings, never block the save.
      let docker: Awaited<ReturnType<typeof ensureVoiceStackHealthy>> | undefined;
      const dockerWarnings: string[] = [];
      if (cfg.mode === "docker") {
        docker = await ensureVoiceStackHealthy();
        if (docker.skippedReason) dockerWarnings.push(`Docker voice: ${docker.skippedReason}`);
        for (const u of docker.unhealthy) dockerWarnings.push(`Docker ${u.name}: ${u.reason}`);
      }

      // One-shot readiness probe so the wizard never leaves the user with a
      // silently-broken stack. Surfaces warnings (e.g. chosen docker container
      // not running, native binary missing) the Done summary can show.
      const runtime = await probeVoiceRuntime();
      const warnings: string[] = [...dockerWarnings];
      if (!runtime.stt.reachable) warnings.push(`STT: ${runtime.stt.detail}`);
      if (!runtime.tts.reachable) warnings.push(`TTS: ${runtime.tts.detail}`);
      // Echo back the redacted current config (keys collapsed to booleans).
      respond(true, { current: buildVoiceCatalog().current, runtime, docker, warnings });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Run the legacy Notion → local kanban migration. Idempotent and safe to
   * re-run; a no-op when there's no legacy data or no Notion key.
   */
  "quickstart.migrateLegacyNotion": async ({ respond }) => {
    try {
      const result = await migrateLegacyNotionKanban();
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * List Notion databases the configured integration can see, flagging the
   * ones that are already system-managed (Projects, Tasks, CRM). The wizard
   * uses this to power its "Import additional Notion databases" picker so
   * users can pull existing personal/team databases into the InfiniBot
   * synced store without duplicating the system ones we just created.
   */
  "quickstart.notion.listDatabases": async ({ params, respond }) => {
    try {
      const apiKeyParam = typeof params.apiKey === "string" ? params.apiKey : "";
      const apiKey = apiKeyParam || getNotionConfig().apiKey || "";
      if (!apiKey) {
        respond(false, undefined, {
          code: "NOT_CONFIGURED",
          message: "Notion API key not configured — finish the Notion step first.",
        });
        return;
      }
      const cfg = getNotionConfig();
      const managed = [
        cfg.projectsDbId,
        cfg.tasksDbId,
        cfg.clientsDbId,
        cfg.leadsDbId,
        cfg.companiesDbId,
        cfg.dealsDbId,
        cfg.contactsDbId,
      ].filter((x): x is string => typeof x === "string" && x.length > 0);
      const databases = await listAccessibleDatabases(apiKey, managed);
      respond(true, { databases });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Import a set of Notion databases into the local SQLite store as
   * `notion-import` source databases. Pass-through to `importFromNotion`
   * so the wizard reuses the same code path the agent tools and the
   * `db.import.notion` RPC use.
   */
  "quickstart.notion.import": async ({ params, respond }) => {
    try {
      const apiKeyParam = typeof params.apiKey === "string" ? params.apiKey : "";
      const apiKey = apiKeyParam || getNotionConfig().apiKey || "";
      if (!apiKey) {
        respond(false, undefined, {
          code: "NOT_CONFIGURED",
          message: "Notion API key not configured — finish the Notion step first.",
        });
        return;
      }
      const databaseIds = Array.isArray(params.databaseIds)
        ? (params.databaseIds as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined;
      const store = getDatabasesStore();
      const report = await importFromNotion(store, { apiKey, databaseIds });
      respond(true, report);
    } catch (e) {
      respond(false, undefined, { code: "IMPORT_FAILED", message: String(e) });
    }
  },

  /**
   * Read the current customizable kanban settings — the option lists for
   * Status and Priority on both the Projects and Tasks databases. Used by
   * the wizard's Kanban step to render an editor.
   */
  "quickstart.kanban.getSettings": async ({ respond }) => {
    try {
      const projects = resolveKanbanDatabase("projects");
      const tasks = resolveKanbanDatabase("tasks");
      const projectProps = projects.store.listProperties(projects.database.id);
      const taskProps = tasks.store.listProperties(tasks.database.id);
      const optionsOf = (
        props: Array<{ name: string; config: { options?: SelectOption[] } | null }>,
        name: string,
      ) => {
        const lower = name.toLowerCase();
        const p = props.find((x) => x.name.toLowerCase() === lower);
        return (p?.config?.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color }));
      };
      respond(true, {
        projects: {
          databaseId: projects.database.id,
          name: projects.database.name,
          status: optionsOf(projectProps, "Status"),
          priority: optionsOf(projectProps, "Priority"),
        },
        tasks: {
          databaseId: tasks.database.id,
          name: tasks.database.name,
          status: optionsOf(taskProps, "Status"),
          priority: optionsOf(taskProps, "Priority"),
        },
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Apply edited option lists to the kanban Status and Priority properties.
   * Existing option ids are preserved when the caller passes them back so
   * rows referencing those options keep working after a rename. New entries
   * (no id) get a fresh slugified id.
   */
  "quickstart.kanban.saveSettings": async ({ params, respond }) => {
    try {
      const sections = params as {
        projects?: { status?: KanbanOptionEdit[]; priority?: KanbanOptionEdit[] };
        tasks?: { status?: KanbanOptionEdit[]; priority?: KanbanOptionEdit[] };
      };
      const apply = (
        role: "projects" | "tasks",
        statusEdits: KanbanOptionEdit[] | undefined,
        priorityEdits: KanbanOptionEdit[] | undefined,
      ) => {
        const { store, database } = resolveKanbanDatabase(role);
        const props = store.listProperties(database.id);
        const writeProperty = (name: string, edits: KanbanOptionEdit[] | undefined) => {
          if (!Array.isArray(edits)) return;
          const lower = name.toLowerCase();
          const prop = props.find((x) => x.name.toLowerCase() === lower);
          if (!prop) return;
          const options: SelectOption[] = [];
          for (const e of edits) {
            const cleanName = (e?.name ?? "").trim();
            if (!cleanName) continue;
            const opt: SelectOption = {
              id: e?.id || stableOptionId(cleanName),
              name: cleanName,
            };
            if (typeof e?.color === "string" && e.color) opt.color = e.color;
            options.push(opt);
          }
          store.updateProperty(prop.id, {
            config: { ...prop.config, options },
          });
        };
        writeProperty("Status", statusEdits);
        writeProperty("Priority", priorityEdits);
      };
      apply("projects", sections.projects?.status, sections.projects?.priority);
      apply("tasks", sections.tasks?.status, sections.tasks?.priority);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Build the InfiniBot control UI (`pnpm ui:build` → `dist/control-ui/`).
   * Called from the wizard's "All done" screen so users land in the working
   * UI instead of a 404 the first time. Idempotent: when the UI is already
   * built and `force` is not set, returns immediately so re-finalizing is
   * cheap. Streams nothing — the UI shows a spinner while we wait.
   */
  "quickstart.buildUi": async ({ params, respond }) => {
    try {
      const force = params.force === true;
      const repoRoot = resolveInstalledRepoRoot();
      const builtIndex = path.join(repoRoot, "dist", "control-ui", "index.html");
      if (!force && fs.existsSync(builtIndex)) {
        respond(true, { ok: true, alreadyBuilt: true, outDir: path.dirname(builtIndex) });
        return;
      }
      const canBuild =
        fs.existsSync(path.join(repoRoot, "ui", "package.json")) &&
        fs.existsSync(path.join(repoRoot, "scripts", "ui.js"));
      if (!canBuild) {
        if (fs.existsSync(builtIndex)) {
          respond(true, { ok: true, alreadyBuilt: true, outDir: path.dirname(builtIndex) });
          return;
        }
        respond(false, undefined, {
          code: "BUILD_UNAVAILABLE",
          message:
            "Control UI sources are not present in this install (npm package) and prebuilt assets at " +
            builtIndex +
            " are missing. Reinstall a release that includes dist/control-ui, or run from a source checkout.",
        });
        return;
      }
      await runUiBuild(repoRoot);
      respond(true, { ok: true, alreadyBuilt: false, outDir: path.dirname(builtIndex) });
    } catch (e) {
      respond(false, undefined, {
        code: "BUILD_FAILED",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Mark the wizard finalized — emits a one-shot config flag the desktop
   * apps and CLI watch for so they know to swap from setup mode to normal.
   */
  /**
   * Post-save verification. The wizard calls this after any step that writes
   * to disk so it can show a clear "Active" / "Needs restart" / "Save failed"
   * status to non-technical users instead of asking them to read gateway logs.
   *
   * - `liveAuthSupported: true` is the marker that this gateway has the
   *   per-connection auth re-resolve. If the wizard sees the field missing
   *   from the response shape (older gateway), it knows a restart is needed.
   * - `configReadable` / `validationOk` tell the UI whether the on-disk config
   *   parses + passes strict validation; when it doesn't, every reader in the
   *   gateway falls back to the raw parse instead of {} — but the user should
   *   still know which field broke.
   * - `notion.configured` and `gateway.*` mirror what every other reader sees
   *   from `loadConfig`, so the UI can confirm "your notion DBs are saved and
   *   visible to the gateway, not just to your config file."
   */
  "quickstart.verify": async ({ respond }) => {
    try {
      const snapshot = await readConfigFileSnapshot();
      const cfg = loadConfig() as Record<string, unknown>;
      const gw = (cfg.gateway as Record<string, unknown> | undefined) ?? {};
      const auth = (gw.auth as Record<string, unknown> | undefined) ?? {};
      const authMode = auth.mode === "token" || auth.mode === "password" ? auth.mode : null;
      const notion = await getNotionStatus();
      respond(true, {
        liveAuthSupported: true,
        configReadable: snapshot.exists && snapshot.parsed != null,
        validationOk: snapshot.valid,
        validationIssues: snapshot.issues,
        gateway: {
          authMode,
          hasPassword: typeof auth.password === "string" && auth.password.length > 0,
          hasToken: typeof auth.token === "string" && auth.token.length > 0,
          port: typeof gw.port === "number" ? gw.port : null,
          bind: typeof gw.bind === "string" ? gw.bind : null,
        },
        notion: {
          configured: notion.configured,
          syncMode: notion.syncMode,
          reachable: notion.reachable ?? null,
        },
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * One-click "restart the gateway" exposed to the wizard. Exits the gateway
   * process; the daemon watchdog (when running) brings it back up, and the
   * wizard's existing 2s auto-reconnect picks the new instance up. Without a
   * watchdog the user gets a clear "still down — relaunch InfiniBot manually"
   * banner from the wizard's reconnect logic instead of a silent dead tab.
   */
  "quickstart.restartGateway": async ({ respond }) => {
    respond(true, { ok: true, restarting: true });
    // Give the WS frame a tick to flush, then exit. Code 0 so service managers
    // that treat non-zero as failure don't back off.
    setTimeout(() => process.exit(0), 250);
  },

  /**
   * One-shot pull of master's sharedConfig during the satellite-pairing
   * step. The normal identity.sync path only fires after the gateway has
   * restarted into satellite mode, which is too late for the wizard — the
   * downstream steps (Models / Notion / etc.) need to display master's
   * values before the operator clicks Finish.
   *
   * Strategy: spin up a transient FederationSatellite, await the
   * `identity:sync` event the master auto-pushes on register, then tear
   * down. `applySharedConfig` runs inside the satellite's identity-sync
   * handler so master's blocks (notion, models.providers, mcpServers,
   * voice, loops) are written into local infinibot.json automatically.
   *
   * Returns `{ ok, applied }` where `applied` lists the block keys that
   * landed. On failure (unreachable master, no identity.sync within the
   * window, etc.) returns an error so the wizard can render a retry CTA.
   */
  "quickstart.federation.fetchMasterConfig": async ({ params, respond }) => {
    const masterUrlRaw = typeof params.masterUrl === "string" ? params.masterUrl.trim() : "";
    if (!masterUrlRaw) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "masterUrl is required" });
      return;
    }
    const timeoutMs = Math.min(30_000, Math.max(2_000, Number(params.timeoutMs) || 12_000));

    // Normalize: accept "host:port", "host", "ws://...", "https://..." and
    // resolve to a WebSocket URL ending in /federation, mirroring
    // satellite-cli's formatMasterUrl.
    let masterUrl: string;
    try {
      let u = masterUrlRaw;
      if (!/^[a-z]+:\/\//i.test(u)) u = `ws://${u}`;
      const parsed = new URL(u);
      if (parsed.protocol === "http:") parsed.protocol = "ws:";
      else if (parsed.protocol === "https:") parsed.protocol = "wss:";
      if (!parsed.pathname || parsed.pathname === "/") parsed.pathname = "/federation";
      masterUrl = parsed.toString();
    } catch {
      respond(false, undefined, {
        code: "BAD_REQUEST",
        message: `Invalid masterUrl: ${masterUrlRaw}`,
      });
      return;
    }

    const { FederationSatellite } = await import("../../federation/satellite.js");
    const nodeName = typeof params.nodeName === "string" ? params.nodeName : os.hostname();

    // Present the invite's signed token: a default master
    // (requireRegisterToken unset) rejects tokenless registrations.
    const { satelliteTokenFromConfig } = await import("../../federation/security.js");
    const authToken =
      satelliteTokenFromConfig(params.authToken) ??
      satelliteTokenFromConfig(
        (loadConfig().federation as { authToken?: unknown } | undefined)?.authToken,
      );

    const satellite = new FederationSatellite({
      masterUrl,
      nodeName,
      authToken,
      autoReconnect: false,
      enablePeerMesh: false,
      maxReconnectAttempts: 0,
    });

    const cleanup = async () => {
      try {
        await satellite.disconnect();
      } catch {
        /* shutdown errors are non-fatal */
      }
    };

    // Single overall deadline that covers both connect AND identity-sync
    // arrival. Race the work against this so an unreachable master, a
    // register.ack that never lands, or a master that doesn't auto-push
    // identity all surface the same clean timeout error instead of
    // dangling unhandled rejections.
    let deadlineFired = false;
    const deadline = new Promise<never>((_, reject) => {
      setTimeout(() => {
        deadlineFired = true;
        reject(new Error(`Master did not respond within ${timeoutMs}ms`));
      }, timeoutMs);
    });
    // No-op catch so a deadline that fires before any awaiter hooks in
    // doesn't crash the gateway with an unhandled rejection.
    deadline.catch(() => {});

    try {
      const identityPromise = new Promise<string[]>((resolve, reject) => {
        satellite.once("identity:sync", (data: { files: string[] }) => {
          resolve(data.files ?? []);
        });
        satellite.once("error", (err: Error) => {
          reject(err);
        });
      });
      identityPromise.catch(() => {});

      // Drive the handshake. Some hubs don't auto-push identity.sync on
      // register, so we explicitly request it once we're connected. The
      // hub responds via `identity.sync.request` -> pushIdentityToNode.
      const handshake = (async () => {
        await satellite.connect();
        try {
          await satellite.requestIdentitySync();
        } catch {
          /* ignore — fall through to identityPromise / deadline */
        }
        return identityPromise;
      })();
      handshake.catch(() => {});

      const files = (await Promise.race([handshake, deadline])) as string[];
      if (deadlineFired) {
        throw new Error(`Master did not respond within ${timeoutMs}ms`);
      }
      await cleanup();

      // applySharedConfig (inside satellite.handleIdentitySync) has already
      // written the master blocks into infinibot.json. Read them back so
      // the wizard can surface what was applied.
      const config = loadConfig() as Record<string, unknown>;
      const applied: string[] = [];
      if (config.notion) applied.push("notion");
      if ((config.models as Record<string, unknown> | undefined)?.providers) {
        applied.push("models.providers");
      }
      if (config.mcpServers) applied.push("mcpServers");
      if (config.voice) applied.push("voice");
      if (config.loops) applied.push("loops");

      respond(true, { ok: true, applied, identityFiles: files });
    } catch (err) {
      await cleanup();
      respond(false, undefined, {
        code: "FETCH_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  "quickstart.finalize": async ({ respond }) => {
    try {
      // Use the raw on-disk config as the base, not loadConfig(). loadConfig
      // returns {} on validation/env-substitution failure, and writing that
      // back wipes every top-level block the user has set — most visibly
      // `notion`, which the wizard's earlier Notion step persists separately.
      const current = await readRawBaseConfig();
      const onboarding = (current.onboarding as Record<string, unknown> | undefined) ?? {};
      onboarding.completed = true;
      onboarding.completedAt = Date.now();
      onboarding.via = "quickstart-web";
      current.onboarding = onboarding;
      // Defensive: populate every gateway field that the runtime CLI gate
      // in src/cli/gateway-cli/run.ts validates, so that finishing the
      // wizard via ANY path (including the satellite autoskip that
      // bypasses the Gateway step) produces a config that starts cleanly
      // with `infinibot gateway`. Only fill defaults — never overwrite a
      // value the user explicitly chose in the Gateway step or via
      // `config set`. The gates we satisfy:
      //   1. gateway.mode must equal "local" (run.ts:204)
      //   2. gateway.auth.mode resolves to "token" by default — and when
      //      it's token, gateway.auth.token must be non-empty (run.ts:261).
      //      When it's password, gateway.auth.password must be non-empty
      //      (run.ts:274). We pick token + autogenerate a secret if
      //      nothing's configured. Satellites that later receive a master
      //      gatewayPassword via identity.sync will adopt it; the
      //      autogenerated token is just the floor.
      const gateway = (current.gateway as Record<string, unknown> | undefined) ?? {};
      if (typeof gateway.mode !== "string") gateway.mode = "local";
      if (typeof gateway.bind !== "string") gateway.bind = "loopback";
      if (typeof gateway.port !== "number") gateway.port = 18789;
      const auth = (gateway.auth as Record<string, unknown> | undefined) ?? {};
      const hasToken = typeof auth.token === "string" && auth.token.trim().length > 0;
      const hasPassword = typeof auth.password === "string" && auth.password.trim().length > 0;
      // Default to password mode for the whole federation. Master pushes its
      // gatewayPassword to satellites via identity.sync, which means every
      // node in the federation can share one credential — much simpler to
      // operate than per-node tokens. Only fall back to token if a token is
      // already set and no password exists (legacy configs).
      if (typeof auth.mode !== "string") {
        auth.mode = hasToken && !hasPassword ? "token" : "password";
      }
      if (auth.mode === "password" && !hasPassword) {
        // Crypto-grade random secret. 32 bytes hex = 64 chars — long enough
        // to resist brute-force and short enough to be transcribable if
        // an operator ever needs to read it from the file by hand.
        const { randomBytes } = await import("node:crypto");
        auth.password = randomBytes(32).toString("hex");
      } else if (auth.mode === "token" && !hasToken) {
        const { randomBytes } = await import("node:crypto");
        auth.token = randomBytes(32).toString("hex");
      }
      gateway.auth = auth;
      current.gateway = gateway;
      // Seed the standard agent roster so the System Agents UI and the
      // neural-mesh viz both render the same set. seedStandardAgents is
      // idempotent — only adds entries whose id isn't already present, so
      // a wizard re-run never clobbers a customized agent.
      const { seedStandardAgents } = await import("../../agents/standard-roster.js");
      seedStandardAgents(current as never);
      await writeConfigFile(current as never);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Spawn `pnpm ui:build` from the repo root and resolve when it exits 0.
 * Captures stderr for the error path so failures bubble up with usable
 * detail. We run via shell on Windows so `pnpm.cmd` resolves; npm's PATH
 * shims (the .ps1 ones) are bypassed.
 */
function runUiBuild(repoRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const child = spawn("pnpm", ["ui:build"], {
      cwd: repoRoot,
      env: process.env,
      shell: isWin,
    });
    let stderrTail = "";
    let stdoutTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutTail = (stdoutTail + chunk.toString()).slice(-2000);
    });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderrTail.trim() || stdoutTail.trim() || `exit code ${code}`;
      reject(new Error(`pnpm ui:build failed (${code}): ${detail.slice(-600)}`));
    });
  });
}

/**
 * Slug-style option id for kanban Status / Priority — stable across renames
 * (the id only changes when the user removes the option entirely). Mirrors
 * the convention used in src/databases/business-templates.ts.
 */
function stableOptionId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || `opt_${Math.random().toString(36).slice(2, 8)}`
  );
}

/**
 * Derive the saved model selection so the web wizard can re-hydrate its
 * Models step on revisit. Reads the canonical primary id from
 * `agents.defaults.model.primary` (which the wizard writes) and the matching
 * `models.providers[<id>]` block. Returns `null` when nothing is saved or the
 * primary doesn't parse as `<provider>/<model>`. The API key is intentionally
 * not exposed — only `hasApiKey` so the UI can hint "saved key in use".
 */
function deriveModelChoice(config: Record<string, unknown>): QuickstartStatus["modelChoice"] {
  const agents = config.agents as { defaults?: { model?: unknown } } | undefined;
  const modelField = agents?.defaults?.model;
  let primary: string | undefined;
  if (typeof modelField === "string") primary = modelField;
  else if (modelField && typeof modelField === "object") {
    primary = (modelField as { primary?: unknown }).primary as string | undefined;
  }
  if (!primary || typeof primary !== "string") return null;
  const slash = primary.indexOf("/");
  if (slash <= 0) return null;
  const provider = primary.slice(0, slash);
  const model = primary.slice(slash + 1);
  const providers = (config.models as { providers?: Record<string, unknown> } | undefined)
    ?.providers;
  const providerCfg = (providers?.[provider] as Record<string, unknown> | undefined) ?? {};
  const apiKey = providerCfg.apiKey;
  const baseUrl = typeof providerCfg.baseUrl === "string" ? providerCfg.baseUrl : undefined;
  // Local Ollama exposes the host as `endpoint` in the wizard; we surface it
  // separately so the form's Endpoint field can re-populate without confusing
  // it with the OpenAI-style baseUrl for remote providers.
  const endpoint = provider === "ollama" ? baseUrl : undefined;
  return {
    primary,
    provider,
    model,
    hasApiKey: typeof apiKey === "string" && apiKey.length > 0,
    baseUrl,
    endpoint,
  };
}

function deriveStep(
  id: string,
  label: string,
  isComplete: () => boolean,
  summarize?: () => string,
): QuickstartStatus["steps"][number] {
  const complete = safeCall(isComplete, false);
  return {
    id,
    label,
    state: complete ? "complete" : "pending",
    summary: summarize ? safeCall(summarize, "") : undefined,
  };
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function countActiveChannels(config: Record<string, unknown>): number {
  const channels = (config.channels as Record<string, unknown> | undefined) ?? {};
  let n = 0;
  for (const [, value] of Object.entries(channels)) {
    if (!value || typeof value !== "object") continue;
    const v = value as { enabled?: boolean; token?: string };
    if (v.enabled === true) n++;
    else if (v.token) n++;
  }
  return n;
}

/**
 * Build the wizard's channel re-hydration payload.
 * - Tokens are *never* sent back to the browser. We expose `hasToken` so the
 *   form can show "saved token in use" without round-tripping the secret.
 * - allowFrom / groupAllowFrom round-trip as string[] so the wizard can show
 *   the existing allowlist as comma-separated text and write it back without
 *   the user having to retype every entry.
 */
function summarizeChannelsForWizard(config: Record<string, unknown>): QuickstartStatus["channels"] {
  const channels = (config.channels as Record<string, unknown> | undefined) ?? {};
  const out: QuickstartStatus["channels"] = {};
  for (const [id, raw] of Object.entries(channels)) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    const tokenField = id === "telegram" || id === "slack" ? "botToken" : "token";
    const hasToken = typeof v[tokenField] === "string" && (v[tokenField] as string).length > 0;
    const dmPolicy = typeof v.dmPolicy === "string" ? (v.dmPolicy as string) : undefined;
    const groupPolicy = typeof v.groupPolicy === "string" ? (v.groupPolicy as string) : undefined;
    out[id] = {
      enabled: v.enabled === true,
      hasToken,
      dmPolicy,
      groupPolicy,
      allowFrom: normalizeAllowEntries(v.allowFrom),
      groupAllowFrom: normalizeAllowEntries(v.groupAllowFrom),
    };
  }
  return out;
}

function normalizeAllowEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) =>
      typeof entry === "string" ? entry : typeof entry === "number" ? String(entry) : "",
    )
    .filter((entry) => entry.length > 0);
}

/**
 * Repair structural invariants the config schema enforces.
 * Run on every merged config before writing, so partial or interrupted
 * quickstart attempts can never leave the user in a state where the next
 * patch fails on stale data.
 */

/**
 * Return the parsed-but-not-validated on-disk config as a mutable record so
 * write-back operations preserve top-level blocks (`notion`, `channels`,
 * `models`, …) even when the live config currently fails strict validation
 * (unknown keys, missing env vars, etc). `readConfigFileSnapshot().parsed` is
 * the raw JSON5.parse output and is populated regardless of `valid`.
 */
async function readRawBaseConfig(): Promise<Record<string, unknown>> {
  const snap = await readConfigFileSnapshot();
  const parsed = snap.parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return { ...(parsed as Record<string, unknown>) };
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    const baseVal = out[key];
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      out[key] = deepMerge(baseVal as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}
