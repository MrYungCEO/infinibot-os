import type { LearnTrack } from "../types.js";

/**
 * Scheduled tasks & approvals — Autonomy › Scheduled (scheduled agent tasks)
 * and the unified approvals inbox (request_approval → Telegram + web inbox).
 * Sources: ui/src/ui/views/autonomy-scheduled.ts, docs/autonomy/SCHEDULED-TASKS.md,
 * ui/src/ui/components/approvals-inbox.ts, src/gateway/server-methods/approvals.ts,
 * src/agents/tools/approval-tools.ts.
 */
export const track: LearnTrack = {
  id: "scheduled-approvals",
  title: "Scheduled tasks & approvals",
  summary:
    "Have an agent review your repos on a schedule, decide on its suggestions, and answer agents that ask for your OK.",
  overview: [
    "**Scheduled tasks** run an agent or coding CLI on a cron schedule. Each run is **read-only**: the agent reviews your repos and returns a standard report of suggested work items, each with a dev plan, verification checks and a deploy plan. The report arrives on the Autonomy page and, if you choose, in Telegram.",
    "",
    "Nothing is built or deployed without you. You approve, modify, reject or snooze each item. Approved items are built by a verified goal run in their own git worktree, and there's a **second approval** before anything deploys.",
    "",
    "**Approvals** are how any agent asks before doing something risky: a deploy, a restart, deleting data, spending money. An agent calls `request_approval`, and the request shows up in Telegram and in the approvals inbox in the command bar. If nobody answers before it expires, the answer is **deny**.",
    "",
    "This track covers:",
    "- **Scheduled tasks.** The list, a task's detail and the New task form.",
    "- **Deciding on suggestions.** The item pipeline from suggested to deployed.",
    "- **The approvals inbox.** What a request looks like and what each answer does.",
  ].join("\n"),
  category: "Autonomy",
  level: "intermediate",
  certRequired: true,
  order: 45,
  prerequisites: ["goals"],
  routes: ["/autonomy"],
  signals: ["autonomy"],
  badge: { id: "scheduled-approvals", label: "Gatekeeper", icon: "🗓️" },
  walkthroughs: [
    {
      id: "scheduled-tour",
      title: "Your scheduled tasks",
      summary:
        "Find the Scheduled tab, read a task's schedule and controls, and see where decisions wait.",
      estMinutes: 3,
      steps: [
        {
          id: "open-scheduled",
          title: "Open Autonomy › Scheduled",
          body: "Scheduled agent tasks live on the **Scheduled** tab of the Autonomy page. Click it.",
          route: "/autonomy",
          target: "learn:autonomy-tab-scheduled",
          action: { kind: "click" },
          check: { kind: "rpc", method: "scheduledTasks.list", path: "tasks", min: 0 },
          checkHint: "Loading scheduled tasks…",
        },
        {
          id: "list",
          title: "The task list",
          body: "Each row shows the schedule, who does the review, when it runs next and how the last run went. A badge tells you when items are waiting for your decision.",
          target: ["learn:scheduled-list", "learn:scheduled-intro"],
          placement: "right",
        },
        {
          id: "detail",
          title: "Run, pause or edit",
          body: "Select a task to see its repos and controls. **Run now** starts a review straight away, **Pause** stops the schedule and **Edit** changes it.",
          target: ["learn:scheduled-actions", "learn:scheduled-intro", "learn:scheduled-list"],
          practice: {
            mode: "explain",
            note: "The tour doesn't press these: Run now starts a real agent review, and Pause or Delete change your schedule.",
          },
        },
        {
          id: "needs-you",
          title: "Needs you",
          body: "Suggested items that wait for a decision land here: **Approve**, **Modify**, **Reject** or **Snooze 24h**. **Run history** below lists every review, with a link to its PDF in Reports.",
          target: ["learn:scheduled-needs", "learn:scheduled-intro", "learn:scheduled-list"],
        },
      ],
    },
    {
      id: "new-scheduled-task",
      title: "Draft a scheduled task",
      summary:
        "Open the New task form, name it, pick a schedule and see the delivery and approval options.",
      estMinutes: 4,
      prerequisites: ["scheduled-tour"],
      steps: [
        {
          id: "open-scheduled",
          title: "Go to Scheduled",
          body: "Click the **Scheduled** tab.",
          route: "/autonomy",
          target: "learn:autonomy-tab-scheduled",
          action: { kind: "click" },
        },
        {
          id: "new",
          title: "New task",
          body: "Click **New task** to open the form. Nothing is saved until you press Create.",
          target: ["learn:scheduled-new", "learn:scheduled-new-intro"],
          action: { kind: "click" },
        },
        {
          id: "name",
          title: "Name it",
          body: "Give the review a name you'll recognise in Telegram and in the run history.",
          target: "learn:scheduled-name",
          action: { kind: "input", sample: "Nightly repo review" },
        },
        {
          id: "schedule",
          title: "Pick a schedule",
          body: "Click a preset such as **Daily 09:00**, or type your own cron expression and timezone underneath.",
          target: "learn:scheduled-preset-1",
          action: { kind: "click" },
        },
        {
          id: "repos",
          title: "Repos to review",
          body: "List the repositories by path, with an optional branch. The review only reads them. Approved work happens later in a new worktree.",
          target: "learn:scheduled-repos",
        },
        {
          id: "toggles",
          title: "Delivery and approvals",
          body: "Send the report to Telegram, show it here, or both. **Start building on approve** starts the build as soon as you approve an item. **Ask before every deploy** keeps the second approval before anything ships.",
          target: "learn:scheduled-toggles",
        },
        {
          id: "create",
          title: "Create",
          body: "**Create** saves the task and it runs on schedule. **Create & run now** also starts the first review straight away.",
          target: "learn:scheduled-create",
          practice: {
            mode: "explain",
            note: "The tour doesn't create the task: a scheduled task starts real agent reviews on your repos on its schedule.",
          },
        },
        {
          id: "cancel",
          title: "Close the form",
          body: "Click **Cancel** to throw the draft away.",
          target: "learn:scheduled-cancel",
          action: { kind: "click" },
        },
      ],
    },
    {
      id: "item-pipeline",
      title: "From suggestion to deploy",
      summary: "How an approved suggestion is built, verified and deployed, and where you step in.",
      estMinutes: 3,
      prerequisites: ["scheduled-tour"],
      steps: [
        {
          id: "report",
          title: "The review report",
          body: "Every run writes a validated report: repo health (CI, failing tests, open PRs, deploy status) and work items with a priority, effort, risk, dev plan, checks and deploy plan. It becomes a PDF in Reports.",
          route: "/autonomy",
          placement: "center",
        },
        {
          id: "open-scheduled",
          title: "Open Scheduled",
          body: "Click the **Scheduled** tab.",
          target: "learn:autonomy-tab-scheduled",
          action: { kind: "click" },
        },
        {
          id: "stages",
          title: "Six stages",
          body: "Each item moves through **Suggested → Approved → Building → Verified → Deploy approval → Deployed**. The stepper on the item card shows where it is.",
          target: ["learn:scheduled-needs", "learn:scheduled-intro", "learn:scheduled-list"],
        },
        {
          id: "build",
          title: "Building is a goal run",
          body: "Approving an item creates a git worktree and branch and starts a goal run with the item's own checks. If the checks pass, the item waits for deploy approval with the diff and the test evidence.",
          target: ["learn:scheduled-needs", "learn:scheduled-intro", "learn:scheduled-list"],
        },
        {
          id: "decide",
          title: "Approve with care",
          body: "Use **Approve deploy** or **Reject deploy** once you've read the evidence. When a build or deploy fails, **Retry** or **Continue…** with an instruction.",
          target: ["learn:scheduled-needs", "learn:scheduled-intro", "learn:scheduled-list"],
          practice: {
            mode: "explain",
            note: "Approving starts real builds and deploys, so the tour never approves or rejects for you.",
          },
        },
      ],
    },
    {
      id: "approvals-inbox",
      title: "Answer an approval request",
      summary: "How agents ask for permission, where requests appear and what each answer does.",
      estMinutes: 3,
      steps: [
        {
          id: "request",
          title: "Agents ask first",
          body: "Before a risky action, an agent calls `request_approval` with a title, a summary, the exact details and a risk level. The request goes to your Telegram and to the approvals inbox at the same time.",
          route: "/autonomy",
          placement: "center",
          check: { kind: "rpc", method: "approvals.list", path: "pendingCount", min: 0 },
          checkHint: "Checking the approvals inbox…",
        },
        {
          id: "inbox",
          title: "The approvals inbox",
          body: "When something is waiting, a shield with a count appears in the command bar. Click it to open the inbox. It stays hidden while nothing needs you.",
          target: ["learn:approvals-inbox", ".topbar"],
          placement: "bottom",
        },
        {
          id: "answers",
          title: "Your answers",
          body: "**Approve** (or **Allow once**), **Always** for a tool you trust, **Deny**, or add a note and **Redirect** the agent with new instructions. A request that expires is denied, never approved.",
          target: ["learn:approvals-inbox", ".topbar"],
          practice: {
            mode: "explain",
            note: "Approving or denying is a real decision on a real request, so the tour only explains the buttons.",
          },
        },
        {
          id: "scope",
          title: "Only you can grant",
          body: "An agent can request approval but can never grant it: answering needs the operator approvals permission. Every decision is written to an audit log with who decided and where.",
          target: ["learn:approvals-inbox", ".topbar"],
        },
        {
          id: "tasks-tab",
          title: "Tasks & approvals",
          body: "Click **Tasks & approvals**. This is the older build/test task queue, where each task can require your approval before it runs.",
          target: "learn:autonomy-tab-tasks",
          action: { kind: "click" },
        },
        {
          id: "task-queue",
          title: "The task queue",
          body: "Executing, pending and recently completed tasks are listed here. Select one to see its details and pre-fire checklist on the right.",
          target: ["learn:autonomy-task-queue", "learn:autonomy-tabs"],
          placement: "right",
        },
        {
          id: "pause",
          title: "Pause autonomy",
          body: "**Pause** in the page header stops autonomous task execution until you resume. It's the quickest brake if something looks wrong.",
          target: ["learn:autonomy-pause", "learn:autonomy-header"],
          practice: {
            mode: "explain",
            note: "The tour doesn't pause autonomy for you: it stops every autonomous task until someone resumes it.",
          },
        },
      ],
    },
  ],
  quiz: [
    {
      id: "read-only",
      prompt: "What does a scheduled review run do to your repos?",
      options: [
        "Pushes fixes straight to main",
        "Reads them only and writes a report of suggested work",
        "Deletes stale branches",
        "Deploys the latest build",
      ],
      answer: 1,
      explain:
        "Scheduled reviews are read-only. Work only starts after you approve an item, in its own worktree.",
    },
    {
      id: "second-approval",
      prompt: "An approved item's build passes its checks. What happens next by default?",
      options: [
        "It deploys immediately",
        "It waits for your deploy approval with the diff and evidence",
        "It is deleted",
        "It starts another review",
      ],
      answer: 1,
      explain:
        "With “Ask before every deploy” on, a verified item waits in Deploy approval until you decide.",
    },
    {
      id: "expiry",
      prompt: "Nobody answers an approval request before it expires. What is the result?",
      options: ["Approved", "Denied", "It waits forever", "The agent decides"],
      answer: 1,
      explain: "Expiry always counts as deny, never approve.",
    },
    {
      id: "who-grants",
      prompt: "Can an agent approve its own request?",
      options: [
        "Yes, if it has write access",
        "No, answering needs the operator approvals permission",
        "Only on Telegram",
        "Only for low-risk requests",
      ],
      answer: 1,
      explain:
        "Agents can request approval but never grant it. Resolving a request needs the operator approvals scope.",
    },
  ],
};
