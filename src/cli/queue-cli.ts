/**
 * Phase queue CLI — `infinibot queue add|list|show|pause|resume|cancel|retry|logs|…`
 *
 * Thin client over the `queue.*` gateway RPCs (src/gateway/server-methods/queue.ts).
 * Entry ids accept a unique prefix (≥ 4 chars).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli, type GatewayRpcOpts } from "./gateway-rpc.js";

type Opts = GatewayRpcOpts & Record<string, unknown>;

type Attempt = {
  id: number;
  phaseIdx: number;
  n: number;
  agent: string;
  model: string | null;
  modelRequested: string | null;
  sessionId: string | null;
  resumedSession: string | null;
  fallbackFrom: string | null;
  outcome: string;
  verdict: string | null;
  verdictReasons: string[];
  startedAt: number;
  endedAt: number | null;
  gate: { pass: boolean; results: Array<{ label: string; pass: boolean; output: string }> } | null;
  error: string | null;
};

type Entry = {
  id: string;
  title: string;
  status: string;
  priority: number;
  currentPhaseIdx: number;
  phaseSpec: Array<{ name: string; agent?: string; model?: string }>;
  blockedKind: string | null;
  fixHint: string | null;
  lastError: string | null;
  waitingReason: string | null;
  createdAt: number;
  workdir: string | null;
  isolation: string;
  worktrees: Record<string, { path: string; branch: string }>;
  pauseRequested: boolean;
  currentAttempt?: Attempt | null;
};

async function run(method: string, opts: Opts, params: unknown, render: (res: unknown) => void) {
  try {
    const res = await callGatewayFromCli(method, opts, params);
    if (opts.json) defaultRuntime.log(JSON.stringify(res, null, 2));
    else render(res);
  } catch (err) {
    defaultRuntime.error(danger(String(err instanceof Error ? err.message : err)));
    defaultRuntime.exit(1);
  }
}

function dur(ms: number | null | undefined): string {
  if (!ms || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60 ? `${s % 60}s` : ""}` : `${Math.floor(m / 60)}h${m % 60}m`;
}

function ago(ts: number): string {
  return `${dur(Date.now() - ts)} ago`;
}

function entryLine(e: Entry): string {
  const phase = e.phaseSpec[e.currentPhaseIdx];
  const a = e.currentAttempt;
  const who = a ? `${a.agent}${a.model ? `/${a.model}` : ""}` : (phase?.agent ?? "claude-code");
  return [
    e.id.slice(0, 8),
    e.status.toUpperCase().padEnd(8),
    `${e.currentPhaseIdx + 1}/${e.phaseSpec.length}`.padEnd(5),
    (phase?.name ?? "-").slice(0, 18).padEnd(18),
    who.slice(0, 24).padEnd(24),
    e.title.slice(0, 48),
  ].join("  ");
}

function renderEntry(res: {
  entry: Entry;
  attempts: Attempt[];
  events: Array<{ ts: number; kind: string; message: string }>;
}) {
  const e = res.entry;
  const log = (s = "") => defaultRuntime.log(s);
  log(`${e.title}`);
  log(
    `id ${e.id} · ${e.status}${e.pauseRequested ? " (pause requested)" : ""} · priority ${e.priority} · created ${ago(e.createdAt)}`,
  );
  if (e.workdir) log(`workdir ${e.workdir} · isolation ${e.isolation}`);
  for (const [k, wt] of Object.entries(e.worktrees ?? {}))
    log(`worktree[${k}] ${wt.path} (${wt.branch})`);
  if (e.waitingReason) log(`waiting: ${e.waitingReason}`);
  if (e.blockedKind || e.fixHint) {
    log(`blocked: ${e.blockedKind ?? "-"}`);
    if (e.fixHint) log(`fix: ${e.fixHint}`);
  }
  if (e.lastError && ["blocked", "dead", "failed", "queued"].includes(e.status)) {
    log(`last error:\n  ${e.lastError.slice(0, 1500).split("\n").join("\n  ")}`);
  }
  log("");
  e.phaseSpec.forEach((p, i) => {
    const mark =
      i < e.currentPhaseIdx || e.status === "done" ? "✓" : i === e.currentPhaseIdx ? "▶" : "·";
    log(
      `${mark} phase ${i + 1}: ${p.name}  [${p.agent ?? "claude-code"}${p.model ? ` / ${p.model}` : ""}]`,
    );
    for (const a of res.attempts.filter((x) => x.phaseIdx === i)) {
      const model =
        a.model && a.modelRequested && a.model !== a.modelRequested
          ? `${a.modelRequested}→${a.model}`
          : (a.model ?? "default");
      log(
        `    #${a.n} ${a.outcome.padEnd(12)} ${a.agent} (${model})${a.resumedSession ? " resumed" : ""}${a.fallbackFrom ? ` fallback-from:${a.fallbackFrom}` : ""}` +
          ` verdict:${a.verdict ?? "-"} gate:${a.gate ? (a.gate.pass ? "pass" : "fail") : "-"} ${dur((a.endedAt ?? Date.now()) - a.startedAt)}` +
          (a.sessionId ? ` session:${a.sessionId.slice(0, 12)}` : "") +
          ` [attempt ${a.id}]`,
      );
      for (const r of a.verdictReasons.slice(0, 4)) log(`        - ${r.slice(0, 200)}`);
      for (const g of a.gate?.results.filter((x) => !x.pass) ?? []) log(`        ✗ ${g.label}`);
      if (a.error) log(`        error: ${a.error.slice(0, 200)}`);
    }
  });
  if (res.events.length) {
    log("");
    log("recent events:");
    for (const ev of res.events.slice(-12)) {
      log(
        `  ${new Date(ev.ts).toISOString().slice(11, 19)}  ${ev.kind.padEnd(22)} ${ev.message.split("\n")[0].slice(0, 120)}`,
      );
    }
  }
}

function parsePhaseArg(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // "name::agent[::model]::brief" shorthand
    const parts = raw.split("::");
    if (parts.length < 2)
      throw new Error(`--phase must be JSON or "name::agent[::model]::brief": ${raw}`);
    const [name, agent, ...rest] = parts;
    const brief = rest.pop() ?? "";
    const model = rest[0];
    return { name, agent, ...(model ? { model } : {}), brief };
  }
}

export function registerQueueCli(program: Command) {
  const queue = program
    .command("queue")
    .description(
      "Persistent phase queue — multi-phase work run by any coding agent (verified completion)",
    );

  addGatewayClientOptions(
    queue
      .command("add")
      .description("Enqueue an entry (from --file JSON or --phase flags)")
      .option(
        "--file <path>",
        "JSON file with queue.enqueue params ({title, briefMd, phaseSpec[], workdir, …})",
      )
      .option("--title <title>", "Entry title")
      .option("--brief <text>", "Project brief shared by all phases")
      .option("--workdir <dir>", "Repo / project directory (absolute)")
      .option("--isolation <mode>", "none | entry | phase (git worktree per entry/phase)")
      .option(
        "--phase <spec>",
        'Phase as JSON or "name::agent[::model]::brief" (repeatable, in order)',
        (v: string, acc: string[]) => [...acc, v],
        [] as string[],
      )
      .option(
        "--gate <phase:cmd>",
        'Shell gate for a phase, "1:pnpm test" (repeatable)',
        (v: string, acc: string[]) => [...acc, v],
        [] as string[],
      )
      .option("--depends-on <ids>", "Comma-separated entry ids that must finish first")
      .option("--priority <n>", "Priority (higher runs first)")
      .option("--paused", "Create paused", false)
      .option("--no-auto-approve", "Never give the phase CLIs the permission-bypass flag")
      .option("--json", "Output JSON", false)
      .action(async (opts: Opts) => {
        let params: Record<string, unknown> = {};
        try {
          if (opts.file) {
            params = JSON.parse(readFileSync(path.resolve(String(opts.file)), "utf8")) as Record<
              string,
              unknown
            >;
          }
          const phases = (opts.phase as string[]).map(parsePhaseArg) as Array<
            Record<string, unknown>
          >;
          if (phases.length) params.phaseSpec = phases;
          const spec = (params.phaseSpec ?? []) as Array<Record<string, unknown>>;
          for (const g of opts.gate as string[]) {
            const m = /^(\d+):(.*)$/s.exec(g);
            if (!m) throw new Error(`--gate must look like "1:command": ${g}`);
            const ph = spec[Number(m[1]) - 1];
            if (!ph) throw new Error(`--gate: no phase ${m[1]}`);
            const existing = Array.isArray(ph.gateCriteria) ? ph.gateCriteria : [];
            ph.gateCriteria = [...existing, { type: "shell", command: m[2].trim() }];
          }
          if (opts.title) params.title = opts.title;
          if (opts.brief) params.briefMd = opts.brief;
          if (opts.workdir) params.workdir = path.resolve(String(opts.workdir));
          if (opts.isolation) params.isolation = opts.isolation;
          if (opts.dependsOn)
            params.dependsOn = String(opts.dependsOn)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          if (opts.priority !== undefined) params.priority = Number(opts.priority);
          if (opts.paused) params.paused = true;
          if (opts.autoApprove === false) params.autoApprove = false;
          if (!spec.length) throw new Error("no phases: pass --file or at least one --phase");
        } catch (err) {
          defaultRuntime.error(danger(String(err instanceof Error ? err.message : err)));
          defaultRuntime.exit(1);
          return;
        }
        await run("queue.enqueue", opts, params, (res) => {
          const r = res as { id: string; deduped?: boolean; entry: Entry };
          defaultRuntime.log(
            `${r.deduped ? "= already queued" : "✓ queued"} ${r.id} — ${r.entry.title} (${r.entry.phaseSpec.length} phases)`,
          );
        });
      }),
  );

  addGatewayClientOptions(
    queue
      .command("list")
      .description("List entries")
      .option(
        "--status <status>",
        "Filter: queued|running|paused|blocked|done|failed|canceled|dead (comma-separated)",
      )
      .option("--limit <n>", "Max entries", "50")
      .option("--json", "Output JSON", false)
      .action(async (opts: Opts) => {
        const status = opts.status
          ? String(opts.status)
              .split(",")
              .map((s) => s.trim())
          : undefined;
        await run(
          "queue.list",
          opts,
          { ...(status ? { status } : {}), limit: Number(opts.limit) },
          (res) => {
            const r = res as {
              entries: Entry[];
              paused: boolean;
              running: number;
              maxConcurrent: number;
            };
            defaultRuntime.log(
              `dispatch ${r.paused ? "PAUSED" : "active"} · running ${r.running}/${r.maxConcurrent}`,
            );
            if (!r.entries.length) {
              defaultRuntime.log("No queue entries.");
              return;
            }
            defaultRuntime.log(
              `${"ID".padEnd(8)}  ${"STATUS".padEnd(8)}  PHASE  ${"NAME".padEnd(18)}  ${"AGENT".padEnd(24)}  TITLE`,
            );
            for (const e of r.entries) defaultRuntime.log(entryLine(e));
          },
        );
      }),
  );

  addGatewayClientOptions(
    queue
      .command("show <id>")
      .description("Entry detail: phases, attempts (backend/model/session/verdict/gate), events")
      .option("--json", "Output JSON", false)
      .action(async (id: string, opts: Opts) => {
        await run("queue.get", opts, { id, events: 50 }, (res) => renderEntry(res as never));
      }),
  );

  const simple = (
    name: string,
    desc: string,
    method: string,
    extra?: (c: Command) => Command,
    params?: (opts: Opts) => Record<string, unknown>,
  ) => {
    let cmd = queue
      .command(`${name} <id>`)
      .description(desc)
      .option("--json", "Output JSON", false);
    if (extra) cmd = extra(cmd);
    addGatewayClientOptions(
      cmd.action(async (id: string, opts: Opts) => {
        await run(method, opts, { id, ...(params ? params(opts) : {}) }, (res) => {
          const e = (res as { entry: Entry }).entry;
          defaultRuntime.log(
            `✓ ${name}: ${e.id.slice(0, 8)} is now ${e.status}${e.pauseRequested ? " (pause requested — parks after the current attempt)" : ""}`,
          );
        });
      }),
    );
  };

  simple(
    "pause",
    "Pause an entry (graceful: after the running attempt; --force stops it now)",
    "queue.pause",
    (c) => c.option("--force", "Stop the running attempt now (not counted)", false),
    (o) => ({ force: o.force === true }),
  );
  simple("resume", "Resume a paused entry", "queue.resume");
  simple(
    "cancel",
    "Cancel an entry (stops the agent's whole process tree)",
    "queue.cancel",
    (c) => c.option("--reason <text>", "Reason"),
    (o) => (o.reason ? { reason: String(o.reason) } : {}),
  );
  simple(
    "retry",
    "Retry a blocked/failed/dead/canceled entry (resumes the same agent session)",
    "queue.retry",
    (c) =>
      c
        .option("--from-phase <n>", "1-based phase to restart from")
        .option("--instruction <text>", "Extra instruction for the agent")
        .option("--fresh-session", "Start a new agent session instead of resuming", false)
        .option(
          "--agent <agent>",
          "Run the retried phase on another agent (claude-code|codex|opencode|gemini|grok|<agent id>)",
        )
        .option("--model <model>", "Run the retried phase with another model"),
    (o) => ({
      ...(o.fromPhase ? { fromPhase: Number(o.fromPhase) - 1 } : {}),
      ...(o.instruction ? { instruction: String(o.instruction) } : {}),
      ...(o.freshSession ? { freshSession: true } : {}),
      ...(o.agent ? { agent: String(o.agent) } : {}),
      ...(o.model !== undefined ? { model: String(o.model) } : {}),
    }),
  );
  simple(
    "advance",
    "Skip the current phase (operator override, audited)",
    "queue.advance",
    (c) => c.option("--reason <text>", "Why the phase is being skipped"),
    (o) => (o.reason ? { reason: String(o.reason) } : {}),
  );
  simple(
    "reorder",
    "Change priority",
    "queue.reorder",
    (c) => c.requiredOption("--priority <n>", "New priority"),
    (o) => ({ priority: Number(o.priority) }),
  );

  addGatewayClientOptions(
    queue
      .command("logs <id>")
      .description("Agent output of the latest (or --attempt) attempt")
      .option("--attempt <attemptId>", "Attempt id (see `queue show`)")
      .option("--max-chars <n>", "Tail size", "20000")
      .option("-f, --follow", "Poll until the attempt settles", false)
      .option("--json", "Output JSON", false)
      .action(async (id: string, opts: Opts) => {
        const params = {
          id,
          ...(opts.attempt ? { attemptId: Number(opts.attempt) } : {}),
          maxChars: Number(opts.maxChars),
        };
        if (!opts.follow) {
          await run("queue.logs", opts, params, (res) => {
            const r = res as { attempt: Attempt | null; text: string; tmuxAttach?: string };
            if (!r.attempt) {
              defaultRuntime.log("No attempts yet.");
              return;
            }
            defaultRuntime.log(
              `# attempt ${r.attempt.id} · phase ${r.attempt.phaseIdx + 1} #${r.attempt.n} · ${r.attempt.agent} · ${r.attempt.outcome}`,
            );
            if (r.tmuxAttach) defaultRuntime.log(`# live: ${r.tmuxAttach}`);
            defaultRuntime.log(r.text || "(no output yet)");
          });
          return;
        }
        let printed = 0;
        try {
          for (;;) {
            const r = (await callGatewayFromCli("queue.logs", { ...opts, json: true }, params, {
              progress: false,
            })) as {
              attempt: Attempt | null;
              text: string;
            };
            const text = r.text ?? "";
            if (text.length > printed) {
              process.stdout.write(text.slice(printed));
              printed = text.length;
            } else if (text.length < printed) {
              printed = 0; // tail window moved
            }
            if (!r.attempt || !["starting", "running"].includes(r.attempt.outcome)) {
              defaultRuntime.log(
                `\n# attempt ${r.attempt?.id ?? "-"} ${r.attempt?.outcome ?? "none"}`,
              );
              return;
            }
            await new Promise((res) => setTimeout(res, 3000));
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err instanceof Error ? err.message : err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    queue
      .command("backends")
      .description("Which coding CLIs can run phases (installed / logged in / fix)")
      .option("--json", "Output JSON", false)
      .action(async (opts: Opts) => {
        await run("queue.backends", opts, { refresh: true }, (res) => {
          for (const b of (
            res as {
              backends: Array<{
                id: string;
                available: boolean;
                authState: string;
                version?: string;
                fix?: string;
              }>;
            }
          ).backends) {
            defaultRuntime.log(
              `${b.available ? "✓" : "✗"} ${b.id.padEnd(12)} ${b.authState.padEnd(14)} ${b.version ?? ""}`,
            );
            if (!b.available && b.fix) defaultRuntime.log(`    fix: ${b.fix}`);
          }
        });
      }),
  );

  addGatewayClientOptions(
    queue
      .command("metrics")
      .description("Durations + success rate per agent")
      .option("--json", "Output JSON", false)
      .action(async (opts: Opts) => {
        await run("queue.metrics", opts, {}, (res) => {
          const r = res as {
            byAgent: Array<{
              agent: string;
              attempts: number;
              successRate: number;
              avgDurationMs: number;
              p90Ms: number;
            }>;
            byStatus: Record<string, number>;
          };
          defaultRuntime.log(
            `entries: ${
              Object.entries(r.byStatus)
                .map(([k, v]) => `${k}=${v}`)
                .join(" ") || "none"
            }`,
          );
          for (const a of r.byAgent) {
            defaultRuntime.log(
              `${a.agent.padEnd(16)} attempts ${String(a.attempts).padEnd(4)} success ${(a.successRate * 100).toFixed(0).padStart(3)}%  avg ${dur(a.avgDurationMs)}  p90 ${dur(a.p90Ms)}`,
            );
          }
        });
      }),
  );

  addGatewayClientOptions(
    queue
      .command("dispatch <state>")
      .description("Pause or resume dispatching for the whole queue (on|off)")
      .option("--json", "Output JSON", false)
      .action(async (state: string, opts: Opts) => {
        const paused = /^(off|pause|paused|stop)$/i.test(state);
        await run("queue.setPaused", opts, { paused }, (res) =>
          defaultRuntime.log(
            `dispatch ${(res as { paused: boolean }).paused ? "paused" : "active"}`,
          ),
        );
      }),
  );
}
