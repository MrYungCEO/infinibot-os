/**
 * Knowledge Graph view — fullscreen Obsidian-style graph of every
 * InfiniBot data point. Thin wrapper around the
 * <infinibot-knowledge-graph> Lit element so the same component
 * powers both the page route and the masonry grid panel.
 */

import { html, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import "../components/knowledge-graph.js";

export function renderKnowledgeGraphView(
  client: GatewayBrowserClient | null,
): TemplateResult {
  // Full-bleed: the parent .content--knowledge-graph strips padding/gap so the
  // graph stage fills the entire viewport (nav rail → edge). No inner padding,
  // no min-height cap — the component sizes to 100% of the content area.
  return html`
    <div style="display:flex;flex-direction:column;min-height:0;height:100%;">
      <infinibot-knowledge-graph
        .client=${client}
        .secureCapable=${true}
        style="flex:1;min-height:0;display:grid;"
      ></infinibot-knowledge-graph>
    </div>
  `;
}
