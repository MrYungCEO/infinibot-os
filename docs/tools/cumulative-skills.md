---
summary: "Cumulative skills — agents capture trajectories, distill them into reusable SKILL.md files, and self-improve over time"
read_when:
  - You want the agent to learn from completed runs and reuse what worked
  - You want to enable / disable / tune the self-improving skill loop
  - You're wiring trajectory capture into a custom agent loop
---

# Cumulative Skills

InfiniBot ships with a self-improving skill loop. After a successful agent
run, the system can distill the trajectory into a new `SKILL.md` that the
existing skill loader picks up automatically — and as that skill keeps
getting invoked, a periodic refinement pass rewrites it based on what
worked vs. what didn't.

The system is **off by default in agent loops** (it's a no-op until a
caller invokes `captureCompletion()`), but **fully wired and ready** with
sensible defaults the moment you turn it on.

> Architecturally inspired by
> [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
> (MIT licensed). The full attribution lives at
> `src/agents/skills/cumulative/LICENSE-NOTICE.md` — no source code from
> hermes-agent is copied; only the system design is adopted.

Related:
- Authored skills: [Skills](/tools/skills)
- Skills config: [Skills config](/tools/skills-config)
- CLI inspector: [`infinibot skills`](/cli/skills)

## How it works

```
┌────────────┐    ┌────────────┐    ┌──────────────┐    ┌──────────┐
│ Agent run  │ →  │ Trajectory │ →  │ Reflection   │ →  │ Storage  │
│ completion │    │ store      │    │ + Quality    │    │ (.md)    │
└────────────┘    └────────────┘    │ gate         │    └──────────┘
                                     └──────────────┘         │
                                                              ▼
                                                      ┌──────────────┐
                                                      │ Usage        │
                                                      │ tracker      │
                                                      └──────────────┘
                                                              │
                                                              ▼
                                                      ┌──────────────┐
                                                      │ Self-improve │
                                                      │ pass (cron)  │
                                                      └──────────────┘
```

**Two loops, one corpus.**

1. **Capture loop** — every completed run feeds a trajectory store. When
   the run clears the **pre-reflection gate**, an LLM call distills it
   into a draft `SKILL.md`. When the draft clears the **post-reflection
   gate**, it's persisted to the workspace skills directory.

2. **Improvement loop** — every learned skill keeps a usage record on
   disk. Once a skill has been invoked enough times and is past its
   cooldown, a refinement pass rewrites the body using the recent
   trajectories that invoked it.

Both loops are **provider-agnostic** — every LLM call is delivered via a
caller-supplied `complete({ system, user, maxOutputTokens })` callback,
so you route through whichever auth profile you want (Anthropic, Gemini,
Ollama, a cheaper reflection model, etc.).

## Storage layout

```
~/.infinibot/                                       # CONFIG_DIR
└── cumulative-skills/
    ├── trajectories/
    │   └── <agent-id>.jsonl                        # per-agent append-only log
    └── usage/
        └── <skill-slug>.json                       # per-skill usage record

<workspace>/skills/_learned/                        # picked up by loadSkillsFromDir
└── <skill-slug>/
    └── SKILL.md                                    # frontmatter + body
```

- **Trajectory files** rotate to `*.jsonl.<timestamp>.archived` after
  `rotateAfterLines`. They're per-machine logs; no need to commit them.
- **Learned `SKILL.md` files** live inside the workspace under
  `skills/_learned/`, alongside authored skills. They're versionable
  with the rest of the project — share a skill by committing its
  directory.
- **Usage sidecars** stay under `CONFIG_DIR` because they're per-machine
  mutable state (invocation counts, last-refined timestamps).

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
  // Provider-agnostic LLM completion
  complete: async ({ system, user, maxOutputTokens }) =>
    callMyLLM({ system, user, maxOutputTokens }),
});
if (result.skill) {
  console.log("learned a new skill:", result.skill.name);
}

// 2) When an existing learned skill is invoked:
incrementUsage(
  resolveCumulativeSkillsConfig(),
  "tighten-checkout-funnel",
  "success",
  traj.id,
);

// 3) Periodically (cron / manual command):
const refinements = await runSelfImprovePass(
  resolveCumulativeSkillsConfig(),
  { complete: callMyLLM, agentIdForLookup: "main" },
);
console.log("refinements:", refinements);
```

## Configuration

All thresholds are env-overridable. Defaults live in
[`src/agents/skills/cumulative/config.ts`](https://github.com/MrYungCEO/infinibot-os/blob/main/src/agents/skills/cumulative/config.ts).

| Env var | Default | What it does |
|--------|---------|--------------|
| `INFINIBOT_CUMULATIVE_SKILLS` | `1` | Master switch — set `0` to disable everything. |
| `INFINIBOT_CUMULATIVE_MAX_STEP_BYTES` | `4096` | Per-step content cap before truncation. |
| `INFINIBOT_CUMULATIVE_ROTATE_LINES` | `10000` | Trajectory file rotation threshold. |
| `INFINIBOT_CUMULATIVE_MIN_CONFIDENCE` | `0.65` | Min confidence the reflection / refine LLM must self-rate. |
| `INFINIBOT_CUMULATIVE_MAX_PROMO_TOKENS` | `60000` | Don't promote runs more expensive than this. |
| `INFINIBOT_CUMULATIVE_MAX_PROMO_DURATION_MS` | `600000` | Don't promote runs slower than this (10 min). |
| `INFINIBOT_CUMULATIVE_SELFIMPROVE_MIN_USES` | `5` | Skills below this invocation count are not refined. |
| `INFINIBOT_CUMULATIVE_SELFIMPROVE_COOLDOWN_MS` | `86400000` | Skip refinement if the last one ran inside this window (24 h). |
| `INFINIBOT_CUMULATIVE_RECENT_WINDOW` | `20` | Recent-trajectory ids retained per skill (input to refine). |

## Quality gate

The gate is intentionally strict — it's cheap to throw away a draft, and
costly to pollute the corpus with near-duplicates that bias future
invocation toward whichever was learned first.

### Pre-reflection (cheap heuristics on the trajectory itself)

| Veto | Trigger |
|------|---------|
| `errored` | `trajectory.metrics.errored === true` |
| `no-output` | empty `finalOutput` |
| `too-shallow` | `< 2` steps |
| `too-expensive` | `totalTokens > maxTokensForPromotion` |
| `too-slow` | `durationMs > maxDurationMsForPromotion` |
| `noisy` | `clarifications > 1` |
| `unsuccessful` | `reportedSuccess === false` |

### Post-reflection (after the model produces a draft)

| Veto | Trigger |
|------|---------|
| `low-confidence` | `draft.confidence < minConfidence` |
| `duplicate-name` | a learned skill with the same kebab name exists |
| `duplicate-fingerprint` | another learned skill has identical body content |

The model is asked to self-rate confidence between 0 and 1 in the same
JSON it returns the draft in. Confidence under 0.5 is the model's way of
saying "this run was too task-specific to generalize" — the gate
discards those.

## Self-improve loop

Every learned skill carries a usage record:

```json
{
  "skillKey": "tighten-checkout-funnel",
  "invocations": 12,
  "successes": 9,
  "failures": 3,
  "lastInvokedAt": "2026-04-12T18:33:01.041Z",
  "lastRefinedAt": "2026-04-08T02:11:55.218Z",
  "recentTrajectoryIds": ["traj_…", "traj_…", "…"]
}
```

`runSelfImprovePass()` walks every learned skill and refines those that:

- Have ≥ `selfImproveMinUses` invocations
- Have a non-empty `recentTrajectoryIds` window (still resolvable in the
  trajectory store)
- Are not inside the `selfImproveCooldownMs` window since `lastRefinedAt`

For each eligible skill the refine prompt receives:

1. The current `SKILL.md` body
2. The recent trajectories tagged success / failure / ambiguous

…and is asked to produce a strictly-better body or decline. The rewrite
is only persisted when the model self-rates ≥ `minConfidence`. Outcomes
returned per skill: `rewrote`, `skipped-cooldown`, `skipped-min-uses`,
`skipped-low-confidence`, `skipped-no-trajectories`, `errored`.

## Wiring the system on

The package is fully self-contained and is **not** auto-invoked by any
agent loop. Three integration points to turn it on:

1. **Agent-loop hook** — call `captureCompletion()` from wherever the
   chat / sub-agent run finishes. Fire-and-forget is fine; failures
   inside the package never throw to the caller.

2. **Skill-invocation hook** — call
   `incrementUsage(config, skillKey, "success" | "failure", trajectoryId)`
   from the spot in the agent loop that resolves a learned skill match
   and runs it.

3. **Cron entry** — wire `runSelfImprovePass()` into the existing
   schedule/cron system (e.g. nightly per agent).

A typical reflection-loop wiring uses the agent's primary model for the
`complete` callback, but a cheaper / faster model (e.g. Gemini Flash or
a local model via Ollama) is a perfectly good substitute for both
reflection and refinement — it dramatically lowers the per-run cost of
the loop.

## Disabling

Set `INFINIBOT_CUMULATIVE_SKILLS=0` (or any falsy value). Every code
path becomes a no-op:

- `captureCompletion()` returns the in-memory trajectory shape without
  writing anything.
- `runSelfImprovePass()` returns `[]`.
- `incrementUsage()` writes to disk but is harmless if no skills are
  ever produced.

Existing learned skills on disk are **not** touched when the system is
disabled — disabling only stops new learning. Re-enabling resumes from
where it left off.

## Inspecting the corpus

```bash
# List every learned skill + its current usage record
infinibot skills list --learned

# Inspect a single learned skill (frontmatter + body)
infinibot skills info <skill-slug>
```

Both commands work on the existing skill loader — learned skills appear
alongside authored ones with their `origin: learned` frontmatter flag,
so you can grep for them or filter the listing.

## License

The cumulative-skills package is part of InfiniBot and follows
[InfiniBot's license](https://github.com/MrYungCEO/infinibot-os/blob/main/LICENSE).
Architectural attribution to `hermes-agent` is preserved verbatim at
`src/agents/skills/cumulative/LICENSE-NOTICE.md` — both the
[hermes-agent MIT text](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE)
and a notice that no source code is copied.
