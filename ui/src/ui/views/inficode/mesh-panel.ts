/**
 * InfiCode — MESH panel: live scrolling message log + throughput sparkline.
 * Messages come from the same mesh.message / federation.message.* stream the
 * Agent Ops map consumes (via AgencyDataBridge WorldEvents). Throughput is
 * drawn with monospace block chars — no chart library.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { InfiCodeView } from "./index.js";
import { blockSparkline, clockTime } from "./helpers.js";

export function renderMeshPanel(host: InfiCodeView): TemplateResult {
  const messages = host.recentMessages();
  const buckets = host.throughputBuckets();
  const perMin = host.messagesPerMinute();
  const peak = buckets.length ? Math.max(...buckets) : 0;

  return html`
    <div class="ic-panel" data-learn-id="inficode-mesh-log">
      <div class="ic-panel-head">
        <span class="ic-corner">┬</span>
        <span class="ic-title">MESH</span>
        <span class="ic-meta"><span>${perMin}/min</span></span>
      </div>
      <div class="ic-panel-body">
        <div class="ic-spark">${blockSparkline(buckets, 34)}</div>
        <div class="ic-spark-label">
          <span>throughput · msgs/bucket</span>
          <span>peak ${peak}</span>
        </div>
        <div style="margin-top:8px;">
          ${messages.length === 0
            ? html`<div class="ic-dim">no messages yet — mesh idle</div>`
            : messages.map(
                (m) => html`
                  <div class="ic-msg">
                    <span class="ic-msg-time">${clockTime(m.timestamp)}</span>
                    <span class="ic-msg-from">${m.fromLabel || m.from}</span>
                    <span class="ic-msg-arrow">→</span>
                    <span>${m.toLabel || m.to}</span>
                    <span class="ic-msg-type">${m.type}</span>
                  </div>
                  ${m.payload?.message
                    ? html`<div class="ic-dim" style="font-size:10px;padding-left:8px;">${String(
                        m.payload.message,
                      ).slice(0, 120)}</div>`
                    : nothing}
                `,
              )}
        </div>
      </div>
    </div>
  `;
}
