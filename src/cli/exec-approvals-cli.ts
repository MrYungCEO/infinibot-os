import fs from "node:fs/promises";
import JSON5 from "json5";
import type { Command } from "commander";

import {
  readExecApprovalsSnapshot,
  saveExecApprovals,
  type ExecApprovalsAgent,
  type ExecApprovalsFile,
} from "../infra/exec-approvals.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { isRich, theme } from "../terminal/theme.js";
import { renderTable } from "../terminal/table.js";
import { addGatewayClientOptions, callGatewayFromCli, type GatewayRpcOpts } from "./gateway-rpc.js";
import { describeUnknownError } from "./gateway-cli/shared.js";
import { nodesCallOpts, resolveNodeId } from "./nodes-cli/rpc.js";
import type { NodesRpcOpts } from "./nodes-cli/types.js";

type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
};

type ExecApprovalsCliOpts = NodesRpcOpts & {
  node?: string;
  gateway?: boolean;
  file?: string;
  stdin?: boolean;
  agent?: string;
};

function formatAge(msAgo: number) {
  const s = Math.max(0, Math.floor(msAgo / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveTargetNodeId(opts: ExecApprovalsCliOpts): Promise<string | null> {
  if (opts.gateway) return null;
  const raw = opts.node?.trim() ?? "";
  if (!raw) return null;
  return await resolveNodeId(opts as NodesRpcOpts, raw);
}

async function loadSnapshot(
  opts: ExecApprovalsCliOpts,
  nodeId: string | null,
): Promise<ExecApprovalsSnapshot> {
  const method = nodeId ? "exec.approvals.node.get" : "exec.approvals.get";
  const params = nodeId ? { nodeId } : {};
  const snapshot = (await callGatewayFromCli(method, opts, params)) as ExecApprovalsSnapshot;
  return snapshot;
}

function loadSnapshotLocal(): ExecApprovalsSnapshot {
  const snapshot = readExecApprovalsSnapshot();
  return {
    path: snapshot.path,
    exists: snapshot.exists,
    hash: snapshot.hash,
    file: snapshot.file,
  };
}

function saveSnapshotLocal(file: ExecApprovalsFile): ExecApprovalsSnapshot {
  saveExecApprovals(file);
  return loadSnapshotLocal();
}

async function loadSnapshotTarget(opts: ExecApprovalsCliOpts): Promise<{
  snapshot: ExecApprovalsSnapshot;
  nodeId: string | null;
  source: "gateway" | "node" | "local";
}> {
  if (!opts.gateway && !opts.node) {
    return { snapshot: loadSnapshotLocal(), nodeId: null, source: "local" };
  }
  const nodeId = await resolveTargetNodeId(opts);
  const snapshot = await loadSnapshot(opts, nodeId);
  return { snapshot, nodeId, source: nodeId ? "node" : "gateway" };
}

function formatCliError(err: unknown): string {
  const msg = describeUnknownError(err);
  return msg.includes("\n") ? msg.split("\n")[0] : msg;
}

function renderApprovalsSnapshot(snapshot: ExecApprovalsSnapshot, targetLabel: string) {
  const rich = isRich();
  const heading = (text: string) => (rich ? theme.heading(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);
  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);

  const file = snapshot.file ?? { version: 1 };
  const defaults = file.defaults ?? {};
  const defaultsParts = [
    defaults.security ? `security=${defaults.security}` : null,
    defaults.ask ? `ask=${defaults.ask}` : null,
    defaults.askFallback ? `askFallback=${defaults.askFallback}` : null,
    typeof defaults.autoAllowSkills === "boolean"
      ? `autoAllowSkills=${defaults.autoAllowSkills ? "on" : "off"}`
      : null,
  ].filter(Boolean) as string[];
  const agents = file.agents ?? {};
  const allowlistRows: Array<{ Target: string; Agent: string; Pattern: string; LastUsed: string }> =
    [];
  const now = Date.now();
  for (const [agentId, agent] of Object.entries(agents)) {
    const allowlist = Array.isArray(agent.allowlist) ? agent.allowlist : [];
    for (const entry of allowlist) {
      const pattern = entry?.pattern?.trim() ?? "";
      if (!pattern) continue;
      const lastUsedAt = typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : null;
      allowlistRows.push({
        Target: targetLabel,
        Agent: agentId,
        Pattern: pattern,
        LastUsed: lastUsedAt ? `${formatAge(Math.max(0, now - lastUsedAt))} ago` : muted("unknown"),
      });
    }
  }

  const summaryRows = [
    { Field: "Target", Value: targetLabel },
    { Field: "Path", Value: snapshot.path },
    { Field: "Exists", Value: snapshot.exists ? "yes" : "no" },
    { Field: "Hash", Value: snapshot.hash },
    { Field: "Version", Value: String(file.version ?? 1) },
    { Field: "Socket", Value: file.socket?.path ?? "default" },
    { Field: "Defaults", Value: defaultsParts.length > 0 ? defaultsParts.join(", ") : "none" },
    { Field: "Agents", Value: String(Object.keys(agents).length) },
    { Field: "Allowlist", Value: String(allowlistRows.length) },
  ];

  defaultRuntime.log(heading("Approvals"));
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Field", header: "Field", minWidth: 8 },
        { key: "Value", header: "Value", minWidth: 24, flex: true },
      ],
      rows: summaryRows,
    }).trimEnd(),
  );

  if (allowlistRows.length === 0) {
    defaultRuntime.log("");
    defaultRuntime.log(muted("No allowlist entries."));
    return;
  }

  defaultRuntime.log("");
  defaultRuntime.log(heading("Allowlist"));
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Target", header: "Target", minWidth: 10 },
        { key: "Agent", header: "Agent", minWidth: 8 },
        { key: "Pattern", header: "Pattern", minWidth: 20, flex: true },
        { key: "LastUsed", header: "Last Used", minWidth: 10 },
      ],
      rows: allowlistRows,
    }).trimEnd(),
  );
}

async function saveSnapshot(
  opts: ExecApprovalsCliOpts,
  nodeId: string | null,
  file: ExecApprovalsFile,
  baseHash: string,
): Promise<ExecApprovalsSnapshot> {
  const method = nodeId ? "exec.approvals.node.set" : "exec.approvals.set";
  const params = nodeId ? { nodeId, file, baseHash } : { file, baseHash };
  const snapshot = (await callGatewayFromCli(method, opts, params)) as ExecApprovalsSnapshot;
  return snapshot;
}

function resolveAgentKey(value?: string | null): string {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : "*";
}

function normalizeAllowlistEntry(entry: { pattern?: string } | null): string | null {
  const pattern = entry?.pattern?.trim() ?? "";
  return pattern ? pattern : null;
}

function ensureAgent(file: ExecApprovalsFile, agentKey: string): ExecApprovalsAgent {
  const agents = file.agents ?? {};
  const entry = agents[agentKey] ?? {};
  file.agents = agents;
  return entry;
}

function isEmptyAgent(agent: ExecApprovalsAgent): boolean {
  const allowlist = Array.isArray(agent.allowlist) ? agent.allowlist : [];
  return (
    !agent.security &&
    !agent.ask &&
    !agent.askFallback &&
    agent.autoAllowSkills === undefined &&
    allowlist.length === 0
  );
}

export function registerExecApprovalsCli(program: Command) {
  const formatExample = (cmd: string, desc: string) =>
    `  ${theme.command(cmd)}\n    ${theme.muted(desc)}`;

  const approvals = program
    .command("approvals")
    .alias("exec-approvals")
    .description("Manage exec approvals (gateway or node host)")
    .addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals")}\n`);

  const getCmd = approvals
    .command("get")
    .description("Fetch exec approvals snapshot")
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .action(async (opts: ExecApprovalsCliOpts) => {
      try {
        const { snapshot, nodeId, source } = await loadSnapshotTarget(opts);
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(snapshot));
          return;
        }

        const muted = (text: string) => (isRich() ? theme.muted(text) : text);
        if (source === "local") {
          defaultRuntime.log(muted("Showing local approvals."));
          defaultRuntime.log("");
        }
        const targetLabel = source === "local" ? "local" : nodeId ? `node:${nodeId}` : "gateway";
        renderApprovalsSnapshot(snapshot, targetLabel);
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(getCmd);

  const setCmd = approvals
    .command("set")
    .description("Replace exec approvals with a JSON file")
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .option("--file <path>", "Path to JSON file to upload")
    .option("--stdin", "Read JSON from stdin", false)
    .action(async (opts: ExecApprovalsCliOpts) => {
      try {
        if (!opts.file && !opts.stdin) {
          defaultRuntime.error("Provide --file or --stdin.");
          defaultRuntime.exit(1);
          return;
        }
        if (opts.file && opts.stdin) {
          defaultRuntime.error("Use either --file or --stdin (not both).");
          defaultRuntime.exit(1);
          return;
        }
        const { snapshot, nodeId, source } = await loadSnapshotTarget(opts);
        if (source === "local") {
          defaultRuntime.log(theme.muted("Writing local approvals."));
        }
        const targetLabel = source === "local" ? "local" : nodeId ? `node:${nodeId}` : "gateway";
        if (!snapshot.hash) {
          defaultRuntime.error("Exec approvals hash missing; reload and retry.");
          defaultRuntime.exit(1);
          return;
        }
        const raw = opts.stdin ? await readStdin() : await fs.readFile(String(opts.file), "utf8");
        let file: ExecApprovalsFile;
        try {
          file = JSON5.parse(raw) as ExecApprovalsFile;
        } catch (err) {
          defaultRuntime.error(`Failed to parse approvals JSON: ${String(err)}`);
          defaultRuntime.exit(1);
          return;
        }
        file.version = 1;
        const next =
          source === "local"
            ? saveSnapshotLocal(file)
            : await saveSnapshot(opts, nodeId, file, snapshot.hash);
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(next));
          return;
        }
        defaultRuntime.log(theme.muted(`Target: ${targetLabel}`));
        renderApprovalsSnapshot(next, targetLabel);
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(setCmd);

  const allowlist = approvals
    .command("allowlist")
    .description("Edit the per-agent allowlist")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatExample(
          'infinibot approvals allowlist add "~/Projects/**/bin/rg"',
          "Allowlist a local binary pattern for the main agent.",
        )}\n${formatExample(
          'infinibot approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"',
          "Allowlist on a specific node/agent.",
        )}\n${formatExample(
          'infinibot approvals allowlist add --agent "*" "/usr/bin/uname"',
          "Allowlist for all agents (wildcard).",
        )}\n${formatExample(
          'infinibot approvals allowlist remove "~/Projects/**/bin/rg"',
          "Remove an allowlist pattern.",
        )}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals")}\n`,
    );

  const allowlistAdd = allowlist
    .command("add <pattern>")
    .description("Add a glob pattern to an allowlist")
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .option("--agent <id>", 'Agent id (defaults to "*")')
    .action(async (pattern: string, opts: ExecApprovalsCliOpts) => {
      try {
        const trimmed = pattern.trim();
        if (!trimmed) {
          defaultRuntime.error("Pattern required.");
          defaultRuntime.exit(1);
          return;
        }
        const { snapshot, nodeId, source } = await loadSnapshotTarget(opts);
        if (source === "local") {
          defaultRuntime.log(theme.muted("Writing local approvals."));
        }
        const targetLabel = source === "local" ? "local" : nodeId ? `node:${nodeId}` : "gateway";
        if (!snapshot.hash) {
          defaultRuntime.error("Exec approvals hash missing; reload and retry.");
          defaultRuntime.exit(1);
          return;
        }
        const file = snapshot.file ?? { version: 1 };
        file.version = 1;
        const agentKey = resolveAgentKey(opts.agent);
        const agent = ensureAgent(file, agentKey);
        const allowlistEntries = Array.isArray(agent.allowlist) ? agent.allowlist : [];
        if (allowlistEntries.some((entry) => normalizeAllowlistEntry(entry) === trimmed)) {
          defaultRuntime.log("Already allowlisted.");
          return;
        }
        allowlistEntries.push({ pattern: trimmed, lastUsedAt: Date.now() });
        agent.allowlist = allowlistEntries;
        file.agents = { ...file.agents, [agentKey]: agent };
        const next =
          source === "local"
            ? saveSnapshotLocal(file)
            : await saveSnapshot(opts, nodeId, file, snapshot.hash);
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(next));
          return;
        }
        defaultRuntime.log(theme.muted(`Target: ${targetLabel}`));
        renderApprovalsSnapshot(next, targetLabel);
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(allowlistAdd);

  const allowlistRemove = allowlist
    .command("remove <pattern>")
    .description("Remove a glob pattern from an allowlist")
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .option("--agent <id>", 'Agent id (defaults to "*")')
    .action(async (pattern: string, opts: ExecApprovalsCliOpts) => {
      try {
        const trimmed = pattern.trim();
        if (!trimmed) {
          defaultRuntime.error("Pattern required.");
          defaultRuntime.exit(1);
          return;
        }
        const { snapshot, nodeId, source } = await loadSnapshotTarget(opts);
        if (source === "local") {
          defaultRuntime.log(theme.muted("Writing local approvals."));
        }
        const targetLabel = source === "local" ? "local" : nodeId ? `node:${nodeId}` : "gateway";
        if (!snapshot.hash) {
          defaultRuntime.error("Exec approvals hash missing; reload and retry.");
          defaultRuntime.exit(1);
          return;
        }
        const file = snapshot.file ?? { version: 1 };
        file.version = 1;
        const agentKey = resolveAgentKey(opts.agent);
        const agent = ensureAgent(file, agentKey);
        const allowlistEntries = Array.isArray(agent.allowlist) ? agent.allowlist : [];
        const nextEntries = allowlistEntries.filter(
          (entry) => normalizeAllowlistEntry(entry) !== trimmed,
        );
        if (nextEntries.length === allowlistEntries.length) {
          defaultRuntime.log("Pattern not found.");
          return;
        }
        if (nextEntries.length === 0) {
          delete agent.allowlist;
        } else {
          agent.allowlist = nextEntries;
        }
        if (isEmptyAgent(agent)) {
          const agents = { ...file.agents };
          delete agents[agentKey];
          file.agents = Object.keys(agents).length > 0 ? agents : undefined;
        } else {
          file.agents = { ...file.agents, [agentKey]: agent };
        }
        const next =
          source === "local"
            ? saveSnapshotLocal(file)
            : await saveSnapshot(opts, nodeId, file, snapshot.hash);
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(next));
          return;
        }
        defaultRuntime.log(theme.muted(`Target: ${targetLabel}`));
        renderApprovalsSnapshot(next, targetLabel);
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(allowlistRemove);

  registerUnifiedApprovalCommands(approvals);
}

type UnifiedApprovalCliOpts = GatewayRpcOpts & { note?: string; all?: boolean; limit?: string };

type UnifiedApprovalRow = {
  id: string;
  source: string;
  title: string;
  risk: string;
  status: string;
  createdAt: number;
  expiresAt: number;
  decidedBy?: string | null;
  decidedVia?: string | null;
  requester?: { label?: string | null };
};

/**
 * Unified approval inbox from the terminal (same registry as Telegram / web):
 *   infinibot approvals pending
 *   infinibot approvals approve <id> [--note …]
 *   infinibot approvals deny <id> [--note …]
 *   infinibot approvals redirect <id> --note "…"
 *   infinibot approvals audit
 */
function registerUnifiedApprovalCommands(approvals: Command) {
  const pending = approvals
    .command("pending")
    .description("List approval requests waiting for the operator (all sources)")
    .option("--all", "Include resolved requests", false)
    .option("--limit <n>", "Max rows", "50")
    .option("--json", "Output JSON", false)
    .action(async (opts: UnifiedApprovalCliOpts) => {
      try {
        const res = (await callGatewayFromCli("approvals.list", opts, {
          status: opts.all ? "all" : "pending",
          limit: Number(opts.limit ?? 50),
        })) as { approvals?: UnifiedApprovalRow[] };
        const rows = res?.approvals ?? [];
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(rows));
          return;
        }
        if (rows.length === 0) {
          defaultRuntime.log(theme.muted("No pending approvals."));
          return;
        }
        const now = Date.now();
        defaultRuntime.log(
          renderTable({
            columns: [
              { key: "ID", header: "ID", minWidth: 12 },
              { key: "Status", header: "Status", minWidth: 8 },
              { key: "Risk", header: "Risk", minWidth: 6 },
              { key: "Source", header: "Source", minWidth: 8 },
              { key: "Title", header: "Title", minWidth: 20, flex: true },
              { key: "Expires", header: "Expires", minWidth: 7 },
            ],
            rows: rows.map((r) => ({
              ID: r.id,
              Status: r.status,
              Risk: r.risk,
              Source: r.source,
              Title: r.requester?.label ? `${r.title} (${r.requester.label})` : r.title,
              Expires: r.status === "pending" ? `in ${formatAge(r.expiresAt - now)}` : "",
            })),
          }).trimEnd(),
        );
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  addGatewayClientOptions(pending);

  const decide = (name: string, action: string, description: string) => {
    const cmd = approvals
      .command(`${name} <id>`)
      .description(description)
      .option(
        "--note <text>",
        action === "redirect" ? "Replacement instructions (required)" : "Note for the requester",
      )
      .option("--json", "Output JSON", false)
      .action(async (id: string, opts: UnifiedApprovalCliOpts) => {
        try {
          if (action === "redirect" && !opts.note?.trim()) {
            throw new Error("--note is required for redirect");
          }
          const res = (await callGatewayFromCli("approvals.resolve", opts, {
            id,
            action,
            note: opts.note,
            via: "cli",
          })) as { ok?: boolean; error?: string; record?: UnifiedApprovalRow | null };
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(res));
            return;
          }
          if (res?.ok) {
            defaultRuntime.log(`${res.record?.status ?? action}: ${res.record?.title ?? id}`);
            return;
          }
          const why =
            res?.error === "already_resolved"
              ? `already ${res.record?.status} by ${res.record?.decidedBy ?? "someone"} via ${res.record?.decidedVia ?? "?"}`
              : (res?.error ?? "unknown error");
          defaultRuntime.error(`Could not ${name} ${id}: ${why}`);
          defaultRuntime.exit(1);
        } catch (err) {
          defaultRuntime.error(formatCliError(err));
          defaultRuntime.exit(1);
        }
      });
    addGatewayClientOptions(cmd);
  };
  decide("approve", "approve", "Approve a pending request");
  decide("deny", "deny", "Deny a pending request");
  decide("redirect", "redirect", "Redirect a pending request with replacement instructions");

  const auditCmd = approvals
    .command("audit")
    .description("Show the approval audit log (who resolved what, where, when)")
    .option("--limit <n>", "Max entries", "50")
    .option("--json", "Output JSON", false)
    .action(async (opts: UnifiedApprovalCliOpts) => {
      try {
        const res = (await callGatewayFromCli("approvals.audit", opts, {
          limit: Number(opts.limit ?? 50),
        })) as { entries?: Array<Record<string, unknown>> };
        const entries = res?.entries ?? [];
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(entries));
          return;
        }
        for (const e of entries) {
          defaultRuntime.log(
            [
              e.ts,
              e.event,
              e.id,
              e.status ?? e.source,
              e.by ? `by ${String(e.by)}` : "",
              e.via ? `via ${String(e.via)}` : "",
              e.reason ? `(${String(e.reason)})` : "",
            ]
              .filter(Boolean)
              .join(" "),
          );
        }
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  addGatewayClientOptions(auditCmd);
}
