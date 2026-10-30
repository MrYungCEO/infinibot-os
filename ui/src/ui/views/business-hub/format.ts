/** Business hub — number, money and time formatting shared by every section. */

export function money(cents: number | null | undefined, currency = "USD", opts: { compact?: boolean; sign?: boolean } = {}): string {
  const v = (cents ?? 0) / 100;
  try {
    const s = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      notation: opts.compact && Math.abs(v) >= 10_000 ? "compact" : "standard",
      maximumFractionDigits: opts.compact ? (Math.abs(v) >= 10_000 ? 1 : 0) : Math.abs(v) >= 1000 ? 0 : 2,
      signDisplay: opts.sign ? "exceptZero" : "auto",
    }).format(v);
    return s;
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

export function num(n: number | null | undefined, compact = false): string {
  return new Intl.NumberFormat(undefined, { notation: compact && Math.abs(n ?? 0) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n ?? 0);
}

export function pct(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Relative change vs previous period, or null when there is no baseline. */
export function delta(cur: number, prev: number): number | null {
  if (!prev) return cur ? null : 0;
  return (cur - prev) / Math.abs(prev);
}

export function relTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const fut = diff < 0;
  const f = (n: number, u: string) => (fut ? `in ${n}${u}` : `${n}${u} ago`);
  if (abs < 60_000) return fut ? "soon" : "just now";
  if (abs < 3_600_000) return f(Math.round(abs / 60_000), "m");
  if (abs < 86_400_000) return f(Math.round(abs / 3_600_000), "h");
  if (abs < 30 * 86_400_000) return f(Math.round(abs / 86_400_000), "d");
  return date(ms);
}

export function date(ms: number | null | undefined, withTime = false): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric", ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}) });
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "?").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** Deterministic hue for avatars (kept inside the gold/amber/bronze family). */
export function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 25 + (h % 30);
}

export function toInputDate(ms: number | null | undefined): string {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

export function fromInputDate(v: string): number | null {
  if (!v) return null;
  const t = Date.parse(`${v}T12:00:00`);
  return Number.isFinite(t) ? t : null;
}

export const LIFECYCLE_LABEL: Record<string, string> = {
  subscriber: "Subscriber",
  lead: "Lead",
  qualified: "Qualified",
  customer: "Customer",
  churned: "Churned",
};

export const ACTIVITY_LABEL: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  note: "Note",
  merge: "Merged",
  "stage.changed": "Stage",
  "form.submitted": "Form",
  "page.viewed": "Visit",
  "email.sent": "Email sent",
  "email.opened": "Opened",
  "email.clicked": "Clicked",
  "email.replied": "Replied",
  "email.bounced": "Bounced",
  "email.unsubscribed": "Unsubscribed",
  payment: "Payment",
  "leadgen.imported": "Lead found",
  "client.linked": "Client",
  "deal.won": "Won",
  "import.undone": "Import undone",
};
