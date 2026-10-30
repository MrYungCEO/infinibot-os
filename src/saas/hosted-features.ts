// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
export type FleetRunMode = "wake" | "always-on";

export interface HostedFeatures {
  fleet: boolean;
  runMode: FleetRunMode;
  channels: boolean;
  whatsapp: boolean;
  channelsExcluded: string[];
  cron: boolean;
  browser: boolean;
  browserSessions: number | null;
  publicUrl?: string;
  schedule?: { orchestratorUrl: string; token: string };
}

export function resolveHostedFeatures(_env: NodeJS.ProcessEnv = process.env): HostedFeatures {
  return {
    fleet: false,
    runMode: "wake",
    channels: false,
    whatsapp: false,
    channelsExcluded: [],
    cron: false,
    browser: false,
    browserSessions: null,
  };
}
