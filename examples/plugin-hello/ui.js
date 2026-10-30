// Hello — UI panel. A plain custom element: no framework, no build step.
// The host imports this module and calls the default export with a container
// and { client, pluginId }; return a cleanup function.

const TAG = "hello-panel";

const CSS = `
  :host { display: block; color: var(--g-fg, #f5f5f4); font: inherit; }
  .wrap { display: grid; gap: 12px; max-width: 420px; }
  label { display: grid; gap: 6px; font-size: 0.9em; color: var(--muted, #a1a1aa); }
  input {
    min-height: 36px; padding: 0 10px; border-radius: 8px; font: inherit;
    color: inherit; background: transparent;
    border: 1px solid var(--g-line, rgba(255, 255, 255, 0.16));
  }
  button {
    justify-self: start; min-height: 36px; padding: 0 14px; border-radius: 8px;
    font: inherit; cursor: pointer; background: transparent;
    color: var(--plugin-accent, var(--g-primary, #fbbf24));
    border: 1px solid var(--plugin-accent, var(--g-primary, #fbbf24));
  }
  button:focus-visible, input:focus-visible {
    outline: 2px solid var(--plugin-accent, var(--g-primary, #fbbf24)); outline-offset: 2px;
  }
  .out { min-height: 1.4em; font-size: 1.1em; }
  .error { color: var(--g-danger, #ef4444); }
`;

class Panel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.gateway = null; // set by mount()
    this.message = "";
    this.problem = "";
  }

  connectedCallback() {
    this.draw();
  }

  async greet(name) {
    this.problem = "";
    try {
      const res = await this.gateway.request("hello.greet", { name });
      this.message = String(res?.message ?? "");
    } catch (err) {
      this.problem = err instanceof Error ? err.message : String(err);
    }
    this.draw();
  }

  draw() {
    const root = this.shadowRoot;
    const previous = root.querySelector("input")?.value ?? "";
    root.textContent = "";

    const style = document.createElement("style");
    style.textContent = CSS;

    const wrap = document.createElement("div");
    wrap.className = "wrap";

    const label = document.createElement("label");
    label.textContent = "Name";
    const input = document.createElement("input");
    input.type = "text";
    input.value = previous;
    input.placeholder = "world";
    label.append(input);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Greet";
    button.addEventListener("click", () => void this.greet(input.value));

    const out = document.createElement("div");
    out.setAttribute("role", "status");
    out.setAttribute("aria-live", "polite");
    out.className = this.problem ? "out error" : "out";
    out.textContent = this.problem || this.message; // textContent, never innerHTML

    wrap.append(label, button, out);
    root.append(style, wrap);
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, Panel);

export default function mount(container, ctx) {
  const el = document.createElement(TAG);
  el.gateway = ctx.client;
  container.replaceChildren(el);
  return () => el.remove();
}
