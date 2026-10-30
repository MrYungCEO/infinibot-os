/**
 * Slash Command Preview Component
 * Shows autocomplete suggestions when user types "/" in chat input
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

export interface SlashCommand {
  key: string;
  name: string;
  description: string;
  category?: string;
}

// Default commands - these should match the gateway's command registry
const DEFAULT_COMMANDS: SlashCommand[] = [
  { key: "help", name: "/help", description: "Show available commands", category: "status" },
  { key: "commands", name: "/commands", description: "List all slash commands", category: "status" },
  { key: "status", name: "/status", description: "Show current status", category: "status" },
  { key: "context", name: "/context", description: "Explain how context is built", category: "status" },
  { key: "whoami", name: "/whoami", description: "Show your sender id", category: "status" },
  { key: "new", name: "/new", description: "Start a new session", category: "session" },
  { key: "reset", name: "/reset", description: "Reset current session", category: "session" },
  { key: "compact", name: "/compact", description: "Compact session context", category: "session" },
  { key: "think", name: "/think", description: "Toggle extended thinking", category: "session" },
  { key: "reasoning", name: "/reasoning", description: "Set reasoning level", category: "session" },
  { key: "verbose", name: "/verbose", description: "Toggle verbose mode", category: "session" },
  { key: "tts", name: "/tts", description: "Control text-to-speech", category: "media" },
  { key: "models", name: "/models", description: "List or switch models", category: "config" },
  { key: "model", name: "/model", description: "Set model for session", category: "config" },
  { key: "subagents", name: "/subagents", description: "List/stop subagent runs", category: "management" },
  { key: "approve", name: "/approve", description: "Approve exec requests", category: "management" },
  { key: "skill", name: "/skill", description: "Run a skill by name", category: "tools" },
];

@customElement("slash-command-preview")
export class SlashCommandPreview extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .cmd-preview {
      position: absolute;
      bottom: 100%;
      left: 0;
      right: 0;
      max-height: 280px;
      overflow-y: auto;
      background: #0d0d0d;
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-bottom: none;
      border-radius: 8px 8px 0 0;
      box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.5);
      z-index: 100;
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--g-primary) 20%, transparent) transparent;
    }

    .cmd-preview::-webkit-scrollbar {
      width: 4px;
    }

    .cmd-preview::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 2px;
    }

    .cmd-header {
      padding: 8px 12px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      background: color-mix(in srgb, var(--g-primary) 3%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
      position: sticky;
      top: 0;
      z-index: 1;
      font-family: var(--mono, 'JetBrains Mono', monospace);
    }

    .cmd-list {
      padding: 4px;
    }

    .cmd-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.1s;
      font-family: var(--mono, 'JetBrains Mono', monospace);
    }

    .cmd-item:hover,
    .cmd-item.selected {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    }

    .cmd-item.selected {
      border-left: 2px solid var(--g-primary);
      padding-left: 8px;
    }

    .cmd-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--g-primary);
      min-width: 100px;
    }

    .cmd-desc {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.5);
      flex: 1;
    }

    .cmd-category {
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.05);
      color: rgba(255, 255, 255, 0.35);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .cmd-empty {
      padding: 16px;
      text-align: center;
      color: rgba(255, 255, 255, 0.35);
      font-size: 12px;
    }

    .cmd-hint {
      padding: 6px 12px;
      font-size: 10px;
      color: rgba(255, 255, 255, 0.3);
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      background: rgba(0, 0, 0, 0.3);
      font-family: var(--mono, 'JetBrains Mono', monospace);
    }

    .cmd-hint kbd {
      display: inline-block;
      padding: 1px 4px;
      margin: 0 2px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      font-size: 9px;
    }
  `;

  @property({ type: String }) query = "";
  @property({ type: Array }) commands: SlashCommand[] = DEFAULT_COMMANDS;
  @property({ type: Boolean }) visible = false;

  @state() private selectedIndex = 0;

  private get filteredCommands(): SlashCommand[] {
    const q = this.query.toLowerCase().replace(/^\//, "");
    if (!q) return this.commands;
    return this.commands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q) ||
        cmd.key.toLowerCase().includes(q)
    );
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("query")) {
      this.selectedIndex = 0;
    }
  }

  handleKeyDown(e: KeyboardEvent): boolean {
    if (!this.visible) return false;

    const commands = this.filteredCommands;
    if (commands.length === 0) return false;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.selectedIndex = (this.selectedIndex + 1) % commands.length;
        this.scrollToSelected();
        return true;

      case "ArrowUp":
        e.preventDefault();
        this.selectedIndex = (this.selectedIndex - 1 + commands.length) % commands.length;
        this.scrollToSelected();
        return true;

      case "Tab":
      case "Enter":
        if (commands[this.selectedIndex]) {
          e.preventDefault();
          this.selectCommand(commands[this.selectedIndex]);
          return true;
        }
        break;

      case "Escape":
        e.preventDefault();
        this.dispatchEvent(new CustomEvent("close"));
        return true;
    }

    return false;
  }

  private scrollToSelected() {
    requestAnimationFrame(() => {
      const item = this.shadowRoot?.querySelector(".cmd-item.selected");
      item?.scrollIntoView({ block: "nearest" });
    });
  }

  private selectCommand(cmd: SlashCommand) {
    this.dispatchEvent(
      new CustomEvent("select", {
        detail: { command: cmd },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    if (!this.visible) return nothing;

    const commands = this.filteredCommands;

    return html`
      <div class="cmd-preview">
        <div class="cmd-header">Slash Commands</div>
        <div class="cmd-list">
          ${commands.length === 0
            ? html`<div class="cmd-empty">No matching commands</div>`
            : commands.map(
                (cmd, i) => html`
                  <div
                    class="cmd-item ${i === this.selectedIndex ? "selected" : ""}"
                    @click=${() => this.selectCommand(cmd)}
                    @mouseenter=${() => (this.selectedIndex = i)}
                  >
                    <span class="cmd-name">${cmd.name}</span>
                    <span class="cmd-desc">${cmd.description}</span>
                    ${cmd.category
                      ? html`<span class="cmd-category">${cmd.category}</span>`
                      : nothing}
                  </div>
                `
              )}
        </div>
        <div class="cmd-hint">
          <kbd>↑↓</kbd> navigate · <kbd>Tab</kbd> or <kbd>Enter</kbd> select · <kbd>Esc</kbd> close
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "slash-command-preview": SlashCommandPreview;
  }
}
