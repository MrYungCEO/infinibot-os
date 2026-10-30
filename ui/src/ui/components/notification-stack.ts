import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { NotificationsState } from "../controllers/notifications";
import { getActiveNotifications } from "../controllers/notifications";
import "./glass-notification";

@customElement("notification-stack")
export class NotificationStack extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) notifState!: NotificationsState;

  render() {
    if (!this.notifState) return nothing;
    const active = getActiveNotifications(this.notifState);
    if (active.length === 0) return nothing;

    return html`
      <div class="gn-stack">
        ${active.map(
          (n) => html`
            <glass-notification
              .notification=${n}
              .notifState=${this.notifState}
            ></glass-notification>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "notification-stack": NotificationStack;
  }
}
