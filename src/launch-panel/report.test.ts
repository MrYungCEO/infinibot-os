import { describe, expect, it } from "vitest";
import type { GroupTranscriptMessage } from "../shared/group-chat/types.js";
import { DEFAULT_LAUNCH_PERSONAS } from "./personas.js";
import {
  buildLaunchPanelMarkdown,
  extractFindings,
  extractFunnelSteps,
  extractScorecards,
} from "./report.js";

function message(stepNodeId: string, text: string): GroupTranscriptMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    groupChat: {
      kind: "agent",
      messageId: stepNodeId,
      agentId: "tester",
      agentName: "Tester",
      stepNodeId,
    },
  };
}

describe("Launch Panel report generation", () => {
  it("extracts buy decisions and prioritized gaps from room evidence", () => {
    const persona = DEFAULT_LAUNCH_PERSONAS[0]!;
    const messages = [
      message(
        `r2-${persona.id}`,
        "STEP|Sign up|pass|42|none|/tmp/signup.png\nFINDING|high|5|2|Unclear tier difference|/tmp/pricing.png|Name the outcome beside each tier",
      ),
      message(
        `r3-${persona.id}`,
        "WOULD_BUY: maybe\nTIER: ceo\nWTP: $35/month\nTOP_OBJECTION: The first win is not proven\nCOMPETITOR: YouTube plus free tools\nCONVERSION_CHANGE: Show the ten-minute first win",
      ),
    ];
    expect(extractScorecards(messages, [persona])[0]).toMatchObject({
      wouldBuy: "maybe",
      tier: "ceo",
    });
    expect(extractFindings(messages)[0]).toMatchObject({ severity: "high", reach: 5, effort: 2 });
  });

  it("accepts the Markdown-bold decision fields agents naturally emit", () => {
    const persona = DEFAULT_LAUNCH_PERSONAS[0]!;
    const score = extractScorecards(
      [
        message(
          `r3-${persona.id}`,
          "**WOULD_BUY:** no\n\n**TIER:** starter\n**WTP:** $7/month\n**TOP_OBJECTION:** code wall\n**COMPETITOR:** free tools\n**CONVERSION_CHANGE:** open demo",
        ),
      ],
      [persona],
    )[0];
    expect(score).toMatchObject({ wouldBuy: "no", tier: "starter", willingnessToPay: "$7/month" });
  });

  it("renders every required report section even when screenshot files are absent", () => {
    const persona = DEFAULT_LAUNCH_PERSONAS[0]!;
    const result = buildLaunchPanelMarkdown({
      run: {
        id: "lp-1",
        url: "https://example.com",
        personaIds: [persona.id],
        flows: ["signup"],
        depth: "quick",
        status: "completed",
        createdAt: Date.now(),
      },
      personas: [persona],
      messages: [
        message(
          `r3-${persona.id}`,
          "WOULD_BUY: no\nTIER: free\nWTP: $0\nTOP_OBJECTION: unclear value\nCOMPETITOR: free tools\nCONVERSION_CHANGE: guided demo",
        ),
      ],
    });
    expect(result.markdown).toContain("## Conversion scorecard per persona");
    expect(result.markdown).toContain("## Funnel drop-off map");
    expect(result.markdown).toContain("## Prioritized conversion gaps");
    expect(result.markdown).toContain("## Pricing and offer feedback matrix");
    expect(result.verdict).toBe("NOT READY");
  });

  it("preserves an honest partial funnel row when a long browser turn times out before STEP lines", () => {
    const persona = DEFAULT_LAUNCH_PERSONAS[0]!;
    const rows = extractFunnelSteps(
      [message(`r2-${persona.id}`, "Opened the real signup flow and reached email verification.")],
      [persona],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        persona: persona.name,
        step: "Hands-on browser audit",
        status: "partial",
        evidence: "none",
      }),
    ]);
  });
});
