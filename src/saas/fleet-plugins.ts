// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
export type CloudSelfHostFeature = {
  feature: string;
  why: string;
  methods?: readonly string[];
  tools?: readonly string[];
  http?: readonly string[];
};

export type CloudPluginStatus =
  | "allowed"
  | "locked"
  | "coming-soon"
  | "self-host-only"
  | "unsupported";

export type CloudFeatureNote = { feature: string; why: string };

export type CloudPluginDecision = {
  status: CloudPluginStatus;
  loadable: boolean;
  reason?: string;
  plan: string | null;
  blockedPermissions?: Readonly<Record<string, string>>;
  selfHostOnlyFeatures?: readonly CloudFeatureNote[];
};

export function isFleetTenantMachine(_env: NodeJS.ProcessEnv = process.env): boolean {
  return false;
}

export function cloudPluginDecision(
  _id: string,
  _origin: string,
  _env: NodeJS.ProcessEnv = process.env,
): CloudPluginDecision | null {
  return null;
}

export function cloudPluginEnableRefusal(
  _id: string,
  _origin: string,
  _enabledIds: readonly string[],
  _env: NodeJS.ProcessEnv = process.env,
): string | null {
  return null;
}

export function cloudBlockedPermissions(
  _id: string,
  _env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> | null {
  return null;
}

export function selfHostOnlyMessage(f: CloudFeatureNote): string {
  return `${f.feature} is not available here: ${f.why}`;
}

export function cloudSelfHostOnlyMethod(
  _id: string,
  _method: string,
  _env: NodeJS.ProcessEnv = process.env,
): CloudSelfHostFeature | null {
  return null;
}

export function cloudSelfHostOnlyTool(
  _id: string,
  _tool: string,
  _env: NodeJS.ProcessEnv = process.env,
): CloudSelfHostFeature | null {
  return null;
}

export function cloudSelfHostOnlyHttp(
  _id: string,
  _path: string,
  _env: NodeJS.ProcessEnv = process.env,
): CloudSelfHostFeature | null {
  return null;
}
