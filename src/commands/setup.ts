import fs from "node:fs/promises";

import JSON5 from "json5";

import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../agents/workspace.js";
import { type InfinibotConfig, CONFIG_PATH, writeConfigFile } from "../config/config.js";
import { formatConfigPath, logConfigUpdated } from "../config/logging.js";
import { resolveSessionTranscriptsDir } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";

async function readConfigFileRaw(): Promise<{
  exists: boolean;
  parsed: InfinibotConfig;
}> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON5.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { exists: true, parsed: parsed as InfinibotConfig };
    }
    return { exists: true, parsed: {} };
  } catch {
    return { exists: false, parsed: {} };
  }
}

export async function setupCommand(
  opts?: { workspace?: string; skipVoice?: boolean },
  runtime: RuntimeEnv = defaultRuntime,
) {
  const desiredWorkspace =
    typeof opts?.workspace === "string" && opts.workspace.trim()
      ? opts.workspace.trim()
      : undefined;

  const existingRaw = await readConfigFileRaw();
  const cfg = existingRaw.parsed;
  const defaults = cfg.agents?.defaults ?? {};

  const workspace = desiredWorkspace ?? defaults.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;

  const next: InfinibotConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        workspace,
      },
    },
  };

  if (!existingRaw.exists || defaults.workspace !== workspace) {
    await writeConfigFile(next);
    if (!existingRaw.exists) {
      runtime.log(`Wrote ${formatConfigPath()}`);
    } else {
      logConfigUpdated(runtime, { suffix: "(set agents.defaults.workspace)" });
    }
  } else {
    runtime.log(`Config OK: ${formatConfigPath()}`);
  }

  const ws = await ensureAgentWorkspace({
    dir: workspace,
    ensureBootstrapFiles: !next.agents?.defaults?.skipBootstrap,
  });
  runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);

  const sessionsDir = resolveSessionTranscriptsDir();
  await fs.mkdir(sessionsDir, { recursive: true });
  runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);

  // Voice step — reuse the SAME interactive flow `onboard` uses (Cloud/Native/
  // Skip + input bindings). Persists via the bridged saveVoiceSetup so both
  // routes converge on voice.json. Skipped when non-interactive (no TTY) or when
  // the caller opts out, so scripted `setup` runs never hang on a prompt.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !opts?.skipVoice;
  if (interactive) {
    try {
      const { setupVoice } = await import("../wizard/onboarding.voice.js");
      const { createClackPrompter } = await import("../wizard/clack-prompter.js");
      const updated = await setupVoice({ config: next, prompter: createClackPrompter(), runtime });
      await writeConfigFile(updated);
      runtime.log("Voice OK: saved to voice config");
    } catch (err) {
      // Voice is non-critical to setup — never block on it.
      runtime.error(`Voice setup skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    runtime.log("Voice: skipped (non-interactive) — run `infinibot onboard` to configure");
  }

  // `setup` only writes config + ensures dirs. It does *not* boot the gateway
  // or open the GUI, which is a frequent source of "I ran setup, where's the
  // app?" confusion. Print the right next-step so the user lands on the GUI
  // without having to know which other command to run. Decide based on
  // whether auth is already configured: if it is, an existing gateway is
  // likely (point at `ui open`); if it isn't, run the full first-time flow
  // (point at `quickstart`).
  const hasGatewayAuth = Boolean(next.gateway?.auth?.token || next.gateway?.auth?.password);
  runtime.log("");
  runtime.log("Next steps:");
  if (hasGatewayAuth) {
    runtime.log(
      "  • infinibot ui open        — open the Control UI (auto-authenticates from your config)",
    );
    runtime.log(
      "  • infinibot quickstart     — re-run the guided web setup if you want to reconfigure",
    );
  } else {
    runtime.log(
      "  • infinibot quickstart     — open the guided web setup (recommended for first run)",
    );
    runtime.log(
      "  • infinibot ui open        — open the Control UI directly once a gateway is running",
    );
  }
}
