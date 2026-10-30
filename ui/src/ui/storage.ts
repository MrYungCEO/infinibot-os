const KEY = "infinibot.control.settings.v1";

import { isThemeMode, type ThemeMode } from "./theme";
import { detectLocale, isAppLocale, type AppLocale } from "./i18n";
import type { PerfModeSetting } from "./lib/perf-mode";
import { isCloudBuild } from "./cloud/cloud-env";

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  password: string; // Gateway password (persisted for auto-reconnect)
  sessionKey: string;
  lastActiveSessionKey: string;
  theme: ThemeMode;
  locale: AppLocale; // UI language (en/th/zh/ja)
  chatFocusMode: boolean;
  chatShowThinking: boolean;
  splitRatio: number; // Sidebar split ratio (0.4 to 0.7, default 0.6)
  navCollapsed: boolean; // Collapsible sidebar state
  navGroupsCollapsed: Record<string, boolean>; // Which nav groups are collapsed
  aiIdeEnabled: boolean; // AI IDE Panel enabled (shows tool executions)
  aiIdeCollapsed: boolean; // AI IDE Panel collapsed state
  performanceMode: PerfModeSetting; // "auto" | "on" | "off" — tones down heavy visual passes on low-end devices
};

export function loadSettings(): UiSettings {
  const defaultUrl = (() => {
    // Hosted cloud build: fully serverless, there is no gateway to connect to.
    if (isCloudBuild()) return "";
    // Check for Electron-injected URL first
    const electronUrl = (window as unknown as { __INFINIBOT_GATEWAY_URL__?: string }).__INFINIBOT_GATEWAY_URL__;
    if (electronUrl) return electronUrl;
    
    // Fallback for file:// or empty host (Electron without preload timing).
    // Use the canonical gateway port 18789 — NOT 47913 (that's the federation
    // hub port). Mixing them up caused "voice won't connect" / silent STT.
    if (!location.host || location.protocol === "file:") {
      return "ws://127.0.0.1:18789";
    }
    
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}`;
  })();

  const defaults: UiSettings = {
    gatewayUrl: defaultUrl,
    token: "",
    password: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "hud",
    locale: detectLocale(),
    chatFocusMode: false,
    chatShowThinking: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
    aiIdeEnabled: true,
    aiIdeCollapsed: false,
    performanceMode: "auto",
  };

  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    return {
      // The cloud build never takes a stored URL: a stale or planted value
      // would send the member's Clerk session token to another host.
      gatewayUrl:
        !isCloudBuild() && typeof parsed.gatewayUrl === "string" && parsed.gatewayUrl.trim()
          ? parsed.gatewayUrl.trim()
          : defaults.gatewayUrl,
      token: typeof parsed.token === "string" ? parsed.token : defaults.token,
      password: typeof parsed.password === "string" ? parsed.password : defaults.password,
      sessionKey:
        typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()
          ? parsed.sessionKey.trim()
          : defaults.sessionKey,
      lastActiveSessionKey:
        typeof parsed.lastActiveSessionKey === "string" &&
        parsed.lastActiveSessionKey.trim()
          ? parsed.lastActiveSessionKey.trim()
          : (typeof parsed.sessionKey === "string" &&
              parsed.sessionKey.trim()) ||
            defaults.lastActiveSessionKey,
      theme: isThemeMode(parsed.theme) ? parsed.theme : defaults.theme,
      locale: isAppLocale(parsed.locale) ? parsed.locale : defaults.locale,
      chatFocusMode:
        typeof parsed.chatFocusMode === "boolean"
          ? parsed.chatFocusMode
          : defaults.chatFocusMode,
      chatShowThinking:
        typeof parsed.chatShowThinking === "boolean"
          ? parsed.chatShowThinking
          : defaults.chatShowThinking,
      splitRatio:
        typeof parsed.splitRatio === "number" &&
        parsed.splitRatio >= 0.4 &&
        parsed.splitRatio <= 0.7
          ? parsed.splitRatio
          : defaults.splitRatio,
      navCollapsed:
        typeof parsed.navCollapsed === "boolean"
          ? parsed.navCollapsed
          : defaults.navCollapsed,
      navGroupsCollapsed:
        typeof parsed.navGroupsCollapsed === "object" &&
        parsed.navGroupsCollapsed !== null
          ? parsed.navGroupsCollapsed
          : defaults.navGroupsCollapsed,
      aiIdeEnabled:
        typeof parsed.aiIdeEnabled === "boolean"
          ? parsed.aiIdeEnabled
          : defaults.aiIdeEnabled,
      aiIdeCollapsed:
        typeof parsed.aiIdeCollapsed === "boolean"
          ? parsed.aiIdeCollapsed
          : defaults.aiIdeCollapsed,
      performanceMode:
        parsed.performanceMode === "on" ||
        parsed.performanceMode === "off" ||
        parsed.performanceMode === "auto"
          ? parsed.performanceMode
          : defaults.performanceMode,
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(next: UiSettings) {
  localStorage.setItem(KEY, JSON.stringify(next));
}
