/**
 * scheduledTasks.* RPC schemas — Scheduled Agent Tasks
 * (see src/autonomy/scheduled-tasks). Shared by the gateway handlers and the
 * `scheduled_task` agent tool.
 */

import { Type, type Static } from "@sinclair/typebox";
import { GoalTargetSchema } from "./goals.js";

export const RepoSpecSchema = Type.Object(
  {
    label: Type.Optional(Type.String({ maxLength: 200 })),
    path: Type.String({ minLength: 1, maxLength: 1000 }),
    branch: Type.Optional(Type.String({ maxLength: 300 })),
    focus: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 30 })),
    notes: Type.Optional(Type.String({ maxLength: 4000 })),
  },
  { additionalProperties: false },
);

export const ApprovalPolicySchema = Type.Object(
  {
    mode: Type.Optional(Type.Literal("per-item")),
    autoContinueOnApprove: Type.Optional(Type.Boolean()),
    requireDeployApproval: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const TaskLimitsSchema = Type.Object(
  {
    suggestionTimeoutSec: Type.Optional(Type.Number({ minimum: 60, maximum: 6 * 3600 })),
    suggestionMaxIterations: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
    maxItems: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    devMaxIterations: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    devMaxWallClockSec: Type.Optional(Type.Number({ minimum: 60, maximum: 7 * 86400 })),
    devIterationTimeoutSec: Type.Optional(Type.Number({ minimum: 60, maximum: 24 * 3600 })),
    deployTimeoutSec: Type.Optional(Type.Number({ minimum: 10, maximum: 6 * 3600 })),
    maxConcurrentBuilds: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
  },
  { additionalProperties: false },
);

const Delivery = Type.Array(Type.Union([Type.Literal("telegram"), Type.Literal("ui")]), {
  minItems: 1,
  maxItems: 2,
});

const TaskFields = {
  name: Type.String({ minLength: 1, maxLength: 200 }),
  cron: Type.String({ minLength: 1, maxLength: 200 }),
  timezone: Type.Optional(Type.String({ maxLength: 100 })),
  assignee: Type.Optional(Type.Union([GoalTargetSchema, Type.String({ minLength: 1 })])),
  model: Type.Optional(Type.String({ maxLength: 200 })),
  repos: Type.Optional(Type.Array(Type.Union([RepoSpecSchema, Type.String()]), { maxItems: 30 })),
  instructions: Type.Optional(Type.String({ maxLength: 20_000 })),
  reportTemplate: Type.Optional(Type.Literal("work-suggestions-v1")),
  delivery: Type.Optional(Delivery),
  approval: Type.Optional(ApprovalPolicySchema),
  limits: Type.Optional(TaskLimitsSchema),
  deployCommand: Type.Optional(Type.Union([Type.String({ maxLength: 4000 }), Type.Null()])),
  enabled: Type.Optional(Type.Boolean()),
};

export const ScheduledTasksCreateParamsSchema = Type.Object(
  { ...TaskFields, runNow: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

export const ScheduledTasksUpdateParamsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    patch: Type.Object(
      {
        name: Type.Optional(TaskFields.name),
        cron: Type.Optional(TaskFields.cron),
        timezone: TaskFields.timezone,
        assignee: TaskFields.assignee,
        model: TaskFields.model,
        repos: TaskFields.repos,
        instructions: TaskFields.instructions,
        reportTemplate: TaskFields.reportTemplate,
        delivery: TaskFields.delivery,
        approval: TaskFields.approval,
        limits: TaskFields.limits,
        deployCommand: TaskFields.deployCommand,
        enabled: TaskFields.enabled,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ScheduledTaskIdParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const ScheduledTasksListParamsSchema = Type.Object(
  { includeDisabled: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

export const ScheduledTaskRunGetParamsSchema = Type.Object(
  { runId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const ScheduledTaskItemsListParamsSchema = Type.Object(
  {
    taskId: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    stages: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

export const ScheduledTaskItemGetParamsSchema = Type.Object(
  { itemId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const DECISION_ACTIONS = [
  "approve",
  "reject",
  "modify",
  "snooze",
  "start",
  "approve_deploy",
  "reject_deploy",
  "retry",
  "continue",
  "approve_low_risk",
] as const;

export const ScheduledTaskApprovalsListParamsSchema = Type.Object(
  { taskId: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

export const ScheduledTaskDecideParamsSchema = Type.Object(
  {
    /** Pipeline item id (si_…); for approve_low_risk pass runId instead. */
    itemId: Type.Optional(Type.String({ minLength: 1 })),
    runId: Type.Optional(Type.String({ minLength: 1 })),
    action: Type.Union(DECISION_ACTIONS.map((a) => Type.Literal(a))),
    instruction: Type.Optional(Type.String({ maxLength: 8000 })),
    snoozeHours: Type.Optional(Type.Number({ minimum: 0.25, maximum: 24 * 30 })),
  },
  { additionalProperties: false },
);

export type ScheduledTasksCreateParams = Static<typeof ScheduledTasksCreateParamsSchema>;
export type ScheduledTasksUpdateParams = Static<typeof ScheduledTasksUpdateParamsSchema>;
export type ScheduledTaskDecideParams = Static<typeof ScheduledTaskDecideParamsSchema>;
export type ScheduledTaskItemsListParams = Static<typeof ScheduledTaskItemsListParamsSchema>;
