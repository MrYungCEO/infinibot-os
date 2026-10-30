# InfiniBot Windows Code Signing

This document explains how InfiniBot's Windows installer is signed, how to verify a
download is genuine, what to do during the interim unsigned period, and how to migrate
to a paid certificate later. Full options analysis lives in
[`docs/electron-signing-options.md`](../docs/electron-signing-options.md).

> **Owner decision pending (OSS launch):** the table below assumes InfiniBot ships
> under a *proprietary* license, which rules out SignPath Foundation's free OSS signing.
> If the repo is published under an OSI-approved license, that assumption no longer
> holds and SignPath Foundation becomes an option. Update this section once the final
> license is chosen.

## Which option InfiniBot uses

| Phase | Approach | Cost | Why |
|-------|----------|------|-----|
| **Now (interim)** | Ship unsigned + "Unblock" guidance | $0 | No legitimately-free Authenticode path exists for a non-OSI-licensed app. InfiniBot is source-available under FSL-1.1-ALv2 (not an OSI license) and sells commercial licenses, so SignPath Foundation (OSI-only, no commercial dual-licensing) does not apply. |
| **Target** | **Azure Artifact Signing** (formerly Trusted Signing) | ~$9.99/mo | Cheapest real, Windows-trusted Authenticode signature; HSM-backed (no key to leak); no license requirement; reputation builds across releases. |

> **2026 reality check:** *No* certificate — free, OV, or EV — grants an *instant* clean
> SmartScreen prompt anymore. SmartScreen trust is earned through clean download volume
> tied to a stable publisher identity. A cheap signed identity is what lets that
> reputation accumulate across versions instead of resetting every release.

Signing is wired in CI at [`.github/workflows/electron-sign.yml`](../.github/workflows/electron-sign.yml).
When the `AZURE_*` GitHub Secrets are present it signs automatically; until then it
publishes unsigned with a release notice.

## How to verify a downloaded `.exe` is genuinely signed

Once signing is live, anyone can confirm the installer is authentic and untampered.

**Command Prompt / PowerShell with the Windows SDK `signtool`:**
```
signtool verify /pa /v InfiniBot-Setup-<version>.exe
```
A valid result shows `Successfully verified` and a certificate chain ending in a
Microsoft-trusted root, with an RFC-3161 timestamp.

**PowerShell (no SDK needed):**
```powershell
Get-AuthenticodeSignature .\InfiniBot-Setup-<version>.exe | Format-List
```
Look for:
- `Status              : Valid`
- `SignerCertificate`  subject naming InfiniBot / the verified publisher identity
- `TimeStamperCertificate` present (proves *when* it was signed)

If `Status` is `NotSigned`, `HashMismatch`, or `UnknownError`, **do not trust the file** —
either it's the interim unsigned build (expected, see below) or it was tampered with.

## Interim period — running the unsigned installer safely

Until Azure signing is enabled, Windows SmartScreen will say *"Windows protected your PC"*
or *"unrecognized app"*. This is expected for any unsigned/low-reputation download — it is
**not** a malware detection. To run InfiniBot:

**Method A — Unblock via Properties (recommended):**
1. Download `InfiniBot-Setup-<version>.exe`.
2. **Right-click** the file → **Properties**.
3. At the bottom of the **General** tab, check **"Unblock"**.
4. Click **OK**, then double-click to run.

**Method B — SmartScreen prompt at launch:**
1. When *"Windows protected your PC"* appears, click **"More info"**.
2. Click **"Run anyway"**.

**Verify what you downloaded before unblocking** (optional, recommended): compare the
file's SHA-256 against the checksum published on the GitHub Release:
```powershell
Get-FileHash .\InfiniBot-Setup-<version>.exe -Algorithm SHA256
```

> Ship Method A as a one-line note next to every download link on the site / docs during
> the interim period — it removes most install-time drop-off.

## How to rotate to a paid EV cert (or any other cert) later

If the Azure path stops working, prices change, or you want a traditional cert:

1. **Acquire a cert** from a CA in the Microsoft Trusted Root Program (e.g. DigiCert,
   GlobalSign, SSL.com, Sectigo). OV is cheaper; EV gives HSM/USB-token custody but **no
   longer** an instant SmartScreen bypass — don't pay the EV premium expecting one.
2. **Store the credential** as GitHub Secrets — never commit it:
   - Cloud HSM / token providers expose a signing API; use their GitHub Action or `signtool`
     with their KSP/dlib.
   - For a PFX (OV, file-based): `WINDOWS_CERT_BASE64` (base64 of the .pfx) + `WINDOWS_CERT_PASSWORD`.
3. **Swap the signing step** in `electron-sign.yml`: replace the
   `azure/trusted-signing-action@v0` step with your CA's action or a `signtool sign`
   invocation. The build, verify, publish, and release-comment steps stay unchanged —
   only the one signing step is provider-specific.
4. **Keep the publisher identity stable.** Switching CAs resets SmartScreen reputation
   *unless* the publisher identity (subject CN/O) matches. Keep the org/name identical
   across certs to preserve accumulated trust.
5. **Always timestamp** (`/tr <rfc3161-url> /td SHA256`) so signatures stay valid after the
   cert expires.

## Secrets reference (never commit these)

Azure Artifact Signing (active path):
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
`AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE`.

SignPath Foundation (disabled stub — only if an OSS component is approved):
`SIGNPATH_API_TOKEN`, `SIGNPATH_ORG_ID` + repo vars `SIGNPATH_PROJECT_SLUG`,
`SIGNPATH_SIGNING_POLICY`.
