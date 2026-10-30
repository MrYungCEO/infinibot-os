/**
 * Provider catalogue RPC.
 *
 * Exposes the canonical `KNOWN_PROVIDERS` list (src/agents/known-providers.ts)
 * over the gateway so first-run / BYOK surfaces — chiefly the Electron wizard's
 * Step 4 gateway-chat picker — can render EVERY provider the user may pick,
 * not just the ones that already have discovered credentials.
 *
 * This deliberately does NOT go through pi-sdk discoverModels (which only
 * returns providers with configured keys). It returns the full catalogue,
 * optionally unioned with whatever models the live model catalog already knows
 * about. Providers with no discovered models yet get a single "(default)"
 * placeholder so the UI always has something selectable.
 *
 * NOTE: new RPC — requires a gateway restart before it is served.
 */

import type { GatewayRequestHandlers } from "./types.js";
import { listModelProviders } from "../../agents/known-providers.js";

type CatalogModel = { id: string; name: string };

export const providersCatalogHandlers: GatewayRequestHandlers = {
  "providers.catalog.list": async ({ respond }) => {
    try {
      // Best-effort union with the live model catalog. If it fails or returns
      // nothing for a provider, we still emit the provider with a placeholder.
      const modelsByProvider = new Map<string, CatalogModel[]>();
      try {
        const { loadGatewayModelCatalog } = await import("../server-model-catalog.js");
        const catalog = await loadGatewayModelCatalog();
        for (const m of catalog) {
          const list = modelsByProvider.get(m.provider) ?? [];
          list.push({ id: m.id, name: m.name || m.id });
          modelsByProvider.set(m.provider, list);
        }
      } catch {
        /* catalog unavailable (no keys / offline) — placeholders only */
      }

      const providers = listModelProviders().map((p) => {
        const models = modelsByProvider.get(p.id);
        return {
          id: p.id,
          label: p.label,
          icon: p.icon,
          category: p.category,
          envKey: p.envKey,
          // envKey === "" ⇒ keyless (local/OAuth) provider; the UI hides its
          // key field. Matches the wizard's `needsKey` toggle semantics.
          needsKey: p.envKey !== "",
          models:
            models && models.length > 0
              ? models
              : [{ id: "(default)", name: "Will be detected after key is saved" }],
        };
      });

      respond(true, { providers });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: (err as Error).message ?? String(err),
      });
    }
  },
};
