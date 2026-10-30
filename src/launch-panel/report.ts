import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GroupTranscriptMessage } from "../shared/group-chat/types.js";
import { markdownToPayload } from "../reports/helpers/markdown-to-payload.js";
import { renderReport } from "../reports/render.js";
import { emitMediaArtifact, artifactHash } from "../proactive/media-artifacts.js";
import { resolveConfigPath } from "../config/paths.js";
import { sendDocumentTelegram, sendTelegramText } from "../reports/sinks/telegram.js";
import type { LaunchPanelRun, LaunchPersona } from "./types.js";

type Scorecard = {
  personaId: string;
  name: string;
  wouldBuy: string;
  tier: string;
  willingnessToPay: string;
  topObjection: string;
  competitor: string;
  conversionChange: string;
};

type Finding = {
  severity: string;
  reach: number;
  effort: number;
  title: string;
  evidence: string;
  fix: string;
  score: number;
};

type FunnelStep = {
  persona: string;
  step: string;
  status: string;
  seconds: string;
  confusion: string;
  evidence: string;
};

function textOf(message: GroupTranscriptMessage): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function field(text: string, name: string): string {
  const pattern = new RegExp(`^${name}:\\s*(.+)$`, "i");
  for (const line of text.split("\n")) {
    const normalized = line
      .trim()
      .replace(/^[-*]\s+/, "")
      .replaceAll("**", "");
    const value = pattern.exec(normalized)?.[1]?.trim();
    if (value) return value;
  }
  return "Not stated";
}

export function extractScorecards(
  messages: GroupTranscriptMessage[],
  personas: LaunchPersona[],
): Scorecard[] {
  return personas.map((persona) => {
    const message = [...messages]
      .reverse()
      .find((m) => m.groupChat?.stepNodeId === `r3-${persona.id}`);
    const text = message ? textOf(message) : "";
    return {
      personaId: persona.id,
      name: persona.name,
      wouldBuy: field(text, "WOULD_BUY"),
      tier: field(text, "TIER"),
      willingnessToPay: field(text, "WTP"),
      topObjection: field(text, "TOP_OBJECTION"),
      competitor: field(text, "COMPETITOR"),
      conversionChange: field(text, "CONVERSION_CHANGE"),
    };
  });
}

export function extractFindings(messages: GroupTranscriptMessage[]): Finding[] {
  const severityValue: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  const found = new Map<string, Finding>();
  for (const message of messages) {
    for (const line of textOf(message).split("\n")) {
      if (!line.trim().startsWith("FINDING|")) continue;
      const [, severityRaw, reachRaw, effortRaw, titleRaw, evidenceRaw, fixRaw] = line.split("|");
      const severity = (severityRaw || "medium").trim().toLowerCase();
      const reach = Math.max(1, Math.min(5, Number(reachRaw) || 1));
      const effort = Math.max(1, Math.min(5, Number(effortRaw) || 1));
      const title = (titleRaw || "Observed conversion gap").trim();
      const finding: Finding = {
        severity,
        reach,
        effort,
        title,
        evidence: (evidenceRaw || "none").trim(),
        fix: (fixRaw || "Review the observed flow and remove the blocker.").trim(),
        score: ((severityValue[severity] || 2) * reach) / effort,
      };
      const key = title.toLowerCase();
      if (!found.has(key) || found.get(key)!.score < finding.score) found.set(key, finding);
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score);
}

export function extractFunnelSteps(
  messages: GroupTranscriptMessage[],
  personas: LaunchPersona[],
): FunnelStep[] {
  const byId = new Map(personas.map((p) => [p.id, p.name]));
  const out: FunnelStep[] = [];
  const observedNodes = new Map<string, string[]>();
  for (const message of messages) {
    const nodeId = message.groupChat?.stepNodeId || "";
    if (!nodeId.startsWith("r2-")) continue;
    const persona = byId.get(nodeId.slice(3)) || nodeId.slice(3);
    const messageText = textOf(message);
    const observed = observedNodes.get(nodeId) ?? [];
    observed.push(messageText);
    observedNodes.set(nodeId, observed);
    for (const line of messageText.split("\n")) {
      if (!line.trim().startsWith("STEP|")) continue;
      const [, step, status, seconds, confusion, evidence] = line.split("|");
      out.push({
        persona,
        step: (step || "Unknown step").trim(),
        status: (status || "blocked").trim(),
        seconds: (seconds || "—").trim(),
        confusion: (confusion || "none").trim(),
        evidence: (evidence || "none").trim(),
      });
    }
  }
  for (const [personaId, persona] of byId) {
    const nodeId = `r2-${personaId}`;
    if (out.some((step) => step.persona === persona)) continue;
    const narrative = (observedNodes.get(nodeId) ?? []).join("\n");
    if (!narrative.trim()) continue;
    const evidence =
      extractScreenshotPaths([
        {
          role: "assistant",
          content: [{ type: "text", text: narrative }],
          timestamp: Date.now(),
        } as GroupTranscriptMessage,
      ]).at(-1) ?? "none";
    out.push({
      persona,
      step: "Hands-on browser audit",
      status: "partial",
      seconds: "turn limit",
      confusion: "Agent gathered live evidence but ended before its structured STEP summary",
      evidence,
    });
  }
  return out;
}

export function extractScreenshotPaths(messages: GroupTranscriptMessage[]): string[] {
  const out = new Set<string>();
  const re = /(?:^|[\s|`(])((?:\/[^\s|`)]+)+\.(?:png|jpe?g|webp))(?:$|[\s|`)])/gi;
  for (const message of messages) {
    for (const match of textOf(message).matchAll(re)) {
      const file = match[1]!;
      if (path.isAbsolute(file) && fs.existsSync(file)) out.add(file);
    }
  }
  return [...out];
}

function evidenceLink(value: string): string {
  if (!value || value === "none") return "Evidence missing";
  return `[open screenshot](${value.replace(/ /g, "%20")})`;
}

export function buildLaunchPanelMarkdown(params: {
  run: LaunchPanelRun;
  personas: LaunchPersona[];
  messages: GroupTranscriptMessage[];
}): { markdown: string; screenshotPaths: string[]; verdict: string } {
  const { run, personas, messages } = params;
  const scorecards = extractScorecards(messages, personas);
  const findings = extractFindings(messages);
  const funnel = extractFunnelSteps(messages, personas);
  const screenshots = extractScreenshotPaths(messages);
  const yes = scorecards.filter((s) => /^yes$/i.test(s.wouldBuy)).length;
  const maybe = scorecards.filter((s) => /^maybe$/i.test(s.wouldBuy)).length;
  const critical = findings.filter((f) => f.severity === "critical").length;
  const conversionSignal = personas.length ? (yes + maybe * 0.5) / personas.length : 0;
  const verdict =
    critical > 0 || conversionSignal < 0.4
      ? "NOT READY"
      : conversionSignal >= 0.65
        ? "READY WITH MINOR FIXES"
        : "CONDITIONAL — FIX TOP GAPS";
  const moderator = [...messages].reverse().find((m) => m.groupChat?.stepNodeId === "r4-moderator");

  const lines = [
    `# Launch Test Panel — ${new URL(run.url).hostname}`,
    `_${verdict} · ${personas.length} customer avatars · ${screenshots.length} screenshots · generated ${new Date().toISOString()}_`,
    "",
    "## Launch readiness verdict",
    `**${verdict}**. ${yes} yes, ${maybe} maybe, ${scorecards.length - yes - maybe} no/unstated buying decisions. ${critical} critical finding(s).`,
    "",
    moderator
      ? textOf(moderator)
      : "Moderator synthesis was not available; the structured evidence below is still preserved.",
    "",
    "## Conversion scorecard per persona",
    "| Persona | Would buy | Tier | Willingness to pay | Top objection |",
    "|---|---|---|---|---|",
    ...scorecards.map(
      (s) =>
        `| ${s.name} | ${s.wouldBuy} | ${s.tier} | ${s.willingnessToPay} | ${s.topObjection.replace(/\|/g, "/")} |`,
    ),
    "",
    "## Funnel drop-off map",
    "| Persona | Step | Result | Time | Confusion | Evidence |",
    "|---|---|---|---:|---|---|",
    ...(funnel.length
      ? funnel.map(
          (s) =>
            `| ${s.persona} | ${s.step} | ${s.status} | ${s.seconds} | ${s.confusion.replace(/\|/g, "/")} | ${evidenceLink(s.evidence)} |`,
        )
      : [
          "| — | No structured steps returned | blocked | — | Re-run the affected persona | Evidence missing |",
        ]),
    "",
    "## Prioritized conversion gaps",
    "| Priority | Severity | Reach | Effort | Gap | Evidence | Suggested fix / copy |",
    "|---:|---|---:|---:|---|---|---|",
    ...(findings.length
      ? findings.map(
          (f, i) =>
            `| ${i + 1} | ${f.severity} | ${f.reach} | ${f.effort} | ${f.title.replace(/\|/g, "/")} | ${evidenceLink(f.evidence)} | ${f.fix.replace(/\|/g, "/")} |`,
        )
      : [
          "| 1 | high | 5 | 2 | Panel output did not include structured findings | Evidence missing | Re-run with browser access and preserve screenshots |",
        ]),
    "",
    "## Pricing and offer feedback matrix",
    "| Persona | Preferred tier | WTP | Alternative | What would convert them |",
    "|---|---|---|---|---|",
    ...scorecards.map(
      (s) =>
        `| ${s.name} | ${s.tier} | ${s.willingnessToPay} | ${s.competitor.replace(/\|/g, "/")} | ${s.conversionChange.replace(/\|/g, "/")} |`,
    ),
    "",
    "## Evidence and safety audit",
    `- Room: \`${run.groupKey ?? "not created"}\``,
    `- Workflow run: \`${run.workflowRunId ?? "not started"}\``,
    `- Browser concurrency: serialized workflow; maximum one persona step at a time.`,
    `- Payment safety: prompts explicitly stopped at the provider handoff and prohibited payment details.`,
    `- Test credentials: stored only in \`~/.infinibot/secrets/launch-panel.json\` with mode 600; passwords are not included here.`,
    `- Cleanup: search the tested product for accounts containing \`+kvpanel-\` and delete/disable them after acceptance.`,
    "",
    "## Screenshot index",
    ...(screenshots.length
      ? screenshots.map((s, i) => `${i + 1}. [${path.basename(s)}](${s.replace(/ /g, "%20")})`)
      : ["No readable screenshot files were found in the transcript."]),
  ];
  return { markdown: `${lines.join("\n")}\n`, screenshotPaths: screenshots, verdict };
}

function reportsDir(): string {
  return path.join(os.homedir(), ".infinibot", "reports");
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function loadTelegram(): { token: string; target?: string } | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(resolveConfigPath(), "utf8")) as {
      channels?: { telegram?: { botToken?: string; defaultChatId?: string } };
    };
    const token = cfg.channels?.telegram?.botToken;
    return token ? { token, target: cfg.channels?.telegram?.defaultChatId } : null;
  } catch {
    return null;
  }
}

async function sendScreenshot(
  filePath: string,
  target: string,
): Promise<{ ok: boolean; error?: string }> {
  const tg = loadTelegram();
  if (!tg) return { ok: false, error: "telegram botToken not configured" };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const form = new FormData();
    form.append("chat_id", target);
    form.append("caption", `Launch Panel evidence · ${path.basename(filePath)}`);
    form.append("photo", new Blob([new Uint8Array(bytes)]), path.basename(filePath));
    const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    }).catch(
      (err) =>
        ({ ok: false, status: 0, json: async () => ({ description: String(err) }) }) as Response,
    );
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (res.ok && body.ok) return { ok: true };
    if (res.status !== 429 || attempt === 3)
      return { ok: false, error: body.description || `HTTP ${res.status}` };
    await wait(Math.max(1, body.parameters?.retry_after || 2) * 1000);
  }
  return { ok: false, error: "telegram retry limit reached" };
}

export async function writeLaunchPanelReport(params: {
  run: LaunchPanelRun;
  personas: LaunchPersona[];
  messages: GroupTranscriptMessage[];
  telegramTarget?: string;
}): Promise<{
  markdownPath: string;
  pdfPath: string;
  screenshotPaths: string[];
  telegram?: { sent: boolean; error?: string };
}> {
  const built = buildLaunchPanelMarkdown(params);
  const dir = reportsDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(params.run.createdAt).toISOString().replace(/[:.]/g, "-");
  const base = `launch-panel-${new URL(params.run.url).hostname.replace(/[^a-z0-9.-]/gi, "-")}-${stamp}`;
  const markdownPath = path.join(dir, `${base}.md`);
  const pdfPath = path.join(dir, `${base}.pdf`);
  fs.writeFileSync(markdownPath, built.markdown, "utf8");
  await renderReport(
    markdownToPayload(built.markdown, { theme: "black-gold", eyebrow: "InfiniBot · Launch Panel" }),
    { savePath: pdfPath },
  );
  emitMediaArtifact({
    agentId: "launch-panel",
    agentName: "Launch Panel",
    title: `Launch Panel · ${new URL(params.run.url).hostname}`,
    body: built.verdict,
    dedupKey: `launch-panel:${params.run.id}:${artifactHash(pdfPath)}`,
    media: { kind: "pdf", payload: { title: "Launch Panel report", filePath: pdfPath } },
  });

  let telegram: { sent: boolean; error?: string } | undefined;
  if (params.telegramTarget) {
    const summary = await sendTelegramText(
      `Launch Panel finished for ${params.run.url}\n${built.verdict}\n${built.screenshotPaths.length} screenshot(s) captured.`,
      { chatId: params.telegramTarget },
    );
    const document = await sendDocumentTelegram(pdfPath, {
      caption: `Launch Panel · ${built.verdict}`,
      chatId: params.telegramTarget,
    });
    const imageResults = [];
    for (const screenshot of built.screenshotPaths.slice(0, 4))
      imageResults.push(await sendScreenshot(screenshot, params.telegramTarget));
    const errors = [summary, document, ...imageResults]
      .filter((r) => !r.ok)
      .map((r) => r.error)
      .filter(Boolean);
    telegram = errors.length ? { sent: false, error: errors.join("; ") } : { sent: true };
  }
  return { markdownPath, pdfPath, screenshotPaths: built.screenshotPaths, telegram };
}
