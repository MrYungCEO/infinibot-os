// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";

export function createVaultTool(_options?: { agentId?: string }): AnyAgentTool {
  return {
    label: "Vault",
    name: "vault",
    description: "Kingly Vault community management is not available in the open-source build.",
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error("not available in the open-source build");
    },
  };
}
