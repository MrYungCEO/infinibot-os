const browserSessions = new Set<string>();

export function registerLaunchPanelBrowserSession(sessionKey: string): void {
  if (sessionKey.trim()) browserSessions.add(sessionKey);
}

export function unregisterLaunchPanelBrowserSession(sessionKey: string): void {
  browserSessions.delete(sessionKey);
}

export function isLaunchPanelBrowserSession(sessionKey?: string): boolean {
  return Boolean(sessionKey && browserSessions.has(sessionKey));
}
