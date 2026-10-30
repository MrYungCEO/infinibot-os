import type { CommercialLicenseRow } from "./store.js";

type Env = Record<string, string | undefined>;

/** Best-effort delivery. Receipt pages always show the key even without email. */
export async function sendCommercialLicenseEmail(
  license: CommercialLicenseRow,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: boolean; reason?: string }> {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.COMMERCIAL_LICENSE_FROM_EMAIL?.trim();
  if (!key || !from || !license.token) return { sent: false, reason: "email_not_configured" };
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from,
      to: [license.email],
      subject: `Your InfiniBot ${license.tierId} commercial license`,
      text: `Your InfiniBot commercial license is active.\n\nLicensee: ${license.licensee}\nTier: ${license.tierId}\nExpires: ${license.expiresAt ?? "perpetual"}\n\nActivate:\ninfinibot license activate '${license.token}'\n\nKeep this key private. FSL-1.1-permitted use remains available without it.`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { sent: false, reason: `email_provider_${res.status}` };
  return { sent: true };
}
