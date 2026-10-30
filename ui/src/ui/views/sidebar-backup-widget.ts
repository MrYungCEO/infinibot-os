/**
 * Sidebar backup widget.
 *
 * Two compact actions that live just above the update widget at the
 * bottom of the nav sidebar:
 *   • Download — fetches GET /backup/download (which streams a fresh
 *     zip from `createBackup`) and triggers a browser download.
 *   • Restore — opens a hidden file picker, uploads the chosen .zip
 *     to POST /backup/restore (multipart/form-data), and shows the
 *     manifest summary returned by the server.
 *
 * Backend lives in src/gateway/backup-http.ts; both endpoints reuse
 * src/infra/backup.ts so they round-trip cleanly with `infinibot
 * backup` / `infinibot restore` from the CLI.
 */

import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../icons";
import { ensureHomeGlassStyles } from "./home-glass";

type WidgetState =
  | { kind: "idle" }
  | { kind: "downloading" }
  | { kind: "restoring"; progressLabel?: string }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

const STATE = {
  current: { kind: "idle" } as WidgetState,
  requestUpdate: null as null | (() => void),
};

function setState(next: WidgetState): void {
  STATE.current = next;
  STATE.requestUpdate?.();
}

async function startDownload(): Promise<void> {
  if (STATE.current.kind !== "idle") return;
  setState({ kind: "downloading" });
  try {
    const res = await fetch("/backup/download", { method: "GET" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
    }
    const blob = await res.blob();
    const dispo = res.headers.get("content-disposition") ?? "";
    const m = /filename="([^"]+)"/.exec(dispo);
    const filename = m?.[1] ?? `infinibot-backup-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19)}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
    const sizeMb = (blob.size / (1024 * 1024)).toFixed(1);
    setState({ kind: "ok", message: `Backup saved (${sizeMb} MB)` });
  } catch (err) {
    setState({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function pickAndRestore(): void {
  if (STATE.current.kind !== "idle") return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip,application/zip";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    const confirmed = window.confirm(
      `Restore from ${file.name}?\n\nThis will OVERWRITE the current install. Your existing state and workspace dirs will be moved to .bak-<timestamp> so you can roll back.`,
    );
    if (!confirmed) return;
    setState({ kind: "restoring", progressLabel: `Uploading ${file.name}…` });
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/backup/restore", {
        method: "POST",
        body: form,
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; rotated?: string[] }
        | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const rotated = body.rotated?.length ?? 0;
      setState({
        kind: "ok",
        message: `Restore complete${rotated > 0 ? ` (rotated ${rotated} dir${rotated === 1 ? "" : "s"})` : ""}. Reload to see new state.`,
      });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
  input.click();
}

function statusLine(state: WidgetState): TemplateResult | typeof nothing {
  if (state.kind === "idle") return nothing;
  let cls = "sbw-status";
  let text = "";
  if (state.kind === "downloading") {
    text = "Creating zip…";
  } else if (state.kind === "restoring") {
    text = state.progressLabel ?? "Restoring…";
  } else if (state.kind === "ok") {
    text = state.message;
    cls += " sbw-status--ok";
  } else if (state.kind === "error") {
    text = state.message;
    cls += " sbw-status--err";
  }
  return html`
    <div class=${cls}>
      <span>${text}</span>
      ${state.kind === "ok" || state.kind === "error"
        ? html`<button class="sbw-dismiss" @click=${() => setState({ kind: "idle" })}>${icons.x}</button>`
        : nothing}
    </div>
  `;
}

export function renderSidebarBackupWidget(opts: {
  requestUpdate: () => void;
}): TemplateResult {
  ensureHomeGlassStyles();
  STATE.requestUpdate = opts.requestUpdate;
  const busy = STATE.current.kind === "downloading" || STATE.current.kind === "restoring";
  return html`
    <div class="sbw">
      <div class="sbw-row">
        <button
          class="sbw-btn"
          title="Download a full backup (config, databases, credentials, workspace)"
          ?disabled=${busy}
          @click=${() => void startDownload()}
        >
          <span class="sbw-ico">${icons.download}</span>
          <span class="sbw-label">Backup</span>
        </button>
        <button
          class="sbw-btn"
          title="Restore from a backup zip — overwrites current install"
          ?disabled=${busy}
          @click=${() => pickAndRestore()}
        >
          <span class="sbw-ico">${icons.upload}</span>
          <span class="sbw-label">Restore</span>
        </button>
      </div>
      ${statusLine(STATE.current)}
    </div>
  `;
}
// NOTE: styles live in ui/src/styles/nav-enhanced.css (the ".sbw" block) so
// they share the sidebar's theme tokens and apply reliably. A previous inline
// <style> injection was unstable — Lit removes the injected node whenever this
// template re-renders, leaving the buttons with raw browser-default styling.
