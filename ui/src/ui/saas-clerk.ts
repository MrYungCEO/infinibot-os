// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
declare global {
  interface Window {
    __INFINIBOT_SAAS_MODE__?: boolean;
    __INFINIBOT_CLERK_PUBLISHABLE_KEY__?: string;
    __INFINIBOT_CLERK_FRONTEND_API__?: string;
  }
}

export function isSaasMode(): boolean {
  return false;
}

export type SaasIdentity = {
  userId: string;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
};

export function getSaasIdentity(): SaasIdentity | null {
  return null;
}

export type SaasConnectIssue = {
  kind: "auth" | "no-session";
  message: string;
  count: number;
  at: number;
};

export function noteSaasConnectRejected(_kind: SaasConnectIssue["kind"], _message: string) {}

export function saasEverConnected(): boolean {
  return false;
}

export function noteSaasConnected() {}

export function getSaasConnectIssue(): SaasConnectIssue | null {
  return null;
}

export function clearSaasConnectIssue() {}

export function onSaasConnectIssue(_fn: () => void): () => void {
  return () => {};
}

export async function getClerkToken(_opts: { fresh?: boolean } = {}): Promise<string | null> {
  return null;
}

export type GateNotice = { tone: "info" | "warn"; text: string };

export async function maybeEnforceClerkGate(): Promise<void> {}

export function onSaasSessionEnd(_fn: () => void): () => void {
  return () => {};
}

export async function saasSignOut(): Promise<void> {}

export async function saasReauthenticate(): Promise<void> {}
