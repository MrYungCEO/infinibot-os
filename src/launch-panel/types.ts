import type { WorkflowRunStatus } from "../shared/group-chat/types.js";

export type LaunchPanelDevice = "desktop" | "mobile";
export type LaunchPanelDepth = "quick" | "standard" | "deep";

export interface LaunchPersona {
  id: string;
  name: string;
  avatarIcon: string;
  role: string;
  background: string;
  goals: string[];
  pains: string[];
  techLevel: "low" | "medium" | "high";
  budget: string;
  spendingAuthority: string;
  buyingTriggers: string[];
  objections: string[];
  devices: LaunchPanelDevice[];
  patience: string;
  privateInfo: string;
  enabled: boolean;
}

export interface LaunchPanelFlow {
  id: string;
  label: string;
  instruction: string;
}

export interface LaunchPanelRunInput {
  url: string;
  personaIds?: string[];
  flows?: string[];
  depth?: LaunchPanelDepth;
  testEmail?: string;
  telegram?: boolean;
  telegramTarget?: string;
}

export type LaunchPanelRunStatus =
  | "queued"
  | "running"
  | "reporting"
  | "completed"
  | "failed"
  | "cancelled";

export interface LaunchPanelRun {
  id: string;
  url: string;
  personaIds: string[];
  flows: string[];
  depth: LaunchPanelDepth;
  status: LaunchPanelRunStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  groupKey?: string;
  workflowId?: string;
  workflowRunId?: string;
  workflowStatus?: WorkflowRunStatus;
  reportMarkdownPath?: string;
  reportPdfPath?: string;
  screenshotPaths?: string[];
  error?: string;
  telegram?: {
    requested: boolean;
    target?: string;
    sent?: boolean;
    error?: string;
  };
}

export interface LaunchPanelSchedule {
  id: string;
  name: string;
  enabled: boolean;
  runAt: string;
  repeat: "none" | "daily" | "weekly";
  input: LaunchPanelRunInput;
  createdAt: number;
  lastRunId?: string;
  lastRunAt?: number;
}

export interface LaunchPanelState {
  version: 1;
  personas: LaunchPersona[];
  runs: LaunchPanelRun[];
  schedules: LaunchPanelSchedule[];
}

export interface LaunchPanelTestAccount {
  personaId: string;
  email: string;
  password: string;
  createdAt: string;
  cleanup: string;
}
