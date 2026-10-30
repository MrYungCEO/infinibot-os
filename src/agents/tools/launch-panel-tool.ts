import { Type } from "@sinclair/typebox";
import { callGatewayTool } from "./gateway.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const Schema = Type.Object({
  url: Type.String({ description: "Public website URL to test." }),
  personas: Type.Optional(
    Type.Array(Type.String(), { description: "Persona ids. Omit for every enabled persona." }),
  ),
  flows: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Flow ids. Omit for signup, onboarding, core use, lesson, pricing, errors and mobile nav.",
    }),
  ),
  depth: Type.Optional(
    Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("deep")]),
  ),
  testEmail: Type.Optional(
    Type.String({
      description:
        "Base inbox used for +kvpanel test accounts. Stored only in the protected credentials file.",
    }),
  ),
  telegram: Type.Optional(
    Type.Boolean({
      description: "Send the final PDF and up to four evidence screenshots to Telegram.",
    }),
  ),
  telegramTarget: Type.Optional(Type.String()),
});

export function createLaunchPanelTool(): AnyAgentTool {
  return {
    name: "launch_panel_run",
    label: "Launch Panel",
    description:
      "Start a four-round customer-avatar launch test in a persistent InfiniBot group-chat room. " +
      "Panelists drive real signup, onboarding, product, lesson, mobile, pricing and checkout-handoff flows with marked test accounts, " +
      "never pay, keep at most one browser step active at a time, and produce a black-gold PDF plus Markdown report under ~/.infinibot/reports. " +
      "Returns immediately with the run and group keys; use the Launch Panel page or launch_panel.run.get gateway RPC to watch it.",
    parameters: Schema,
    execute: async (_toolCallId, args) => {
      const p = args as Record<string, unknown>;
      const result = await callGatewayTool(
        "launch_panel.run",
        {},
        {
          url: readStringParam(p, "url", { required: true }),
          personaIds: Array.isArray(p.personas) ? p.personas : undefined,
          flows: Array.isArray(p.flows) ? p.flows : undefined,
          depth: readStringParam(p, "depth") || "standard",
          testEmail: readStringParam(p, "testEmail"),
          telegram: p.telegram === true,
          telegramTarget: readStringParam(p, "telegramTarget"),
        },
      );
      return jsonResult({ ok: true, ...(result as Record<string, unknown>) });
    },
  };
}
