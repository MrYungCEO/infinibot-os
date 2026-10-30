/**
 * Voice → CLI session routing RPCs (Voice page routing control).
 *
 *   voice.cliRoute.get        (read)  the route ("api" | "cli" + target), whether
 *                                     the routed session is alive, its open
 *                                     permission prompt and last voice turn.
 *   voice.cliRoute.sessions   (read)  open sessions (terminals + running coder
 *                                     runs) and installed CLIs for the selector.
 *   voice.cliRoute.set        (write) { mode: "api", model? } | { mode: "cli", target }.
 *                                     `model` ("provider/model", null = agent's
 *                                     model) is the voice brain for API turns.
 *   voice.brain.catalog       (read)  { fresh?, agentId? } → configured API
 *                                     providers with live models, local models,
 *                                     subscription CLIs (voice-brain-catalog.ts).
 *   voice.cliRoute.start      (write) { cli, cwd?, title? } → new terminal
 *                                     running that CLI, routed to at once.
 *   voice.cliRoute.interrupt  (write) stop the routed session's current work.
 *   voice.cliRoute.test       (write) { text } → one owner voice turn through
 *                                     the CLI route, exactly as a call's turn
 *                                     runs (the page's "say it" box). Refused
 *                                     unless the route is "cli": it never
 *                                     starts a billed API LLM turn.
 *
 * Gateway-side, so Robovoice (or any voice provider calling the voice-LLM
 * seam) follows the switch with no change of its own.
 */

import { ErrorCodes, errorShape } from "../protocol/index.js";
import { interruptKeysFor } from "../voice/voice-cli-output.js";
import { buildVoiceBrainCatalog } from "../voice/voice-brain-catalog.js";
import {
  readVoiceCliRoute,
  sanitizeVoiceModelRef,
  writeVoiceCliRoute,
  type VoiceCliTarget,
} from "../voice/voice-cli-route.js";
import {
  cliRunning,
  defaultVoiceCliHost,
  listVoiceCliCatalogue,
  openCliSessionPort,
  startVoiceCliSession,
  type VoiceCliHost,
  voiceCliRunsInTenantContainer,
} from "../voice/voice-cli-sessions.js";
import { voiceCliSessionState } from "../voice/voice-cli-turn.js";
import type { GatewayRequestHandlers } from "./types.js";

export const VOICE_CLI_ROUTE_READ_METHODS = [
  "voice.cliRoute.get",
  "voice.cliRoute.sessions",
  "voice.brain.catalog",
] as const;
export const VOICE_CLI_ROUTE_WRITE_METHODS = [
  "voice.cliRoute.set",
  "voice.cliRoute.start",
  "voice.cliRoute.interrupt",
  "voice.cliRoute.test",
] as const;

let hostOverride: VoiceCliHost | null = null;
/** Tests: a fake terminal / coder host. */
export function setVoiceCliHostForTests(h: VoiceCliHost | null): void {
  hostOverride = h;
}
const host = async () => hostOverride ?? (await defaultVoiceCliHost());

async function routePayload() {
  const route = readVoiceCliRoute();
  let alive: boolean | null = null;
  if (route.target) {
    const h = await host().catch(() => null);
    if (h) {
      if (route.target.kind === "coder")
        alive = !!h.listCoderRuns().find((r) => r.runId === route.target!.runId)?.running;
      else
        alive =
          !!route.target.terminalId &&
          !!h.getTerminal(route.target.terminalId) &&
          h.isTerminalAlive(route.target.terminalId) &&
          // The CLI itself, not just its terminal (an exited CLI leaves a live shell).
          (await cliRunning(h, route.target.terminalId, route.target.cliType ?? "shell"));
    }
  }
  return { route, alive, ...voiceCliSessionState(route.target) };
}

function parseTarget(raw: unknown): VoiceCliTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  if (t.kind === "terminal" && s(t.terminalId))
    return {
      kind: "terminal",
      terminalId: s(t.terminalId),
      cliType: s(t.cliType),
      label: s(t.label) ?? s(t.terminalId)!,
      cwd: s(t.cwd),
    };
  if (t.kind === "coder" && s(t.runId))
    return {
      kind: "coder",
      runId: s(t.runId),
      terminalId: s(t.terminalId),
      cliType: s(t.cliType),
      label: s(t.label) ?? s(t.runId)!,
      cwd: s(t.cwd),
    };
  return null;
}

export const voiceCliRouteHandlers: GatewayRequestHandlers = {
  "voice.cliRoute.get": async ({ respond }) => {
    respond(true, await routePayload());
  },

  "voice.brain.catalog": async ({ params, respond }) => {
    const p = (params ?? {}) as { fresh?: unknown; agentId?: unknown };
    try {
      respond(
        true,
        await buildVoiceBrainCatalog({
          fresh: p.fresh === true,
          agentId: typeof p.agentId === "string" ? p.agentId : undefined,
          current: readVoiceCliRoute().model ?? null,
        }),
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "voice.cliRoute.sessions": async ({ respond }) => {
    try {
      // The host is process-local. On Cloud this process is the tenant's own
      // container, so the response can never enumerate an operator host's
      // terminals, tmux socket, coder registry or PATH.
      respond(
        true,
        await listVoiceCliCatalogue(await host(), { cloud: voiceCliRunsInTenantContainer() }),
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "voice.cliRoute.set": async ({ params, respond }) => {
    const p = (params ?? {}) as { mode?: string; target?: unknown; model?: unknown };
    if (p.mode === "api") {
      let model: string | null | undefined;
      if (p.model === null || p.model === "") model = null;
      else if (p.model !== undefined) {
        model = sanitizeVoiceModelRef(p.model);
        if (!model) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, 'model must be "provider/model" or null'),
          );
          return;
        }
      }
      writeVoiceCliRoute({
        mode: "api",
        target: readVoiceCliRoute().target,
        ...(model !== undefined ? { model } : {}),
      });
      respond(true, await routePayload());
      return;
    }
    const target = p.mode === "cli" ? parseTarget(p.target) : null;
    if (!target) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          'expected { mode: "api" } or { mode: "cli", target: { kind, terminalId | runId, label } }',
        ),
      );
      return;
    }
    // Prove the session is there (and re-attach a tmux-only terminal) before routing to it.
    const h = await host();
    const port = await openCliSessionPort(h, target, { interruptKeys: interruptKeysFor }).catch(
      () => null,
    );
    if (!port || !(await port.isAlive())) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `session ${target.label} is not running`),
      );
      return;
    }
    writeVoiceCliRoute({ mode: "cli", target });
    respond(true, await routePayload());
  },

  "voice.cliRoute.start": async ({ params, respond }) => {
    const p = (params ?? {}) as { cli?: string; cwd?: string; title?: string; route?: boolean };
    if (!p.cli || typeof p.cli !== "string") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "expected { cli, cwd?, title? }"),
      );
      return;
    }
    try {
      const target = await startVoiceCliSession(await host(), {
        cli: p.cli,
        cwd: p.cwd,
        title: p.title,
      });
      if (p.route !== false) writeVoiceCliRoute({ mode: "cli", target });
      respond(true, { target, ...(await routePayload()) });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },

  "voice.cliRoute.interrupt": async ({ respond }) => {
    const route = readVoiceCliRoute();
    if (!route.target) {
      respond(true, { interrupted: "none" });
      return;
    }
    const port = await openCliSessionPort(await host(), route.target, {
      interruptKeys: interruptKeysFor,
    }).catch(() => null);
    respond(true, { interrupted: port ? await port.interrupt() : "none" });
  },

  "voice.cliRoute.test": async ({ params, respond }) => {
    const p = (params ?? {}) as { text?: string; agentId?: string };
    const text = typeof p.text === "string" ? p.text.trim() : "";
    if (!text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "expected { text }"));
      return;
    }
    const route = readVoiceCliRoute();
    if (route.mode !== "cli" || !route.target) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "voice routing is on the API LLM; pick a CLI session first",
        ),
      );
      return;
    }
    const { runVoiceLlmTurn } = await import("../voice/voice-llm-turn.js");
    const spoken: Array<{ ms: number; text: string }> = [];
    const started = Date.now();
    try {
      const r = await runVoiceLlmTurn(
        {
          agentId: typeof p.agentId === "string" && p.agentId ? p.agentId : "main",
          backend: "gateway",
          message: text,
          callKey: "voice-page-test",
          provider: "voice-page",
          callerIsOwner: true,
          onDelta: (t) => spoken.push({ ms: Date.now() - started, text: t }),
        },
        {
          cliSession: {
            ...(hostOverride ? { host: hostOverride } : {}),
            // A test turn never falls through to a billed API LLM turn.
            apiTurn: async (req) => {
              const t = "The API LLM would answer from here.";
              req.onDelta(t);
              return {
                text: t,
                backend: req.backend,
                sessionKey: "voice-page-test",
                trust: "owner",
                firstTokenMs: 0,
                totalMs: 0,
              };
            },
          },
        },
      );
      respond(true, {
        text: r.text,
        spoken,
        firstTokenMs: r.firstTokenMs,
        totalMs: r.totalMs,
        timings: r.timings,
        ...(await routePayload()),
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
