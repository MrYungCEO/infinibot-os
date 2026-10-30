/**
 * Scaling roadmap (§8) and the reliability runbooks (§9).
 *
 * Static reference data, kept in the codebase rather than the database so the
 * expansion rules ship with the software and stay honest about the gate each
 * stage has to pass. The Ops surface renders these directly.
 */

export interface RoadmapStage {
  stage: "V1" | "V1.5" | "V2" | "V3" | "V4";
  phones: string;
  accounts: string;
  focus: string;
  /** What must be true before moving on. */
  gate: string;
}

export const SCALING_ROADMAP: RoadmapStage[] = [
  {
    stage: "V1",
    phones: "4",
    accounts: "12",
    focus: "Prove posting, remote control, logs and recovery.",
    gate: "Stable sessions, clean posting and a tested recovery path at 3 accounts per phone.",
  },
  {
    stage: "V1.5",
    phones: "4",
    accounts: "16–20",
    focus: "Increase density only if V1 stayed stable.",
    gate: "No session-health regressions after two weeks at the higher density.",
  },
  {
    stage: "V2",
    phones: "8–10",
    accounts: "30–40",
    focus: "Add a device agent, stronger monitoring and a spare pool.",
    gate: "Heartbeat + alerting proven, one configured spare on the shelf per rack.",
  },
  {
    stage: "V3",
    phones: "15–25",
    accounts: "50–100",
    focus: "Dedicated device gateway and richer observability.",
    gate: "Device gateway isolates handset churn from the scheduler.",
  },
  {
    stage: "V4",
    phones: "25+",
    accounts: "100+",
    focus: "Multiple racks and higher availability, if justified.",
    gate: "Demonstrated need — scale phones horizontally, leave the core architecture unchanged.",
  },
];

/** The V1 build sequence from §10, used to show where a deployment stands. */
export interface BuildPhase {
  phase: number;
  deliverable: string;
  /** Whether this implementation covers it, and how. */
  status: "implemented" | "adapter" | "physical";
  note: string;
}

export const BUILD_SEQUENCE: BuildPhase[] = [
  {
    phase: 1,
    deliverable: "Provision four phones; Tailscale, ADB and scrcpy working",
    status: "physical",
    note: "Hardware step. The Ops surface probes all three and reports what is actually reachable.",
  },
  {
    phase: 2,
    deliverable: "Device registry and live health dashboard",
    status: "implemented",
    note: "Fleet tab with battery/storage/Wi-Fi history per handset.",
  },
  {
    phase: 3,
    deliverable: "Account registry and fixed device assignments",
    status: "implemented",
    note: "Stable assignment with capacity guards at 3 accounts/phone.",
  },
  {
    phase: 4,
    deliverable: "Media upload and central content library",
    status: "implemented",
    note: "Library tab; storage adapter covers local dev, MinIO, S3 and R2.",
  },
  {
    phase: 5,
    deliverable: "Scheduler, queue and job state machine",
    status: "implemented",
    note: "Seven-state machine with guarded transitions, stagger scheduling and backoff retries.",
  },
  {
    phase: 6,
    deliverable: "Remote screen grid and one-click control",
    status: "adapter",
    note: "Live Grid renders four tiles; CONTROL opens a scrcpy session when the adapter reports available.",
  },
  {
    phase: 7,
    deliverable: "Provisioning workflow with human verification checkpoints",
    status: "implemented",
    note: "Nine-step checklist; verification and 2FA are operator-only by enforcement, not convention.",
  },
  {
    phase: 8,
    deliverable: "Posting preparation/execution workflow and logs",
    status: "adapter",
    note: "Full prepare→publish→verify loop with failure bundles; device execution runs through the ADB adapter.",
  },
  {
    phase: 9,
    deliverable: "Inbox/operator workflow",
    status: "implemented",
    note: "Assign, reply and archive with a full audit trail.",
  },
  {
    phase: 10,
    deliverable: "Backups, alerts, spare-device procedure and scaling tests",
    status: "implemented",
    note: "Ops tab: backup history, open alerts, spare runbook and the staged-update checklist.",
  },
];

export interface Runbook {
  key: string;
  title: string;
  steps: string[];
}

export const RUNBOOKS: Runbook[] = [
  {
    key: "spare_swap",
    title: "Spare device swap",
    steps: [
      "Confirm the failing handset is genuinely dead (battery, charge port, ADB state) — not just off the network.",
      "Mark it `maintenance` in the Fleet tab so the scheduler stops assigning to it.",
      "Promote the configured spare: clear `isSpare`, give it the failed handset's rack slot.",
      "Reassign the orphaned accounts to the spare one at a time; sign in and re-establish each trusted device.",
      "Re-run a health check per account, then release the spare into normal rotation.",
      "Image and shelve a replacement spare before the next posting window.",
    ],
  },
  {
    key: "staged_update",
    title: "Staged app / Android update",
    steps: [
      "Never update the whole rack at once — set one handset's update channel to `staged`.",
      "Update that handset only, then run a full post cycle on one account.",
      "Watch for session drops for 24h; a forced sign-out after an app update is the usual failure.",
      "If clean, move the next two handsets to `staged`; hold the fourth back as a known-good reference.",
      "Only after the third handset is clean, update the reference device.",
    ],
  },
  {
    key: "account_recovery",
    title: "Account recovery drill",
    steps: [
      "Confirm the recovery mailbox is reachable and still under your control.",
      "Verify the vaulted recovery codes decrypt and match the account.",
      "Run the platform's own recovery flow on the account's assigned handset — the trusted device is the strongest signal you have.",
      "If a security challenge appears, complete it as a human. Do not automate around it.",
      "Record the outcome in the audit trail and re-test the next quarter.",
    ],
  },
  {
    key: "failure_triage",
    title: "Failed job triage",
    steps: [
      "Open the job's failure bundle — screenshot plus the logcat tail captured at the moment it failed.",
      "Classify: transport (Wi-Fi/storage), session (signed out), or platform prompt (→ ACTION REQUIRED).",
      "Transport failures retry automatically with backoff; confirm the retry is scheduled.",
      "Session failures need an operator sign-in on the device before the retry can succeed.",
      "Platform prompts are never retried blindly — clear the checkpoint first, then resume.",
    ],
  },
];
