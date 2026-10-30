import fs from "node:fs";
import path from "node:path";
import { ensureStateDir } from "../config/paths.js";
import { verifyCommercialLicense, type CommercialLicenseVerification } from "./token.js";

export function commercialLicensePath(): string {
  return path.join(ensureStateDir(), "commercial-license.jwt");
}

export function readActivatedCommercialLicense(): string | null {
  try {
    const value = fs.readFileSync(commercialLicensePath(), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function commercialLicenseStatus(): CommercialLicenseVerification & {
  installed: boolean;
  path: string;
} {
  const file = commercialLicensePath();
  const token = readActivatedCommercialLicense();
  if (!token)
    return {
      installed: false,
      path: file,
      valid: false,
      payload: null,
      state: "invalid",
      reason: "not_activated",
    };
  return { installed: true, path: file, ...verifyCommercialLicense(token) };
}

/** Validate first, then atomically persist with owner-only permissions. */
export function activateCommercialLicense(
  token: string,
  options: { publicKeyPem?: string } = {},
): CommercialLicenseVerification & { path: string } {
  const result = verifyCommercialLicense(token, options);
  if (!result.valid) return { ...result, path: commercialLicensePath() };
  const file = commercialLicensePath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token.trim()}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on Windows */
  }
  return { ...result, path: file };
}
