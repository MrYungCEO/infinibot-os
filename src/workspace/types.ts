export type WorkspaceFrameworkKind =
  | "next"
  | "vite"
  | "react-scripts"
  | "astro"
  | "sveltekit"
  | "nuxt"
  | "remix"
  | "gatsby"
  | "expo-web"
  | "static"
  | "flask"
  | "django"
  | "fastapi"
  | "node"
  | "unknown";

export type WorkspacePackageManager = "pnpm" | "yarn" | "npm" | "bun" | "python" | "none";

export type WorkspaceCommand = {
  command: string;
  args: string[];
  env: Record<string, string>;
  display: string;
};

export type WorkspaceAppCandidate = {
  path: string;
  relativePath: string;
  name: string;
  kind: WorkspaceFrameworkKind;
  confidence: number;
};

export type WorkspaceDetection = {
  root: string;
  appPath: string;
  relativeAppPath: string;
  kind: WorkspaceFrameworkKind;
  packageManager: WorkspacePackageManager;
  installCmd: string | null;
  devCmd: string | null;
  command: WorkspaceCommand | null;
  expectedPort: number;
  portFlag: string | null;
  envHints: string[];
  confidence: number;
  missingDependencies: boolean;
  nodeVersion: string | null;
  monorepo: boolean;
  candidates: WorkspaceAppCandidate[];
  reasons: string[];
};

export type WorkspaceServerStatus = "stopped" | "installing" | "starting" | "ready" | "error";

export type WorkspaceServerRecord = {
  directoryId: string;
  projectPath: string;
  appPath: string;
  kind: WorkspaceFrameworkKind;
  status: WorkspaceServerStatus;
  port: number | null;
  previewPath: string | null;
  sessionId: string;
  logPath: string;
  command: string | null;
  startedAt: number | null;
  readyAt: number | null;
  lastAccessAt: number;
  idleTimeoutMs: number;
  error: string | null;
  exitCode?: number | null;
  /**
   * Ports tried for the current start, in order. More than one entry means
   * the dev server reported a port conflict and was relaunched on a new port.
   */
  portAttempts?: number[];
  /** Byte offset in logPath where the current launch attempt's output begins. */
  logOffset?: number;
};
