import { LitElement, css, html } from "lit";
import { customElement } from "lit/decorators.js";

import "../components/kv-connect-card.js";

/**
 * Setup › Connect KinglyVault (/setup?view=kinglyvault).
 *
 * The same <kv-connect-card> as the onboarding step and the Plugins page:
 * one-click connect (approve on kinglyvault.com), paste a code, Connected ✓
 * with last sync, and Disconnect (revokes on both sides). Backed by the
 * kinglyvault-relay plugin's kvconnect.* RPCs.
 */
@customElement("kv-connect-settings")
export class KvConnectSettings extends LitElement {
  render() {
    return html`<kv-connect-card mode="settings"></kv-connect-card>
      <p class="muted">
        Terminal instead? Run <code>infinibot kv-connect</code> (opens kinglyvault.com to approve) or
        <code>infinibot kv-connect ABCD-EFGH</code> with a code from KinglyVault.
      </p>`;
  }

  static styles = css`
    :host {
      display: grid;
      gap: 12px;
      max-width: 760px;
    }
    .muted {
      color: var(--muted, #a8a29e);
      font-size: 0.85rem;
      margin: 0;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.82rem;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "kv-connect-settings": KvConnectSettings;
  }
}
