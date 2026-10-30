/**
 * VisionClaw CLI — pair Meta Ray-Ban glasses (or phone) without the web UI.
 *
 * Surfaces the same `visionclaw.*` RPCs the Glasses panel uses, plus a
 * smoke-test that hits `/v1/chat/completions` to verify the wire is up.
 *
 *   infinibot glasses status
 *   infinibot glasses enable
 *   infinibot glasses disable
 *   infinibot glasses rotate-token
 *   infinibot glasses test
 *   infinibot glasses snippet [--ios | --android | --curl]
 */

import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

interface VcStatus {
  enabled: boolean;
  host: string;
  port: number;
  bindMode: string;
  reachableFromPhone: boolean;
  tokenMasked: string;
  tokenSet: boolean;
  defaultAgent: string;
}

interface VcEnableResult extends VcStatus {
  mintedToken: string | null;
  requiresRestart: boolean;
}

function printStatus(s: VcStatus): void {
  console.log("VisionClaw");
  console.log("─".repeat(50));
  console.log(`Enabled:           ${s.enabled ? "yes" : "no"}`);
  console.log(`LAN host:          ${s.host}`);
  console.log(`Port:              ${s.port}`);
  console.log(`Bind mode:         ${s.bindMode}${s.reachableFromPhone ? "" : "  ⚠ phone can't reach"}`);
  console.log(`Token:             ${s.tokenMasked}${s.tokenSet ? "" : "  ⚠ none set"}`);
  console.log(`Default agent:     ${s.defaultAgent}`);
  console.log(`Endpoint:          http://${s.host}:${s.port}/v1/chat/completions`);
}

function buildSwiftSnippet(host: string, port: number, token: string): string {
  return `enum Secrets {
  static let geminiApiKey = "AI...your-real-key..."
  static let openClawHost = "http://${host}"
  static let openClawPort = ${port}
  static let openClawGatewayToken = "${token}"
}`;
}

function buildKotlinSnippet(host: string, port: number, token: string): string {
  return `object Secrets {
  const val geminiApiKey = "AI...your-real-key..."
  const val openClawHost = "http://${host}"
  const val openClawPort = ${port}
  const val openClawGatewayToken = "${token}"
}`;
}

function buildCurlSnippet(host: string, port: number, token: string): string {
  return `curl -X POST http://${host}:${port}/v1/chat/completions \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"visionclaw","messages":[{"role":"user","content":"hello"}]}'`;
}

export function registerVisionClawCli(program: Command) {
  const glasses = program
    .command("glasses")
    .description("Pair Meta Ray-Ban glasses (or phone) via VisionClaw");

  addGatewayClientOptions(
    glasses
      .command("status")
      .description("Show VisionClaw endpoint status, host, port, masked token")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = (await callGatewayFromCli("visionclaw.status", opts, {})) as VcStatus;
          if (opts.json) console.log(JSON.stringify(result, null, 2));
          else printStatus(result);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    glasses
      .command("enable")
      .description("Turn on /v1/chat/completions, flip bind to LAN, mint token if missing")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = (await callGatewayFromCli("visionclaw.enable", opts, {})) as VcEnableResult;
          if (opts.json) console.log(JSON.stringify(result, null, 2));
          else {
            printStatus(result);
            if (result.mintedToken) {
              console.log("");
              console.log("⚠ Token minted (one-time view — copy now):");
              console.log(`  ${result.mintedToken}`);
            }
            if (result.requiresRestart) {
              console.log("");
              console.log("→ Restart InfiniBot to activate the endpoint.");
            }
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    glasses
      .command("disable")
      .description("Turn off /v1/chat/completions (auth + bind unchanged)")
      .action(async (opts) => {
        try {
          await callGatewayFromCli("visionclaw.disable", opts, {});
          console.log("✓ VisionClaw disabled — restart InfiniBot to deactivate.");
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    glasses
      .command("rotate-token")
      .description("Mint a new gateway token (paired phones must update Secrets)")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = (await callGatewayFromCli("visionclaw.rotateToken", opts, {})) as VcEnableResult;
          if (opts.json) console.log(JSON.stringify(result, null, 2));
          else {
            printStatus(result);
            if (result.mintedToken) {
              console.log("");
              console.log("⚠ New token (one-time view — copy now):");
              console.log(`  ${result.mintedToken}`);
            }
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    glasses
      .command("test")
      .description("Send a smoke-test request to the local /v1/chat/completions endpoint")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = (await callGatewayFromCli("visionclaw.test", opts, {})) as {
            status: number;
            ok: boolean;
            body: unknown;
          };
          if (opts.json) console.log(JSON.stringify(result, null, 2));
          else {
            console.log(result.ok ? `✓ ${result.status} OK` : `✗ HTTP ${result.status}`);
            console.log("─".repeat(50));
            console.log(typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2));
          }
          if (!result.ok) defaultRuntime.exit(1);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    glasses
      .command("snippet")
      .description("Print a copy-paste Secrets snippet for the VisionClaw fork")
      .option("--ios", "Swift Secrets.swift snippet (default)")
      .option("--android", "Kotlin Secrets.kt snippet")
      .option("--curl", "Plain curl smoke test")
      .action(async (opts) => {
        try {
          const status = (await callGatewayFromCli("visionclaw.status", opts, {})) as VcStatus;
          if (!status.tokenSet) {
            console.error(danger("No token set — run `infinibot glasses enable` first."));
            defaultRuntime.exit(1);
            return;
          }
          // The status RPC only returns a masked token; a snippet needs the
          // real one. Tell the user to rotate (which surfaces the new token
          // once) or paste their existing one.
          const tokenPlaceholder = "<paste-real-token-from-rotate-or-secrets-vault>";
          const host = status.host;
          const port = status.port;
          if (opts.android) console.log(buildKotlinSnippet(host, port, tokenPlaceholder));
          else if (opts.curl) console.log(buildCurlSnippet(host, port, tokenPlaceholder));
          else console.log(buildSwiftSnippet(host, port, tokenPlaceholder));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
