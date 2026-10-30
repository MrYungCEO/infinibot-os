/**
 * `secure_research` — web research from a Secure Mode session without leaking
 * secure data. Only secure sessions get this tool (pi-tools.ts); normal
 * sessions have the regular web tools.
 */

import { Type } from "@sinclair/typebox";

import type { AnyAgentTool } from "../../agents/tools/common.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { InfinibotConfig } from "../../config/config.js";
import { SecureResearchService } from "./service.js";

const SecureResearchSchema = Type.Object({
  goal: Type.String({
    description:
      "What to find out, e.g. 'estimate the market value of the 1924 German External Loan bond and the 1935 1000 Reichsmark bond'. Stays on this machine.",
  }),
  items: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Generic item descriptions (issuer, year, denomination, type). No names, serials or owners.",
    }),
  ),
  fileIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Secure file ids (from file_context) whose analysis describes the items. Read locally only.",
    }),
  ),
  queries: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional search queries you propose. They are still sanitized and approved.",
    }),
  ),
  projectId: Type.Optional(
    Type.String({ description: "Secure project to attach the research to." }),
  ),
});

export function createSecureResearchTool(options: {
  sessionKey?: string;
  config?: InfinibotConfig;
}): AnyAgentTool {
  return {
    label: "Secure research",
    name: "secure_research",
    description:
      "Research something on the public web from Secure Mode WITHOUT leaking secure data. A local model turns the goal (and any secure files) into short generic search queries; " +
      "names, addresses, serial/account numbers, file names and exact personal amounts are stripped; the owner approves the exact queries in chat (unless auto-sanitized is on); " +
      "a local SearXNG searches and result pages are fetched with a hardened client and read by the local model only. Returns a summary, value estimates (low/high + currency) and source URLs. " +
      "Use it for valuations (collectible bonds, banknotes, coins), prices and public facts. Cite the returned source URLs in your answer. Never put personal details in `items` or `queries`.",
    parameters: SecureResearchSchema,
    execute: async (_toolCallId, args, signal) => {
      const p = (args ?? {}) as Record<string, unknown>;
      const strArr = (v: unknown) =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
      const svc = new SecureResearchService(options.config);
      const res = await svc.run(
        {
          goal: typeof p.goal === "string" ? p.goal : "",
          items: strArr(p.items),
          fileIds: strArr(p.fileIds),
          queries: strArr(p.queries),
          projectId: typeof p.projectId === "string" ? p.projectId : undefined,
          sessionKey: options.sessionKey,
        },
        { signal: signal ?? undefined },
      );
      const note =
        res.status === "done"
          ? "Answer with the value ranges and cite the source URLs. Say these are estimates from public listings, not appraisals."
          : res.status === "denied"
            ? "The owner denied the queries; nothing was sent. Ask how they want to proceed."
            : res.status === "expired"
              ? "Nobody approved the queries in time; nothing was sent. Ask the owner to approve the card and try again."
              : res.status === "blocked"
                ? "Nothing generic was left to search; ask the owner to describe the item type."
                : "The research failed; tell the owner the error.";
      return jsonResult({ ...res, note });
    },
  };
}
