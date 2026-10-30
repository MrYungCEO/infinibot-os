/**
 * Knowledge Graph grid panel — same graph component and refresh cadence as
 * the standalone `/knowledge-graph` page, inside a masonry tile host.
 */

import { html, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../gateway";
import "../../components/knowledge-graph.js";

export interface KnowledgeGraphPanelProps {
  client: GatewayBrowserClient | null;
}

export function renderKnowledgeGraphPanel(
  props: KnowledgeGraphPanelProps,
): TemplateResult {
  // The graph element must be the growing flex item (flex:1 + min-height:0),
  // exactly like the standalone page: without it the element sizes to its
  // content, `.kg-host { height:100% }` never resolves, and the stage stops
  // short of the tile — leaving a dead band that never tracks resize/maximize.
  return html`
    <div class="kg-grid-panel" style="height:100%;min-height:320px;display:flex;flex-direction:column;">
      <infinibot-knowledge-graph
        .client=${props.client}
        .refreshIntervalMs=${30_000}
        .compact=${true}
        style="flex:1;min-height:0;display:grid;"
      ></infinibot-knowledge-graph>
    </div>
  `;
}
