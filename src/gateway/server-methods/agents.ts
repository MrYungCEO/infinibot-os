import {
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import type { InfinibotConfig } from "../../config/types.infinibot.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentsListParams,
} from "../protocol/index.js";
import { listAgentsForGateway } from "../session-utils.js";
import { proxyMethodsToMaster } from "../../federation/satellite-context.js";
import type { GatewayRequestHandlers } from "./types.js";

const _listHandler = ({ params, respond }: any) => {
  // We can skip strict validation for alias or reuse
  if (!validateAgentsListParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid agents.list params: ${formatValidationErrors(validateAgentsListParams.errors)}`,
      ),
    );
    return;
  }

  const cfg = loadConfig();
  const result = listAgentsForGateway(cfg);
  respond(true, result, undefined);
};

/**
 * Persist edits made in the Agents Management view.
 *
 * Only the fields that exist on `config.agents.list[]` are written — the
 * management view's row model also carries derived/runtime fields (session
 * counts, CPU, prompt version history) that have no config representation and
 * are silently ignored rather than written back as junk.
 */
const _managementUpdateHandler = async ({ params, respond }: any) => {
  const p = (params ?? {}) as Record<string, unknown>;
  const id = typeof p.id === "string" ? p.id.trim() : "";
  if (!id) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
    return;
  }

  try {
    const snapshot = await readConfigFileSnapshot();
    const parsed = parseConfigJson5(snapshot.raw ?? "{}");
    const config: InfinibotConfig =
      parsed.ok && parsed.parsed && typeof parsed.parsed === "object"
        ? (parsed.parsed as InfinibotConfig)
        : ({} as InfinibotConfig);

    if (!config.agents) config.agents = {};
    if (!Array.isArray(config.agents.list)) config.agents.list = [];

    const list = config.agents.list;
    let entry = list.find((a) => a?.id === id);
    if (!entry) {
      entry = { id };
      list.push(entry);
    }

    if (typeof p.name === "string") entry.name = p.name;
    if (typeof p.systemPrompt === "string") entry.systemPrompt = p.systemPrompt;
    if (typeof p.model === "string" && p.model.trim()) {
      const existingModel = typeof entry.model === "object" && entry.model ? entry.model : {};
      entry.model = { ...existingModel, primary: p.model };
    }
    // Secure Mode per-agent policy (src/secure-mode/agent-policy.ts).
    if (typeof p.secureOnly === "boolean") {
      if (p.secureOnly) entry.secureOnly = true;
      else delete entry.secureOnly;
    }

    const validation = validateConfigObjectWithPlugins(config);
    if (!validation.ok) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Invalid config: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        ),
      );
      return;
    }
    await writeConfigFile(config);

    respond(true, { ok: true, agent: entry }, undefined);
  } catch (e) {
    respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
  }
};

const _rawHandlers: GatewayRequestHandlers = {
  "agents.list": _listHandler,
  "agents.management.list": _listHandler,
  "agents.management.update": _managementUpdateHandler,
};

export const agentsHandlers = proxyMethodsToMaster(_rawHandlers, [
  "agents.list",
  "agents.management.list",
  "agents.management.update",
]);
