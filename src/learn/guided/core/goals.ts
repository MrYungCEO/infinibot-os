import type { LearnTrack } from "../types.js";

/**
 * Goals & verified completion — goal runs on Autonomy › Goals, the RESULT /
 * evidence contract, and reading verdicts on the Reviews page.
 * Sources: ui/src/ui/views/autonomy-goals.ts, docs/autonomy/GOALS.md,
 * docs/principles/VERIFIED-COMPLETION.md, ui/src/ui/views/{reviews,oversight}.
 */
export const track: LearnTrack = {
  id: "goals",
  title: "Goals & verified completion",
  summary:
    "Give an agent a goal plus checks, and let InfiniBot keep it working until the checks pass. Then read the evidence.",
  overview: [
    "A **goal run** is a goal, a set of completion checks and any agent: Claude Code, Codex, OpenCode, Gemini CLI or one of your gateway agents. The gateway keeps the agent working until every check passes, a limit runs out, or the agent keeps crashing.",
    "",
    "InfiniBot's core rule is **a process exiting is not success. Evidence is.** Every coder run ends with a RESULT block that lists its commits, changed files, checks and screenshots. The gateway checks those claims and gives the run a verdict: **VERIFIED**, **UNVERIFIED** (with reasons) or **FAILED**.",
    "",
    "This track covers:",
    "- **Starting a goal.** The New goal form on Autonomy › Goals and the check types.",
    "- **Following a run.** Filters, the how-it-works panel and what the detail view shows.",
    "- **Reading a verdict.** The Reviews page, Oversight and what the evidence rules check.",
  ].join("\n"),
  category: "Autonomy",
  level: "intermediate",
  certRequired: true,
  order: 40,
  prerequisites: ["agents"],
  routes: ["/autonomy", "/reviews"],
  signals: ["autonomy", "reviews", "oversight"],
  badge: { id: "goals", label: "Verifier", icon: "✅" },
  walkthroughs: [
    {
      id: "first-goal",
      title: "Start your first goal",
      summary: "Open the New goal form, describe a goal and see how completion checks work.",
      estMinutes: 3,
      steps: [
        {
          id: "open-goals",
          title: "Open Autonomy › Goals",
          body: "Goals is the first tab on the Autonomy page. Click it to make sure you're there.",
          route: "/autonomy",
          target: "learn:autonomy-tab-goals",
          action: { kind: "click" },
        },
        {
          id: "composer",
          title: "The New goal form",
          body: "Everything a goal run needs is on this card: the goal, the checks that prove it's done, the agent and the project folder. Click the header to fold it away when you don't need it.",
          target: "learn:goals-composer",
          placement: "right",
        },
        {
          id: "open-composer",
          title: "Open the form",
          body: "The form is folded. Click **New goal** to open it.",
          target: "learn:goals-composer-toggle",
          action: { kind: "click" },
          skipIf: { kind: "element", target: "learn:goals-goal-input" },
        },
        {
          id: "type-goal",
          title: "Describe the goal",
          body: "Say what should be true when the agent is done. Type a goal. It stays a draft until you press Start goal.",
          target: "learn:goals-goal-input",
          action: {
            kind: "input",
            sample: "Make the settings page load in under 1s and keep all tests green",
          },
        },
        {
          id: "checks",
          title: "Done when…",
          body: "Checks decide when the goal is complete, not the agent. **Command** passes when it exits 0, **File exists** and **File contains** read files, **AI judge** reviews the output and diff, and **Screenshots look right** runs `visual_verify`.",
          target: "learn:goals-checks",
        },
        {
          id: "agent",
          title: "Pick the agent and model",
          body: "Any coding CLI or gateway agent can work on a goal. Leave the model empty to use the backend default.",
          target: "learn:goals-agent",
        },
        {
          id: "start",
          title: "Start goal",
          body: "**Start goal** launches the agent in your project folder, and it keeps working until every check passes or a limit in **Advanced limits** is hit. You'll get a notification when it finishes.",
          target: "learn:goals-start",
          practice: {
            mode: "explain",
            note: "The tour doesn't start the run for you: a goal run spawns a real agent that uses your model credits and edits files in the folder you choose.",
          },
        },
      ],
    },
    {
      id: "follow-a-run",
      title: "Follow a goal run",
      summary: "Filter your runs, learn the loop and see what the run detail shows.",
      estMinutes: 3,
      prerequisites: ["first-goal"],
      steps: [
        {
          id: "list",
          title: "Your goal runs",
          body: "Every run is listed here with its status, agent, passing checks and iteration count. Runs are stored in the gateway, so they survive restarts.",
          route: "/autonomy",
          target: ["learn:goals-list", "learn:autonomy-tab-goals"],
          check: { kind: "rpc", method: "goals.list", path: "goals", min: 0 },
          checkHint: "Loading goal runs from the gateway…",
        },
        {
          id: "filter-done",
          title: "Filter by outcome",
          body: "Click **Done** to see only completed runs. **Active** shows running and paused runs, and **Failed** shows failed and exhausted ones.",
          target: "learn:goals-filter-completed",
          action: { kind: "click" },
        },
        {
          id: "filter-all",
          title: "Back to everything",
          body: "Click **All** to see every run again.",
          target: "learn:goals-filter-all",
          action: { kind: "click" },
        },
        {
          id: "loop",
          title: "The loop",
          body: "When the agent stops, every check runs. Failing output is fed back and the same session resumes. The run ends **Completed** when all checks pass, **Exhausted** at a limit, or **Failed** after repeated crashes.",
          target: ["learn:goals-how", "learn:goals-detail", "learn:goals-list"],
          placement: "left",
        },
        {
          id: "detail",
          title: "Inside a run",
          body: "Select a run to see each check's latest output and pass/fail history, and every iteration with the prompt sent and the agent's output. You can pause, re-check now, retry, or add an instruction that resumes the agent.",
          target: ["learn:goals-detail", "learn:goals-how", "learn:goals-list"],
          placement: "left",
        },
      ],
    },
    {
      id: "read-a-verdict",
      title: "Read a verdict",
      summary:
        "Find a run's review, understand VERIFIED / UNVERIFIED / FAILED and what the evidence rules check.",
      estMinutes: 4,
      steps: [
        {
          id: "contract",
          title: "The completion contract",
          body: "Every coder and sub-agent must finish with a **RESULT** block: status, summary, commits, files changed, claims with evidence, checks run and screenshots. A run that exits early is resumed in the same session.",
          placement: "center",
        },
        {
          id: "reviews",
          title: "Run reviews",
          body: "The Reviews page lists a review for every agent run: what was built, the files touched and any issues. Select a run on the left to read its full review on the right.",
          route: "/reviews",
          target: ["learn:reviews-list", "learn:reviews-filters"],
          placement: "right",
        },
        {
          id: "search",
          title: "Search reviews",
          body: "Type part of a title, run id or summary to narrow the list.",
          target: "learn:reviews-search",
          action: { kind: "input", sample: "settings" },
        },
        {
          id: "status",
          title: "Filter by build status",
          body: "**Built**, **Not built**, **Partial**, **Failed** and **Running** filter the list. The time chips next to them limit it to the last hour, day or week.",
          target: "learn:reviews-status",
        },
        {
          id: "open-oversight",
          title: "Open Oversight",
          body: "Oversight is where verdicts live. Click the **Oversight** tab.",
          target: '[data-host-subtabs="reviews"] [data-host-view="oversight"]',
          action: { kind: "click" },
        },
        {
          id: "verdicts",
          title: "Verdict chips",
          body: "Each run row shows a verdict next to its status. **VERIFIED**: the claims matched the evidence. **UNVERIFIED**: something couldn't be proven and the reasons are listed. **FAILED**: a claimed check really fails when re-run.",
          target: ["learn:oversight-main", "learn:oversight-header"],
          check: { kind: "route", path: "/reviews" },
        },
        {
          id: "evidence",
          title: "What gets checked",
          body: "Commits must exist on the run's branch, claimed files must show in the diff, and safe build or test commands are re-run. Screenshots must be real images newer than the run. Visual changes with no screenshots stay UNVERIFIED.",
          target: ["learn:oversight-decisions", "learn:oversight-main"],
        },
        {
          id: "decide",
          title: "You have the last word",
          body: "For anything not verified you can **Continue**, **Retry**, **Accept** or **Reject**, from the run detail or from Telegram. Only VERIFIED or operator-accepted runs count as done.",
          target: ["learn:oversight-main", "main.content"],
          practice: {
            mode: "explain",
            note: "Accept and Reject are real operator decisions on a run, so the tour only points them out.",
          },
        },
      ],
    },
  ],
  quiz: [
    {
      id: "exit-not-success",
      prompt: "An agent's process exits with code 0. Is the goal complete?",
      options: [
        "Yes, exit code 0 means success",
        "Only when every completion check passes",
        "Only if the agent says it's done",
        "Only after a gateway restart",
      ],
      answer: 1,
      explain:
        "A process exiting is not success. A goal run completes only when all of its checks pass.",
    },
    {
      id: "check-types",
      prompt: "Which check passes when a shell command exits 0?",
      options: ["AI judge", "File contains", "Command", "Screenshots look right"],
      answer: 2,
      explain: "A Command check runs in the project folder and passes when it exits 0.",
    },
    {
      id: "unverified",
      prompt: "A run changed UI files but attached no screenshots. What verdict does it get?",
      options: ["VERIFIED", "UNVERIFIED", "FAILED", "No verdict"],
      answer: 1,
      explain:
        "Visual changes need valid screenshots. Without them the run is UNVERIFIED and continued with instructions to use visual_verify.",
    },
    {
      id: "failed",
      prompt: "What turns a verdict into FAILED?",
      options: [
        "The run took too long",
        "A claimed passing check really fails when re-run, or a claimed commit is missing",
        "The agent used a different model",
        "The operator hasn't looked at it yet",
      ],
      answer: 1,
      explain:
        "Deterministic evidence that contradicts a claim (a failing re-run or a missing commit) makes the verdict FAILED.",
    },
    {
      id: "where-verdicts",
      prompt: "Where do you see verdict chips for sub-agent runs?",
      options: ["Reviews › Oversight", "Setup › Config", "The Launchpad", "API keys"],
      answer: 0,
      explain: "Oversight rows show the verified-completion verdict next to the run status.",
    },
  ],
};
