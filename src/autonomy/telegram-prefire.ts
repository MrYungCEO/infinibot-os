/**
 * Telegram conversational adapter for the dynamic pre-fire form.
 *
 * Lets the operator drive the questionnaire without touching the web UI:
 *   /prefire <taskId>                — show current state
 *   /prefire <taskId> show           — alias
 *   /prefire <taskId> set <id> <v>   — set one answer (re-runs readiness)
 *   /prefire <taskId> ready          — operator override → agentReady=true
 *   /prefire <taskId> generate       — (re)generate the form via the LLM
 *
 * Boolean values accept yes/no/true/false. Multiselects accept comma-separated.
 */

import type { Bot } from "grammy";
import { resolve } from "node:path";

import type { PrefireField, PrefireForm } from "./types.js";

function escapeHtml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatForm(taskTitle: string, taskId: string, form: PrefireForm): string {
  const lines: string[] = [];
  lines.push(`<b>Pre-fire — ${escapeHtml(taskTitle)}</b>`);
  lines.push(`<code>${escapeHtml(taskId)}</code>`);
  if (form.summary) {
    lines.push("");
    lines.push(escapeHtml(form.summary));
  }
  lines.push("");
  for (const field of form.fields ?? []) {
    const value = form.answers?.[field.id];
    let rendered: string;
    if (value === undefined || value === null) rendered = "(unanswered)";
    else if (Array.isArray(value)) rendered = value.length > 0 ? value.join(", ") : "(unanswered)";
    else rendered = String(value);
    const required = field.required ? " *" : "";
    lines.push(
      `<b>${escapeHtml(field.label)}${required}</b> [<code>${escapeHtml(field.id)}</code>, ${field.type}]`,
    );
    if (field.help) lines.push(`<i>${escapeHtml(field.help)}</i>`);
    if (field.options && field.options.length > 0) {
      lines.push(`options: ${field.options.map((o) => escapeHtml(o)).join(" · ")}`);
    }
    lines.push(`= ${escapeHtml(rendered)}`);
    lines.push("");
  }
  if (form.agentReady) {
    lines.push("✅ Agent ready. Use <code>autonomy:queue.start</code> to fire.");
  } else if (form.readyReason) {
    lines.push(`⏳ ${escapeHtml(form.readyReason)}`);
  } else {
    lines.push("⏳ Awaiting answers.");
  }
  lines.push("");
  lines.push(
    "Commands: <code>/prefire " +
      escapeHtml(taskId) +
      " set &lt;field&gt; &lt;value&gt;</code> · <code>… ready</code> · <code>… generate</code>",
  );
  return lines.join("\n");
}

function coerceValue(field: PrefireField, raw: string): string | number | boolean | string[] {
  switch (field.type) {
    case "number":
      return Number(raw);
    case "boolean":
      return /^(y|yes|true|on|1)$/i.test(raw);
    case "multiselect":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    default:
      return raw;
  }
}

async function loadQueue() {
  const stateDir = process.env.INFINIBOT_STATE_DIR ?? resolve(process.cwd(), "state");
  const { initAutonomy, queue } = await import("./index.js");
  await initAutonomy(stateDir, {}, undefined);
  return queue;
}

export async function handlePrefireTelegramCommand(
  bot: Bot,
  chatId: number,
  rawText: string,
): Promise<void> {
  const parts = rawText.trim().split(/\s+/);
  // parts[0] = "/prefire"
  const taskId = parts[1];
  if (!taskId) {
    await bot.api.sendMessage(
      chatId,
      "Usage: <code>/prefire &lt;taskId&gt; [show|set &lt;field&gt; &lt;value&gt;|ready|generate]</code>",
      { parse_mode: "HTML" },
    );
    return;
  }
  const subcommand = (parts[2] ?? "show").toLowerCase();
  const queue = await loadQueue();
  const task = queue.getById(taskId);
  if (!task) {
    await bot.api.sendMessage(chatId, `Task not found: <code>${escapeHtml(taskId)}</code>`, {
      parse_mode: "HTML",
    });
    return;
  }

  if (subcommand === "generate") {
    const { generatePrefireForm } = await import("./prefire-form-agent.js");
    const result = await generatePrefireForm({
      taskId,
      title: task.title,
      description: task.description,
    });
    if (!result.ok || !result.form) {
      await bot.api.sendMessage(
        chatId,
        `Failed to generate form: ${escapeHtml(result.error ?? "unknown error")}`,
        { parse_mode: "HTML" },
      );
      return;
    }
    if (!task.context) task.context = {};
    const prior = task.context.prefireForm?.answers ?? {};
    task.context.prefireForm = { ...result.form, answers: { ...prior } };
    queue.persist();
    await bot.api.sendMessage(chatId, formatForm(task.title, taskId, task.context.prefireForm), {
      parse_mode: "HTML",
    });
    return;
  }

  let form = task.context?.prefireForm ?? null;
  if (!form) {
    await bot.api.sendMessage(
      chatId,
      `No form generated yet. Run <code>/prefire ${escapeHtml(taskId)} generate</code> first.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (subcommand === "show") {
    await bot.api.sendMessage(chatId, formatForm(task.title, taskId, form), {
      parse_mode: "HTML",
    });
    return;
  }

  if (subcommand === "ready") {
    form.agentReady = true;
    form.readyAt = Date.now();
    form.readyReason = "Operator marked ready via Telegram.";
    queue.persist();
    await bot.api.sendMessage(chatId, "✅ Marked ready. The orchestrator can start the loop now.");
    return;
  }

  if (subcommand === "set") {
    const fieldId = parts[3];
    if (!fieldId) {
      await bot.api.sendMessage(
        chatId,
        "Usage: <code>/prefire &lt;taskId&gt; set &lt;fieldId&gt; &lt;value&gt;</code>",
        { parse_mode: "HTML" },
      );
      return;
    }
    const field = form.fields.find((f) => f.id === fieldId);
    if (!field) {
      await bot.api.sendMessage(
        chatId,
        `Unknown field <code>${escapeHtml(fieldId)}</code>. Run <code>/prefire ${escapeHtml(taskId)} show</code>.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    const value = parts.slice(4).join(" ").trim();
    if (!value) {
      delete form.answers[fieldId];
    } else {
      form.answers[fieldId] = coerceValue(field, value);
    }
    // Re-evaluate readiness so the next /prefire show reflects whether more
    // answers are still needed.
    const { evaluatePrefireReadiness } = await import("./prefire-form-agent.js");
    const verdict = await evaluatePrefireReadiness(form, {
      taskId,
      title: task.title,
      description: task.description,
    });
    form.agentReady = verdict.ready;
    form.readyReason = verdict.reason;
    if (verdict.ready) form.readyAt = Date.now();
    queue.persist();
    await bot.api.sendMessage(chatId, formatForm(task.title, taskId, form), {
      parse_mode: "HTML",
    });
    return;
  }

  await bot.api.sendMessage(
    chatId,
    "Unknown subcommand. Try <code>show</code>, <code>set</code>, <code>ready</code>, or <code>generate</code>.",
    { parse_mode: "HTML" },
  );
}
