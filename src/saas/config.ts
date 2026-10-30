// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
export interface ClerkConfig {
  publishableKey: string;
  secretKey: string;
  frontendApi: string;
  issuer: string;
  jwksUrl: string;
}

export function isSaasMode(): boolean {
  return false;
}

/** On-device providers stay allowed; LOCAL_PROVIDERS_ENABLED is a documented public setting. */
export function localProvidersEnabled(): boolean {
  const v = process.env.LOCAL_PROVIDERS_ENABLED;
  return v === undefined ? true : /^(1|true|yes|on)$/i.test(v.trim());
}

export function applySaasDataRoot(): void {}

export function platformSecret(_key: string): string | undefined {
  return undefined;
}

export function sealPlatformSecrets(_env: NodeJS.ProcessEnv = process.env): string[] {
  return [];
}

export function getClerkConfig(): ClerkConfig | undefined {
  return undefined;
}
