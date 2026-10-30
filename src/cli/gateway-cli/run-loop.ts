import type { startGatewayServer } from "../../gateway/server.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import {
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
} from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { defaultRuntime } from "../../runtime.js";

const gatewayLog = createSubsystemLogger("gateway");

type GatewayRunSignalAction = "stop" | "restart";

export async function runGatewayLoop(params: {
  start: () => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: typeof defaultRuntime;
}) {
  const lock = await acquireGatewayLock();

  // Secondary-gateway isolation. `acquireGatewayLock` returns null when the
  // singleton lock is deliberately bypassed via INFINIBOT_ALLOW_MULTI_GATEWAY=1
  // (e.g. an agent worktree running a preview/test gateway alongside the primary).
  // Such a gateway shares the same ~/.infinibot state dir + Telegram bot token as
  // the primary, so if it starts the channel pollers it produces getUpdates 409
  // conflicts ("only one bot instance") and contends on the session-store lock —
  // exactly the crash-loop failure mode we hit in production. A secondary gateway
  // must never touch shared external singletons: force the existing SKIP_CHANNELS
  // guard on (unless the operator has explicitly opted in) so Telegram/channel
  // pollers stay owned solely by the primary.
  if (
    lock === null &&
    process.env.INFINIBOT_ALLOW_MULTI_GATEWAY === "1" &&
    process.env.INFINIBOT_SKIP_CHANNELS == null
  ) {
    process.env.INFINIBOT_SKIP_CHANNELS = "1";
    gatewayLog.warn(
      "multi-gateway mode (INFINIBOT_ALLOW_MULTI_GATEWAY=1): forcing INFINIBOT_SKIP_CHANNELS=1 so this secondary gateway does not hijack the shared Telegram bot or channel pollers. Set INFINIBOT_SKIP_CHANNELS=0 to override.",
    );
  }

  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let shuttingDown = false;
  let restartResolver: (() => void) | null = null;

  const cleanupSignals = () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onSigusr1);
  };

  const request = (action: GatewayRunSignalAction, signal: string) => {
    if (shuttingDown) {
      gatewayLog.info(`received ${signal} during shutdown; ignoring`);
      return;
    }
    shuttingDown = true;
    const isRestart = action === "restart";
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);

    const forceExitTimer = setTimeout(() => {
      gatewayLog.error("shutdown timed out; exiting without full cleanup");
      cleanupSignals();
      params.runtime.exit(0);
    }, 5000);

    void (async () => {
      try {
        await server?.close({
          reason: isRestart ? "gateway restarting" : "gateway stopping",
          restartExpectedMs: isRestart ? 1500 : null,
        });
      } catch (err) {
        gatewayLog.error(`shutdown error: ${String(err)}`);
      } finally {
        clearTimeout(forceExitTimer);
        server = null;
        if (isRestart) {
          shuttingDown = false;
          restartResolver?.();
        } else {
          cleanupSignals();
          params.runtime.exit(0);
        }
      }
    })();
  };

  const onSigterm = () => {
    gatewayLog.info("signal SIGTERM received");
    request("stop", "SIGTERM");
  };
  const onSigint = () => {
    gatewayLog.info("signal SIGINT received");
    request("stop", "SIGINT");
  };
  const onSigusr1 = () => {
    gatewayLog.info("signal SIGUSR1 received");
    const authorized = consumeGatewaySigusr1RestartAuthorization();
    if (!authorized && !isGatewaySigusr1RestartExternallyAllowed()) {
      gatewayLog.warn(
        "SIGUSR1 restart ignored (not authorized; enable commands.restart or use gateway tool).",
      );
      return;
    }
    request("restart", "SIGUSR1");
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGUSR1", onSigusr1);

  try {
    // Keep process alive; SIGUSR1 triggers an in-process restart (no supervisor required).
    // SIGTERM/SIGINT still exit after a graceful shutdown.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      server = await params.start();
      await new Promise<void>((resolve) => {
        restartResolver = resolve;
      });
    }
  } finally {
    await lock?.release();
    cleanupSignals();
  }
}
