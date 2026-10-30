/**
 * Community Manager UI — pure helpers (no DOM), unit-tested in logic.test.ts.
 */

import {
  LIVE_MODULE_LABELS,
  type HealthCheck,
  type IntakeQuestion,
  type LiveModule,
  type Settings,
  type StatusResponse,
} from "../../../../../extensions/community-manager/src/contract.js";

export const WIZARD_STEPS = [
  { n: 1, id: "connect", label: "Connect bot" },
  { n: 2, id: "invite", label: "Invite bot" },
  { n: 3, id: "server", label: "Pick server" },
  { n: 4, id: "mapping", label: "Channels & roles" },
  { n: 5, id: "intake", label: "Onboarding questions" },
  { n: 6, id: "moderation", label: "Moderation preset" },
  { n: 7, id: "team", label: "Team" },
  { n: 8, id: "compliance", label: "Compliance" },
  { n: 9, id: "test", label: "Test run" },
  { n: 10, id: "live", label: "Go live" },
] as const;

export type WizardStepN = (typeof WIZARD_STEPS)[number]["n"];

/** `?step=<n>` → step number, or null when absent/invalid. */
export function parseStep(search: string): WizardStepN | null {
  const raw = new URLSearchParams(search).get("step");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? (n as WizardStepN) : null;
}

export function withStep(href: string, step: number | null): string {
  const url = new URL(href);
  if (step === null) url.searchParams.delete("step");
  else url.searchParams.set("step", String(step));
  return `${url.pathname}${url.search}${url.hash}`;
}

export type StepState = "done" | "current" | "todo";

/** Which wizard steps are complete, from the saved settings + status. */
export function stepStates(settings: Settings, status: StatusResponse | null, current: number): StepState[] {
  const done = (n: number): boolean => {
    switch (n) {
      case 1:
        return Boolean(status?.connection.tokenConfigured);
      case 2:
      case 3:
        return Boolean(settings.guildId);
      case 4:
        return Boolean(settings.channelMap["start-here"] && settings.roleMap.verified);
      case 5:
      case 6:
      case 7:
      case 8:
        return settings.setupStep > n;
      case 9:
        return Boolean(settings.testRun?.ok);
      case 10:
        return settings.mode !== "setup";
      default:
        return false;
    }
  };
  return WIZARD_STEPS.map((s) => (s.n === current ? "current" : done(s.n) ? "done" : "todo"));
}

export function weightTotal(questions: IntakeQuestion[]): number {
  return Math.round(questions.reduce((n, q) => n + (Number.isFinite(q.weight) ? q.weight : 0), 0));
}

export function healthTone(checks: HealthCheck[]): "ok" | "warn" | "fail" {
  if (checks.some((c) => c.state === "fail")) return "fail";
  if (checks.some((c) => c.state === "warn")) return "warn";
  return "ok";
}

export function modeLabel(
  status: (Pick<StatusResponse, "mode" | "paused"> & { liveModules?: LiveModule[] }) | null,
): { label: string; tone: "live" | "shadow" | "paused" | "setup" } {
  if (!status) return { label: "…", tone: "setup" };
  if (status.paused) return { label: "Paused", tone: "paused" };
  if (status.mode === "live") return { label: "Live", tone: "live" };
  if (status.mode === "shadow" && status.liveModules?.length) {
    const names = status.liveModules.map((m) => LIVE_MODULE_LABELS[m] ?? m);
    return { label: `Shadow · ${names.join(", ")} live`, tone: "shadow" };
  }
  if (status.mode === "shadow") return { label: "Shadow", tone: "shadow" };
  return { label: "Setup", tone: "setup" };
}

export function relTime(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  if (d < 45_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

export function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** SLA countdown "04:12" / "late 3m" / "—". */
export function slaLabel(dueAt: number | null, now = Date.now()): { text: string; late: boolean } {
  if (!dueAt) return { text: "—", late: false };
  const left = dueAt - now;
  if (left < 0) return { text: `late ${Math.ceil(-left / 60_000)}m`, late: true };
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return { text: `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`, late: false };
}

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return n.toLocaleString("en-US");
}

/** Points for an inline SVG polyline (0..w × 0..h, y inverted). */
export function sparkPoints(values: number[], w: number, h: number): string {
  if (!values.length) return "";
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  return values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
}

/** Comma/newline list → trimmed unique entries. */
export function parseList(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean))];
}
