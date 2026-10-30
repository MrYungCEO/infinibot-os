/**
 * InfiniBar — compressed bottom widget strip.
 *
 * The sidebar footer used to stack the Backup/Restore widget AND the Update
 * widget full-height, eating a chunk of vertical real estate. This strip
 * compresses them: only ONE widget body is visible at a time, with a slim
 * gold-glass header carrying a label + a cycle control to rotate to the next.
 *
 * The widgets themselves are untouched — we just host their existing render
 * functions (`renderSidebarBackupWidget`, `renderSidebarUpdateWidget`) one at a
 * time. The chosen index persists across reloads via nav-ui-state so the user
 * returns to whichever widget they last parked on.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import { icons } from "../icons";
import { renderSidebarUpdateWidget } from "./sidebar-update-widget.js";
import { renderSidebarBackupWidget } from "./sidebar-backup-widget.js";
import { ensureHomeGlassStyles } from "./home-glass";
import {
  getNavBottomStripIndex,
  cycleNavBottomStrip,
} from "../controllers/nav-ui-state.js";

interface StripSlot {
  id: string;
  label: string;
  icon: keyof typeof icons;
  render: () => TemplateResult | typeof nothing;
}

export interface SidebarBottomStripProps {
  requestUpdate?: () => void;
  client?: GatewayBrowserClient | null;
}

export function renderSidebarBottomStrip(
  props: SidebarBottomStripProps,
): TemplateResult {
  ensureHomeGlassStyles();
  const requestUpdate = props.requestUpdate ?? (() => {});

  const slots: StripSlot[] = [
    {
      id: "update",
      label: "Updates",
      icon: "sparkles",
      render: () =>
        renderSidebarUpdateWidget({
          requestUpdate,
          client: props.client ?? null,
        }),
    },
    {
      id: "backup",
      label: "Backup & Restore",
      icon: "download",
      render: () => renderSidebarBackupWidget({ requestUpdate }),
    },
  ];

  const count = slots.length;
  const index = getNavBottomStripIndex(count);
  const active = slots[index] ?? slots[0];

  return html`
    <div class="nav-strip" role="group" aria-label="Sidebar utilities">
      <div class="nav-strip__head">
        <span class="nav-strip__icon" aria-hidden="true">${icons[active.icon]}</span>
        <span class="nav-strip__label">${active.label}</span>
        <div class="nav-strip__dots" aria-hidden="true">
          ${slots.map(
            (_, i) =>
              html`<span class="nav-strip__dot ${i === index ? "is-active" : ""}"></span>`,
          )}
        </div>
        <button
          class="nav-strip__cycle"
          type="button"
          title="Show next utility (${slots.map((s) => s.label).join(" · ")})"
          aria-label="Cycle sidebar utility"
          @click=${() => {
            cycleNavBottomStrip(count);
            requestUpdate();
          }}
        >
          ${icons.chevronRight}
        </button>
      </div>
      <div class="nav-strip__body">${active.render()}</div>
    </div>
  `;
}
