/**
 * Global host element for the <change-notion-db-modal>.
 *
 * Mounted once at the app root. Listens for the
 * `infinibot:open-change-notion-db` CustomEvent so any view (Projects,
 * Tasks, CRM pages) can open the swap modal with one line:
 *
 *   document.dispatchEvent(new CustomEvent("infinibot:open-change-notion-db", {
 *     detail: { role: "projects", currentNotionDbId: "..." }
 *   }));
 *
 * Removes the need to thread an `onChangeNotionDb` prop through every
 * lit-render function in kanban.ts / clients.ts / etc. The host carries
 * the modal state and a captured gateway client; views just emit the
 * event from a button click.
 *
 * The gateway client is captured via `setChangeNotionDbHostClient(client)`
 * from the app shell once the websocket is up.
 */
import { LitElement, html } from "lit";
import { g8GlassStyles } from "./glass-g8.js";
import { customElement, state } from "lit/decorators.js";

import type { GatewayBrowserClient } from "../gateway";
import {
  createChangeNotionDbModalState,
  openChangeNotionDbModal,
  renderChangeNotionDbModal,
  type ChangeNotionDbModalState,
  type ChangeRoleId,
} from "./change-notion-db-modal";

let registeredClient: GatewayBrowserClient | null = null;

/**
 * Capture the gateway client for the modal to use. Called once from
 * app-render.ts after the websocket is up. Idempotent: re-calls replace
 * the previous client (e.g. after reconnect).
 */
export function setChangeNotionDbHostClient(client: GatewayBrowserClient | null): void {
  registeredClient = client;
}

/**
 * Helper that any view can call from a button click. Falls back to a
 * dispatchEvent so the call works even before app-render.ts has
 * registered itself (the host listens passively).
 */
export function requestChangeNotionDb(role: ChangeRoleId, currentNotionDbId: string | null): void {
  document.dispatchEvent(
    new CustomEvent("infinibot:open-change-notion-db", {
      detail: { role, currentNotionDbId },
    }),
  );
}

@customElement("change-notion-db-host")
export class ChangeNotionDbHost extends LitElement {
  /** Render in light DOM so the modal's global styles still apply. */
  createRenderRoot() {
    return this;
  }

  @state() private modalState: ChangeNotionDbModalState = createChangeNotionDbModalState("projects");

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("infinibot:open-change-notion-db", this._onOpen);
  }

  disconnectedCallback(): void {
    document.removeEventListener("infinibot:open-change-notion-db", this._onOpen);
    super.disconnectedCallback();
  }

  private _onOpen = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { role: ChangeRoleId; currentNotionDbId: string | null };
    if (!detail?.role) return;
    if (!registeredClient) {
      // Defensive: surface the missing-client problem to the operator
      // rather than silently no-op'ing. Most users will never hit this
      // because the app shell wires registeredClient on first hello.
      console.warn("[change-notion-db-host] gateway client not registered yet; ignoring open request");
      return;
    }
    void openChangeNotionDbModal(
      {
        client: registeredClient,
        state: this.modalState,
        requestUpdate: () => this.requestUpdate(),
      },
      detail.role,
      detail.currentNotionDbId,
    );
  };

  render() {
    if (!registeredClient) return html``;
    return html`${g8GlassStyles}<div class="g8-page g8-overlay-host">${renderChangeNotionDbModal({
        client: registeredClient,
        state: this.modalState,
        requestUpdate: () => this.requestUpdate(),
      })}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "change-notion-db-host": ChangeNotionDbHost;
  }
}
