import { Type } from "@sinclair/typebox";

import { getAgencyOperationsStore } from "../../agency-operations/store.js";
import { DEFAULT_AGENCY_ID } from "../../agency-operations/types.js";
import { resolveStateDir } from "../../config/paths.js";
import { type AnyAgentTool, jsonResult } from "./common.js";
import { createSlotTool } from "../../plugins/core-tool-slots.js";

function store() {
  return getAgencyOperationsStore(resolveStateDir());
}

const ClientContactsSchema = Type.Object({
  clientId: Type.Optional(Type.String({ description: "Exact client ID for direct lookup." })),
  clientName: Type.Optional(
    Type.String({
      description: "Client name — case-insensitive fuzzy match. Used when clientId is unknown.",
    }),
  ),
  agencyId: Type.Optional(
    Type.String({ description: "Agency ID scope (defaults to the default agency)." }),
  ),
});

/**
 * `client_contacts` is a Business & Agency plugin tool: core keeps the name as a slot
 * (src/plugins/core-tool-slots.ts) that the plugin fills while it is enabled.
 * With the plugin off the slot is empty and agents never see the tool.
 */
export function createClientContactsTool(): AnyAgentTool {
  return createSlotTool("client_contacts", "Business & Agency");
}

/** The real tool; the business-agency plugin fills the slot with it. */
export function createClientContactsToolImpl(): AnyAgentTool {
  return {
    name: "client_contacts",
    label: "Client Contacts",
    description:
      "Get contact details for a client — WhatsApp, Telegram, Discord, Instagram, phone, email. Pass clientId for exact lookup or clientName for fuzzy name match.",
    parameters: ClientContactsSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const agencyId =
        (typeof args.agencyId === "string" ? args.agencyId.trim() : null) ?? DEFAULT_AGENCY_ID;
      const s = store();

      let client = null;
      if (typeof args.clientId === "string" && args.clientId.trim()) {
        client = s.getClient(args.clientId.trim(), agencyId);
      } else if (typeof args.clientName === "string" && args.clientName.trim()) {
        const name = args.clientName.trim().toLowerCase();
        const all = s.listClients(agencyId);
        client =
          all.find((c) => c.name.toLowerCase() === name) ??
          all.find((c) => c.name.toLowerCase().includes(name)) ??
          null;
      }

      if (!client) {
        return jsonResult({
          found: false,
          error: "Client not found. Provide clientId or a more specific clientName.",
        });
      }

      return jsonResult({
        found: true,
        clientId: client.id,
        name: client.name,
        contacts: {
          whatsapp: client.whatsapp ?? null,
          telegram: client.telegram ?? null,
          discord: client.discord ?? null,
          instagram: client.instagram ?? null,
          phone: client.phone ?? null,
          email: client.email ?? null,
          billingEmail: client.billingEmail ?? null,
        },
      });
    },
  };
}
