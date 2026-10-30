/**
 * queue.* RPC schemas — the persistent phase queue (src/queue). Shared by the
 * gateway handlers, the `queue_run` agent tool and the `infinibot queue` CLI.
 */

import { Type, type Static } from "@sinclair/typebox";
import { GoalCheckSchema } from "./goals.js";

const Id = Type.String({ minLength: 1, maxLength: 80 });

export const QueueStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("blocked"),
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("canceled"),
  Type.Literal("dead"),
]);

export const QueueIsolationSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("entry"),
  Type.Literal("phase"),
]);

export const QueuePhaseSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    brief: Type.Optional(Type.String({ maxLength: 40000 })),
    blockers: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 })),
    gateCriteria: Type.Optional(
      Type.Union([
        Type.String({ maxLength: 20000 }),
        Type.Array(GoalCheckSchema, { maxItems: 30 }),
      ]),
    ),
    agent: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    model: Type.Optional(Type.String({ maxLength: 200 })),
    fallbackAgent: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    workdir: Type.Optional(Type.String({ maxLength: 1000 })),
    maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    timeoutSec: Type.Optional(Type.Integer({ minimum: 10, maximum: 24 * 3600 })),
    requireVerified: Type.Optional(Type.Boolean()),
    isolation: Type.Optional(QueueIsolationSchema),
  },
  { additionalProperties: false },
);

export const QueueEnqueueParamsSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: 200 })),
    briefMd: Type.Optional(Type.String({ maxLength: 40000 })),
    phaseSpec: Type.Array(QueuePhaseSchema, { minItems: 1, maxItems: 50 }),
    priority: Type.Optional(Type.Integer({ minimum: -1000, maximum: 1000 })),
    dependsOn: Type.Optional(Type.Array(Id, { maxItems: 50 })),
    workdir: Type.Optional(Type.String({ maxLength: 1000 })),
    isolation: Type.Optional(QueueIsolationSchema),
    timeoutSec: Type.Optional(Type.Integer({ minimum: 10, maximum: 7 * 24 * 3600 })),
    idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    paused: Type.Optional(Type.Boolean()),
    /**
     * CLI permission bypass for this entry's agents (default true). false marks
     * the entry untrusted (W5): phase CLIs never get --dangerously-skip-permissions.
     */
    autoApprove: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const QueueListParamsSchema = Type.Object(
  {
    status: Type.Optional(Type.Union([QueueStatusSchema, Type.Array(QueueStatusSchema)])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);

export const QueueIdParamsSchema = Type.Object({ id: Id }, { additionalProperties: false });

export const QueueGetParamsSchema = Type.Object(
  { id: Id, events: Type.Optional(Type.Integer({ minimum: 0, maximum: 2000 })) },
  { additionalProperties: false },
);

export const QueueCancelParamsSchema = Type.Object(
  { id: Id, reason: Type.Optional(Type.String({ maxLength: 500 })) },
  { additionalProperties: false },
);

export const QueuePauseParamsSchema = Type.Object(
  {
    id: Id,
    /** Stop the running attempt now (not counted) instead of parking after it settles. */
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const QueueRetryParamsSchema = Type.Object(
  {
    id: Id,
    /** Restart from this phase index (default: the current phase). */
    fromPhase: Type.Optional(Type.Integer({ minimum: 0, maximum: 49 })),
    /** Extra instruction appended to the next attempt's prompt. */
    instruction: Type.Optional(Type.String({ maxLength: 8000 })),
    /** Start a fresh agent session instead of resuming the last one. */
    freshSession: Type.Optional(Type.Boolean()),
    /** Switch the retried phase to another agent (CLI backend or gateway agent id). */
    agent: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    /** Switch the retried phase's model ("" = backend default). */
    model: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const QueueAdvanceParamsSchema = Type.Object(
  { id: Id, reason: Type.Optional(Type.String({ maxLength: 500 })) },
  { additionalProperties: false },
);

export const QueueReorderParamsSchema = Type.Object(
  { id: Id, priority: Type.Integer({ minimum: -1000, maximum: 1000 }) },
  { additionalProperties: false },
);

export const QueueLogsParamsSchema = Type.Object(
  {
    id: Id,
    /** Attempt row id (default: the latest attempt of the entry). */
    attemptId: Type.Optional(Type.Integer({ minimum: 1 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 100, maximum: 200000 })),
  },
  { additionalProperties: false },
);

export const QueueMetricsParamsSchema = Type.Object(
  { sinceMs: Type.Optional(Type.Integer({ minimum: 0 })) },
  { additionalProperties: false },
);

export const QueueBackendsParamsSchema = Type.Object(
  { refresh: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

export const QueueSetPausedParamsSchema = Type.Object(
  { paused: Type.Boolean() },
  { additionalProperties: false },
);

export type QueueEnqueueParams = Static<typeof QueueEnqueueParamsSchema>;
export type QueueListParams = Static<typeof QueueListParamsSchema>;
export type QueueIdParams = Static<typeof QueueIdParamsSchema>;
export type QueueGetParams = Static<typeof QueueGetParamsSchema>;
export type QueueCancelParams = Static<typeof QueueCancelParamsSchema>;
export type QueuePauseParams = Static<typeof QueuePauseParamsSchema>;
export type QueueRetryParams = Static<typeof QueueRetryParamsSchema>;
export type QueueAdvanceParams = Static<typeof QueueAdvanceParamsSchema>;
export type QueueReorderParams = Static<typeof QueueReorderParamsSchema>;
export type QueueLogsParams = Static<typeof QueueLogsParamsSchema>;
export type QueueMetricsParams = Static<typeof QueueMetricsParamsSchema>;
export type QueueBackendsParams = Static<typeof QueueBackendsParamsSchema>;
export type QueueSetPausedParams = Static<typeof QueueSetPausedParamsSchema>;
