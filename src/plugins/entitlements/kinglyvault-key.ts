/**
 * KinglyVault's licence-signing PUBLIC key (RS256). Plugin entitlement tokens
 * are signed by KinglyVault with the matching private key
 * (`KINGLYVAULT_LICENSE_PRIVATE_KEY`, server env only — never in a repo).
 *
 * Fingerprint (sha256 of the DER SPKI):
 * 360c5ff5ae2cff732b0cd2692959f456c223fad4f3d818e8599ccad848c9cbbf — the same
 * key as KinglyVault `src/lib/billing/license-keys.ts` and
 * `supabase/functions/license-jwt/index.ts`. Rotate all copies together.
 *
 * Kept as a TS constant (not a .pem) so it always ships in dist and the npm
 * tarball, and so no env var or file on disk can swap in a different key.
 */
export const KINGLYVAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAupnHF9S7O+j8UWoz7rSp
DDDw1aXkQ4lUUgZfdPe2pVKjHKe0+NuiiuuGbXk2aU6vVKb6IdY3rIAgdJVBuZFf
FoFDg7BuAyPFCKm3TQdA50QUIpPCnT55xR+ggIPvDByjhRr5p8NO383+YBLpupgm
8ezqqjGAkUvqhhs1rf3110Y1w3IjfXMQFNurxwGZoJiJffUazts3I7NZjtg2g2Tg
BmKbBXYJCxb6kcUPunKlfinoPGEl4E3Gd9S18dstfaUGTz10AfhvxBqBg5fSA/q6
oiecokoSpAhnHZYbgYN20RQAmwSKWuy80/QMb8q9z279lYK1fXPp73hpis59qXVo
BQIDAQAB
-----END PUBLIC KEY-----
`;

export const KINGLYVAULT_PUBLIC_KEY_SHA256 =
  "360c5ff5ae2cff732b0cd2692959f456c223fad4f3d818e8599ccad848c9cbbf";

/**
 * KinglyVault's PLAN-licence public key: what `license-jwt` signs a member's
 * plan licence with ({ aud: "infinibot", plan, features }; the same key as
 * electron/license-public-key.pem). Accepted by the plugin gate only for the
 * plan claim: a CEO/VIP plan licence unlocks every paid first-party plugin.
 */
export const KINGLYVAULT_PLAN_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsif1DZdTKWu1Vc9avvrO
C5Ubro4pdHB3F7kVd6aZpIuc7VvUVd7rvCAznDc3XxaCmKzBsTEqegrQeTnctoG3
HyX0ulPwK4l//r8BF5hLVv6szrwXmgEsy6b1RQlr8+F8uYgHljG9hxcWwXwSmtAX
zjPB/HNZQ+b1ZhvGJKjklkM7cKQSi5cRlXbICbQah7M30wK0DjZRFjwOvwUQw0mZ
odPWmO+1cSgWzCGE5qh6JYSMxJzJ+WKf7rOhvVTu/KJV/czjIXkYB9AKL30xdo5V
20nlyrZo15a7g7ETaf1XwOAOK2FGzPxJtytIs6tomdtVQnjwcqLL+je9O1coqVIz
TQIDAQAB
-----END PUBLIC KEY-----
`;

export const KINGLYVAULT_PLAN_LICENSE_PUBLIC_KEY_SHA256 =
  "69107efefb82dcf4d23144e81fd07c129b90de1bb9f30a5dbf711365d007d5b5";
