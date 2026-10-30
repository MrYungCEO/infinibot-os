/**
 * Heuristic criticality classifier for autonomous tasks.
 *
 * Inputs: the task prompt + (optional) repo metadata. Output: low / medium /
 * critical. Critical tasks must be approved through the Telegram approval gate
 * before the agent is spawned.
 *
 * The classifier is deliberately conservative — when in doubt it returns
 * "critical" so a human gates the change.
 */

export type Criticality = "low" | "medium" | "critical";

const CRITICAL_KEYWORDS = [
  // destructive
  "delete", "drop ", "rm -rf", "truncate", "wipe", "purge", "destroy",
  // production / release
  "production", "prod ", "release", "deploy", "publish", "rollout",
  "force push", "force-push", "--force", "rewrite history", "rebase",
  // money / billing
  "charge", "payment", "billing", "refund", "invoice", "subscription",
  // security
  "password", "secret", "token", "api key", "credential", "rotate key",
  // schema / migration
  "migration", "migrate ", "schema change", "drop table", "alter table",
  // data exfil
  "exfiltrate", "leak", "private key", "ssh key",
  // legal / external comms
  "email all ", "notify all ", "broadcast to ", "send to customers",
];

const MEDIUM_KEYWORDS = [
  "refactor", "rename", "move ", "rewrite", "restructure",
  "delete file", "remove file", "drop column", "fix ",
  "merge", "pull request", "push ",
  "install", "uninstall", "upgrade", "downgrade",
  "config", "env ", "environment variable",
];

export interface ClassifyInput {
  prompt: string;
  agentId?: string;
  /** Whether the task is queued in the autonomous lane. */
  autonomous?: boolean;
  /** Number of files reported dirty in the working dir. */
  dirtyFiles?: number;
  /** Whether the working dir is the protected default branch. */
  onDefaultBranch?: boolean;
}

export interface ClassifyResult {
  criticality: Criticality;
  reasons: string[];
  /** Whether this task must request Telegram approval before running. */
  requiresApproval: boolean;
}

export function classifyTask(input: ClassifyInput): ClassifyResult {
  const reasons: string[] = [];
  const text = (input.prompt || "").toLowerCase();

  let level: Criticality = "low";

  for (const kw of CRITICAL_KEYWORDS) {
    if (text.includes(kw)) {
      level = "critical";
      reasons.push(`prompt mentions "${kw.trim()}"`);
      break;
    }
  }

  if (level !== "critical") {
    for (const kw of MEDIUM_KEYWORDS) {
      if (text.includes(kw)) {
        level = "medium";
        reasons.push(`prompt mentions "${kw.trim()}"`);
        break;
      }
    }
  }

  if (input.onDefaultBranch && input.autonomous) {
    if (level === "low") level = "medium";
    reasons.push("autonomous run on default branch");
  }

  if ((input.dirtyFiles ?? 0) > 50) {
    if (level === "low") level = "medium";
    reasons.push("working dir has many uncommitted changes");
  }

  if (input.autonomous && level === "low") {
    // Autonomous tasks default to medium so they always go through the
    // notification system, even if the prompt is innocuous.
    level = "medium";
    reasons.push("autonomous task — default to medium");
  }

  const requiresApproval = level === "critical";
  return { criticality: level, reasons, requiresApproval };
}
