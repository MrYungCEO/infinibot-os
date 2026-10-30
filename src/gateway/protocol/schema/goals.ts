/**
 * goals.* RPC schemas — `/goal`-style verified autonomous runs
 * (see src/autonomy/goals). Shared by the gateway handlers and the
 * `goal_run` agent tool.
 */

import { Type, type Static } from "@sinclair/typebox";

export const GoalCheckSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ maxLength: 40 })),
    type: Type.Union([
      Type.Literal("shell"),
      Type.Literal("file"),
      Type.Literal("grep"),
      Type.Literal("llm"),
      Type.Literal("visual"),
    ]),
    label: Type.Optional(Type.String({ maxLength: 200 })),
    command: Type.Optional(Type.String({ maxLength: 4000 })),
    path: Type.Optional(Type.String({ maxLength: 1000 })),
    pattern: Type.Optional(Type.String({ maxLength: 1000 })),
    negate: Type.Optional(Type.Boolean()),
    criterion: Type.Optional(Type.String({ maxLength: 4000 })),
    routes: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 20 })),
    expectation: Type.Optional(Type.String({ maxLength: 4000 })),
    worktree: Type.Optional(Type.String({ maxLength: 1000 })),
    timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 3600 })),
  },
  { additionalProperties: false },
);

export const GoalTargetSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("cli"),
      backend: Type.Union([
        Type.Literal("claude-code"),
        Type.Literal("codex"),
        Type.Literal("opencode"),
        Type.Literal("gemini"),
      ]),
      model: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("agent"),
      agentId: Type.String({ minLength: 1 }),
      model: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

export const GoalLimitsSchema = Type.Object(
  {
    maxIterations: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
    maxWallClockSec: Type.Optional(Type.Number({ minimum: 10 })),
    iterationTimeoutSec: Type.Optional(Type.Number({ minimum: 5 })),
    checkIntervalSec: Type.Optional(Type.Number({ minimum: 0 })),
    hangSec: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const GoalsCreateParamsSchema = Type.Object(
  {
    goal: Type.String({ minLength: 1, maxLength: 20000 }),
    title: Type.Optional(Type.String({ maxLength: 200 })),
    checks: Type.Array(GoalCheckSchema, { minItems: 1, maxItems: 30 }),
    target: Type.Optional(GoalTargetSchema),
    model: Type.Optional(Type.String()),
    workdir: Type.Optional(Type.String()),
    projectId: Type.Optional(Type.String()),
    limits: Type.Optional(GoalLimitsSchema),
    notify: Type.Optional(Type.Boolean()),
    start: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const GoalsListParamsSchema = Type.Object(
  {
    status: Type.Optional(Type.Array(Type.String())),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

export const GoalIdParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const GoalsContinueParamsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    instruction: Type.Optional(Type.String({ maxLength: 20000 })),
  },
  { additionalProperties: false },
);

export const GoalsLogParamsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    iteration: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export type GoalsLogParams = Static<typeof GoalsLogParamsSchema>;
export type GoalsCreateParams = Static<typeof GoalsCreateParamsSchema>;
export type GoalsListParams = Static<typeof GoalsListParamsSchema>;
export type GoalIdParams = Static<typeof GoalIdParamsSchema>;
export type GoalsContinueParams = Static<typeof GoalsContinueParamsSchema>;
