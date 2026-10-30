import { html, nothing, type TemplateResult } from "lit";

export interface ReflectionEvent {
  id: string;
  blockId: string | null;
  text: string;
  icon: string;
  color: string;
  ts: number;
}

const eventQueues = new Map<string | null, ReflectionEvent[]>();
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

let _requestUpdate: (() => void) | null = null;

export function setReflectionRequestUpdate(fn: () => void): void {
  _requestUpdate = fn;
}

export function addReflectionEvent(
  blockId: string | null,
  text: string,
  icon = "✦",
  color = "var(--g-primary)",
): void {
  const id = `rc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const event: ReflectionEvent = { id, blockId, text, icon, color, ts: Date.now() };
  const queue = eventQueues.get(blockId) ?? [];
  const next = [...queue.slice(-4), event];
  eventQueues.set(blockId, next);
  _requestUpdate?.();

  const timer = setTimeout(() => {
    removeReflectionEvent(blockId, id);
  }, 4000);
  dismissTimers.set(id, timer);
}

export function removeReflectionEvent(blockId: string | null, id: string): void {
  const queue = eventQueues.get(blockId) ?? [];
  const next = queue.filter((e) => e.id !== id);
  if (next.length === 0) {
    eventQueues.delete(blockId);
  } else {
    eventQueues.set(blockId, next);
  }
  clearTimeout(dismissTimers.get(id));
  dismissTimers.delete(id);
  _requestUpdate?.();
}

export function renderReflectionCards(
  blockId: string | null,
  color: string,
): TemplateResult | typeof nothing {
  const events = eventQueues.get(blockId);
  if (!events || events.length === 0) return nothing;
  return html`
    <div class="disc-reflection-stack" style="--bl-color:${color}">
      ${events.map((ev) => html`
        <div class="disc-reflection-card" key=${ev.id}>
          <span class="disc-reflection-icon">${ev.icon}</span>
          <span class="disc-reflection-text">${ev.text}</span>
        </div>
      `)}
    </div>
  `;
}
