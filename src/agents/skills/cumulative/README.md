# Cumulative Skills

A self-improving skill loop for InfiniBot agents. After every completed run,
the agent has the option to:

1. **Capture** the trajectory (task → steps → final output → metrics).
2. **Reflect** the trajectory into a draft `SKILL.md` via an LLM pass.
3. **Gate** the draft against quality + dedupe heuristics.
4. **Persist** accepted drafts to `<workspace>/skills/_learned/<slug>/SKILL.md`
   — the existing `loadSkillsFromDir` watcher picks them up automatically,
   no separate registration path.

A second loop runs over time:

5. **Track usage** when an existing learned skill is invoked.
6. **Self-improve** — for skills with ≥ N invocations and outside the
   cooldown window, a refinement pass rewrites the body to absorb what
   worked and add caveats from what didn't.

Architecture inspired by
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
(MIT-licensed; see `LICENSE-NOTICE.md`).

## Quick start

```ts
import {
  captureCompletion,
  incrementUsage,
  resolveCumulativeSkillsConfig,
  runSelfImprovePass,
} from "./agents/skills/cumulative/index.js";

// 1) After every agent run completes:
const result = await captureCompletion({
  trajectory: {
    source: { agentId: "main", sessionKey },
    taskPrompt: userMessage,
    steps: capturedSteps,         // { kind, label, content, tMs }[]
    finalOutput: agentOutput,
    metrics: {
      durationMs,
      totalTokens,
      toolCalls,
      clarifications,
      errored: false,
      reportedSuccess: true,
    },
  },
  // Pass any provider-agnostic LLM completion fn — Anthropic, Gemini, Ollama, …
  complete: async ({ system, user, maxOutputTokens }) =>
    callMyLLM({ system, user, maxOutputTokens }),
});
if (result.skill) {
  console.log("learned a new skill:", result.skill.name);
}

// 2) When an existing learned skill is invoked:
incrementUsage(resolveCumulativeSkillsConfig(), "tighten-checkout-funnel", "success", traj.id);

// 3) Periodically (cron / manual command):
const refinements = await runSelfImprovePass(resolveCumulativeSkillsConfig(), {
  complete: callMyLLM,
  agentIdForLookup: "main",
});
console.log("refinements:", refinements);
```

## Configuration

All thresholds are env-overridable. Sensible defaults are in
[`config.ts`](./config.ts).

| Env var | Default | What it does |
|--------|---------|--------------|
| `INFINIBOT_CUMULATIVE_SKILLS` | `1` | Master switch — set `0` to disable everything. |
| `INFINIBOT_CUMULATIVE_MAX_STEP_BYTES` | `4096` | Per-step content cap before truncation. |
| `INFINIBOT_CUMULATIVE_ROTATE_LINES` | `10000` | Trajectory file rotation threshold. |
| `INFINIBOT_CUMULATIVE_MIN_CONFIDENCE` | `0.65` | Min confidence the reflection / refine LLM must self-rate. |
| `INFINIBOT_CUMULATIVE_MAX_PROMO_TOKENS` | `60000` | Don't promote runs more expensive than this. |
| `INFINIBOT_CUMULATIVE_MAX_PROMO_DURATION_MS` | `600000` | Don't promote runs slower than this (10 min). |
| `INFINIBOT_CUMULATIVE_SELFIMPROVE_MIN_USES` | `5` | Skills below this invocation count are not refined. |
| `INFINIBOT_CUMULATIVE_SELFIMPROVE_COOLDOWN_MS` | `86400000` | Skip refinement if last one happened in this window (24 h). |
| `INFINIBOT_CUMULATIVE_RECENT_WINDOW` | `20` | Recent-trajectory ids retained per skill (input to refine). |

## Storage layout

```
~/.infinibot/                                       (CONFIG_DIR — overridable via INFINIBOT_STATE_DIR)
└── cumulative-skills/
    ├── trajectories/
    │   └── <agent-id>.jsonl                       per-agent append-only trajectory log
    └── usage/
        └── <skill-slug>.json                      per-skill usage record

<workspace>/skills/_learned/                       picked up by loadSkillsFromDir
└── <skill-slug>/
    └── SKILL.md                                   frontmatter + body
```

Trajectory files rotate to `*.jsonl.<ts>.archived` after `rotateAfterLines`.
The `SKILL.md` files live inside the workspace so they can be checked in /
versioned with the rest of the project; the usage sidecars live under
`CONFIG_DIR` because they're per-machine mutable state.

## Quality gate breakdown

**Pre-reflection** (cheap heuristics on the trajectory itself):

| Veto | Trigger |
|------|---------|
| `errored` | `trajectory.metrics.errored === true` |
| `no-output` | empty `finalOutput` |
| `too-shallow` | `< 2` steps |
| `too-expensive` | `totalTokens > maxTokensForPromotion` |
| `too-slow` | `durationMs > maxDurationMsForPromotion` |
| `noisy` | `clarifications > 1` |
| `unsuccessful` | `reportedSuccess === false` |

**Post-reflection** (after the model produces a draft):

| Veto | Trigger |
|------|---------|
| `low-confidence` | `draft.confidence < minConfidence` |
| `duplicate-name` | a learned skill with the same kebab name exists |
| `duplicate-fingerprint` | another learned skill has identical body content |

The gate is intentionally strict — it's cheap to throw away a draft, costly
to pollute the corpus with near-duplicates that bias future invocation.

## Provider-agnostic LLM

Every entry point that needs an LLM accepts a `complete({ system, user, maxOutputTokens })`
callback. InfiniBot's existing chat client routes through whichever
auth-profile is active; pass that — or a cheaper-and-faster reflection
model — through. The cumulative-skills package itself never imports an LLM
SDK directly.

## Disabling

`INFINIBOT_CUMULATIVE_SKILLS=0` disables every code path. `captureCompletion`
becomes a no-op that returns the in-memory trajectory shape without writing
anything; `runSelfImprovePass` returns `[]`. Existing learned skills on disk
stay where they are — disabling doesn't delete prior state.
