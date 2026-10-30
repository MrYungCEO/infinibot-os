/**
 * Setup › Coders RPCs: install, sign in and configure CLI coding agents.
 *
 *   coders.catalog                 (read)  the curated catalog
 *   coders.status                  (read)  per-coder install/auth/job state
 *   coders.install / update / uninstall    start a job; poll coders.status
 *   coders.test                            run `<bin> --version`
 *   coders.setKey / clearKey               BYOK key → auth-profile store
 *   coders.setDefault                      coder.backend in config
 *   coders.login.start/poll/submit/cancel  browser / device-code sign-in
 *
 * Everything that changes the machine or reads a sign-in session is left out
 * of READ_METHODS/WRITE_METHODS on purpose, which makes it admin-only (owner).
 * In SaaS mode requests already run in the tenant's namespace, so all paths
 * and stores resolve to that tenant; installs additionally require a
 * dedicated tenant Machine (see coder-install/paths.ts).
 *
 * Progress is broadcast on `coders:progress` ({ coderId, action, phase, ok,
 * error, log }) and is also visible through coders.status polling.
 */

import { loadConfig, writeConfigFile } from "../../config/config.js";
import {
  CODER_CATALOG,
  getCoderEntry,
  type CoderCatalogEntry,
} from "../../agents/coder-install/catalog.js";
import {
  startJob,
  managedBinPath,
  probeVersion,
  scrubbedEnv,
  type JobAction,
} from "../../agents/coder-install/installer.js";
import {
  allowedKeyEnvVars,
  clearCoderKey,
  coderKeyEnv,
  setCoderKey,
} from "../../agents/coder-install/keys.js";
import {
  cancelLogin,
  pollLogin,
  startLogin,
  submitLoginCode,
} from "../../agents/coder-install/login.js";
import { coderInstallPolicy } from "../../agents/coder-install/paths.js";
import { cleanLogText } from "../../agents/coder-install/redact.js";
import {
  allCoderStatuses,
  coderStatus,
  invalidateCoderStatus,
} from "../../agents/coder-install/status.js";
import { resolveBin } from "../../agents/coder-backend/bin-detect.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

export const CODERS_READ_METHODS = ["coders.catalog", "coders.status"] as const;

/** Admin-only (deliberately unclassified). Listed for docs/tests. */
export const CODERS_ADMIN_METHODS = [
  "coders.install",
  "coders.update",
  "coders.uninstall",
  "coders.test",
  "coders.setKey",
  "coders.clearKey",
  "coders.setDefault",
  "coders.login.start",
  "coders.login.poll",
  "coders.login.submit",
  "coders.login.cancel",
] as const;

type Respond = GatewayRequestHandlerOptions["respond"];

function fail(respond: Respond, code: string, message: string, extra?: Record<string, unknown>) {
  respond(false, extra, { code, message });
}

function entryOr404(params: Record<string, unknown>, respond: Respond): CoderCatalogEntry | null {
  const entry = getCoderEntry(params.id);
  if (!entry) {
    fail(respond, "NOT_FOUND", `Unknown coder: ${String(params.id ?? "")}`);
    return null;
  }
  return entry;
}

function catalogView(e: CoderCatalogEntry) {
  return {
    id: e.id,
    name: e.name,
    vendor: e.vendor,
    description: e.description,
    monogram: e.monogram,
    logo: e.logo,
    homepage: e.homepage,
    bin: e.bin,
    backend: e.backend,
    approxSizeMb: e.approxSizeMb,
    install: e.install.map((m) =>
      m.kind === "npm"
        ? { kind: m.kind, package: m.package, version: m.version }
        : m.kind === "manual"
          ? { kind: m.kind, url: m.url, reason: m.reason }
          : m.kind === "binary"
            ? { kind: m.kind, url: m.channelUrl }
            : { kind: m.kind, package: m.package },
    ),
    auth: e.auth.map((a) => ({
      kind: a.kind,
      label: a.label,
      envVars: a.kind === "api-key" ? a.envVars : undefined,
      acceptsCode: a.acceptsCode,
      storesCredentialIn: a.storesCredentialIn,
    })),
    keyEnvVars: allowedKeyEnvVars(e.id),
  };
}

function jobHandler(action: JobAction) {
  return async ({ params, respond, context }: GatewayRequestHandlerOptions) => {
    const entry = entryOr404(params, respond);
    if (!entry) return;
    const started = startJob(entry.id, action, {
      listener: (job) => {
        if (job.finishedAt) invalidateCoderStatus();
        try {
          context.broadcast("coders:progress", {
            coderId: job.coderId,
            action: job.action,
            phase: job.phase,
            ok: job.ok,
            error: job.error,
            version: job.version,
            log: job.log,
          });
        } catch {
          /* broadcast is best-effort; status polling is the source of truth */
        }
      },
    });
    if (!started.ok) {
      fail(respond, started.code, started.message, started.url ? { url: started.url } : undefined);
      return;
    }
    respond(true, { ok: true, coderId: entry.id, action, phase: started.job.phase });
  };
}

export const codersHandlers: GatewayRequestHandlers = {
  "coders.catalog": ({ respond }) => {
    const policy = coderInstallPolicy();
    respond(true, {
      coders: CODER_CATALOG.map(catalogView),
      policy: policy.allowed ? { allowed: true, mode: policy.mode } : policy,
    });
  },

  "coders.status": async ({ params, respond }) => {
    try {
      if (params.id !== undefined) {
        const entry = entryOr404(params, respond);
        if (!entry) return;
        respond(true, {
          coder: await coderStatus(entry, { checkUpdates: params.checkUpdates === true }),
        });
        return;
      }
      respond(true, await allCoderStatuses({ checkUpdates: params.checkUpdates === true }));
    } catch (err) {
      fail(respond, "INTERNAL_ERROR", cleanLogText((err as Error).message ?? String(err)));
    }
  },

  "coders.install": jobHandler("install"),
  "coders.update": jobHandler("update"),
  "coders.uninstall": jobHandler("uninstall"),

  "coders.test": async ({ params, respond }) => {
    const entry = entryOr404(params, respond);
    if (!entry) return;
    const bin = managedBinPath(entry) ?? resolveBin(entry.bin);
    if (!bin) {
      fail(respond, "NOT_INSTALLED", `${entry.name} is not installed.`);
      return;
    }
    const started = Date.now();
    try {
      // --version: no network, no tokens spent. Stored keys are provided so a
      // CLI that validates its env at startup behaves as in a real spawn.
      const version = await probeVersion(
        bin,
        entry.versionArgs,
        scrubbedEnv(coderKeyEnv(entry.id)),
      );
      respond(true, { ok: true, version, binPath: bin, ms: Date.now() - started });
    } catch (err) {
      respond(true, {
        ok: false,
        binPath: bin,
        error: cleanLogText(
          (err as Error).message ?? String(err),
          Object.values(coderKeyEnv(entry.id)),
        ),
      });
    }
  },

  "coders.setKey": ({ params, respond }) => {
    const entry = entryOr404(params, respond);
    if (!entry) return;
    const envVar =
      typeof params.envVar === "string" ? params.envVar : allowedKeyEnvVars(entry.id)[0];
    if (!envVar) {
      fail(respond, "INVALID_PARAMS", `${entry.name} does not take an API key.`);
      return;
    }
    try {
      setCoderKey(entry.id, envVar, params.key as string);
      invalidateCoderStatus();
      // Never echo the key back.
      respond(true, { ok: true, coderId: entry.id, envVar });
    } catch (err) {
      fail(respond, "INVALID_PARAMS", (err as Error).message);
    }
  },

  "coders.clearKey": ({ params, respond }) => {
    const entry = entryOr404(params, respond);
    if (!entry) return;
    const envVar = typeof params.envVar === "string" ? params.envVar : undefined;
    const removed = clearCoderKey(entry.id, envVar);
    invalidateCoderStatus();
    respond(true, { ok: true, removed });
  },

  "coders.setDefault": async ({ params, respond }) => {
    const entry = entryOr404(params, respond);
    if (!entry) return;
    if (!entry.backend) {
      fail(
        respond,
        "UNSUPPORTED",
        `${entry.name} can't run InfiniBot sub-agents yet; use it from a terminal.`,
      );
      return;
    }
    if (!(managedBinPath(entry) ?? resolveBin(entry.bin))) {
      fail(respond, "NOT_INSTALLED", `Install ${entry.name} first.`);
      return;
    }
    try {
      const current = loadConfig() as Record<string, unknown>;
      const coder = (
        typeof current.coder === "object" && current.coder !== null ? current.coder : {}
      ) as Record<string, unknown>;
      await writeConfigFile({
        ...current,
        coder: { ...coder, backend: entry.backend },
      } as Parameters<typeof writeConfigFile>[0]);
      respond(true, { ok: true, backend: entry.backend });
    } catch (err) {
      fail(respond, "INTERNAL_ERROR", `Failed to save config: ${(err as Error).message}`);
    }
  },

  "coders.login.start": async ({ params, respond }) => {
    const entry = entryOr404(params, respond);
    if (!entry) return;
    const res = await startLogin(entry.id);
    if (!res.ok) {
      fail(respond, res.code, res.message);
      return;
    }
    respond(true, res.session);
  },

  "coders.login.poll": ({ params, respond }) => {
    const s = pollLogin(params.sessionId);
    if (!s) {
      fail(respond, "NOT_FOUND", "No such sign-in session.");
      return;
    }
    if (s.status === "succeeded") invalidateCoderStatus();
    respond(true, s);
  },

  "coders.login.submit": ({ params, respond }) => {
    const r = submitLoginCode(params.sessionId, params.code);
    if (!r.ok) {
      fail(respond, "INVALID_PARAMS", r.message ?? "Could not submit code.");
      return;
    }
    respond(true, { ok: true });
  },

  "coders.login.cancel": ({ params, respond }) => {
    respond(true, { ok: cancelLogin(params.sessionId) });
  },
};
