/**
 * KinglyVault links for the CEO plan.
 *
 * The CEO plan (every paid first-party plugin) is sold and gated on KinglyVault, and
 * members download the plugin zips there too. InfiniBot Cloud only shows the label
 * and these two links; it never checks for the CEO plan itself. Both URLs are baked
 * in at build time so the owner can repoint them without a code change:
 *   VITE_KINGLYVAULT_CEO_URL        the CEO plan page ("Unlock with Vault")
 *   VITE_KINGLYVAULT_DOWNLOADS_URL  the member downloads page
 * Anything that is not an https:// URL falls back to the defaults below.
 */

export const KINGLYVAULT_CEO_URL_DEFAULT = "https://kinglyvault.com/infinibot-plugins";
export const KINGLYVAULT_DOWNLOADS_URL_DEFAULT = "https://kinglyvault.com/infinibot/downloads";

export const VAULT_INCLUDED_LABEL = "Included in CEO plan";
export const VAULT_UNLOCK_ACTION = "Unlock with Vault";
export const VAULT_DOWNLOADS_ACTION = "CEO member? Download on KinglyVault";

export type KinglyVaultUrls = { ceoUrl: string; downloadsUrl: string };

function httpsOr(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const v = raw.trim();
  try {
    return new URL(v).protocol === "https:" ? v : fallback;
  } catch {
    return fallback;
  }
}

export function kinglyVaultUrls(env: Record<string, unknown> = import.meta.env ?? {}): KinglyVaultUrls {
  return {
    ceoUrl: httpsOr(env.VITE_KINGLYVAULT_CEO_URL, KINGLYVAULT_CEO_URL_DEFAULT),
    downloadsUrl: httpsOr(env.VITE_KINGLYVAULT_DOWNLOADS_URL, KINGLYVAULT_DOWNLOADS_URL_DEFAULT),
  };
}
