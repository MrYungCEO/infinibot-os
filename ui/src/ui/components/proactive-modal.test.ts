import { describe, expect, it } from "vitest";
import "./proactive-modal.js";
import type { ProactiveModal } from "./proactive-modal.js";
import type { PopupAction, PopupEvent } from "./proactive-popup-shared.js";

function makeEvent(overrides: Partial<PopupEvent> = {}): PopupEvent {
  return {
    id: "evt_1",
    tier: "CRITICAL",
    requestedTier: "CRITICAL",
    appliedTier: "CRITICAL",
    title: "Build failed",
    body: "The deploy pipeline failed.",
    attribution: { agentId: "coder", agentName: "Coder" },
    actions: [],
    dedupKey: "test:crit",
    state: "pending",
    createdAt: Date.now(),
    actedAt: null,
    ackAction: null,
    dismissReason: null,
    snoozeUntil: null,
    voice: null,
    media: null,
    ...overrides,
  };
}

async function mount(ev: PopupEvent): Promise<ProactiveModal> {
  const el = document.createElement("proactive-modal") as ProactiveModal;
  document.body.appendChild(el);
  el.event = ev;
  await el.updateComplete;
  return el;
}

describe("proactive-modal", () => {
  it("always renders a × close button, even with no actions", async () => {
    const el = await mount(makeEvent({ actions: [] }));
    const close = el.shadowRoot!.querySelector(".pm-close");
    expect(close).not.toBeNull();
    expect(close!.getAttribute("aria-label")).toBe("Dismiss");
    el.remove();
  });

  it("renders the × close button even when actions exist", async () => {
    const actions: PopupAction[] = [{ id: "ok", kind: "complete", label: "Mark done" }];
    const el = await mount(makeEvent({ actions }));
    expect(el.shadowRoot!.querySelector(".pm-close")).not.toBeNull();
    el.remove();
  });

  it("× click emits a dismiss-kind popup-action", async () => {
    const el = await mount(makeEvent({ actions: [] }));
    let detail: { event: PopupEvent; action: PopupAction } | null = null;
    el.addEventListener("popup-action", (e) => {
      detail = (e as CustomEvent).detail;
    });
    (el.shadowRoot!.querySelector(".pm-close") as HTMLButtonElement).click();
    expect(detail).not.toBeNull();
    expect(detail!.action.kind).toBe("dismiss");
    expect(detail!.event.id).toBe("evt_1");
    el.remove();
  });

  it("Escape dismisses ONLY when the event has no actions", async () => {
    // No actions → Escape fires dismiss.
    const noAct = await mount(makeEvent({ actions: [] }));
    let fired = false;
    noAct.addEventListener("popup-action", () => {
      fired = true;
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(fired).toBe(true);
    noAct.remove();

    // With actions → Escape is ignored (CRITICAL behaviour unchanged).
    const withAct = await mount(
      makeEvent({ id: "evt_2", actions: [{ id: "ok", kind: "complete", label: "Done" }] }),
    );
    let firedWith = false;
    withAct.addEventListener("popup-action", () => {
      firedWith = true;
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(firedWith).toBe(false);
    withAct.remove();
  });
});
