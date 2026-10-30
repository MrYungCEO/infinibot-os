import { Type } from "@sinclair/typebox";

import { NonEmptyString } from "./primitives.js";

export const ModelChoiceSchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    provider: NonEmptyString,
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
    /** True when the model accepts image input — drives the "vision" filter. */
    vision: Type.Optional(Type.Boolean()),
    unconfigured: Type.Optional(Type.Boolean()),
    available: Type.Optional(Type.Boolean()),
    allowed: Type.Optional(Type.Boolean()),
    pinned: Type.Optional(Type.Boolean()),
    /** Sourced free classification (src/agents/model-free.ts). */
    free: Type.Optional(
      Type.Union([Type.Literal("free"), Type.Literal("free-tier"), Type.Literal("local")]),
    ),
    freeNote: Type.Optional(Type.String()),
    freeSource: Type.Optional(Type.String()),
    /** The provider rejected this model as not found recently. */
    unavailable: Type.Optional(Type.Boolean()),
    /** Nearest valid model ("provider/model") to offer instead of an unavailable one. */
    suggestion: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ModelProviderInfoSchema = Type.Object(
  {
    id: NonEmptyString,
    available: Type.Optional(Type.Boolean()),
    free: Type.Optional(
      Type.Object(
        {
          kind: Type.Union([
            Type.Literal("free"),
            Type.Literal("free-tier"),
            Type.Literal("local"),
          ]),
          label: Type.String(),
          note: Type.String(),
          source: Type.String(),
          verified: Type.Optional(Type.String()),
          keyUrl: Type.Optional(Type.String()),
          count: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const AgentSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    /** Effective default model ref ("provider/model") for new sessions of this agent. */
    model: Type.Optional(NonEmptyString),
    identity: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(NonEmptyString),
          theme: Type.Optional(NonEmptyString),
          emoji: Type.Optional(NonEmptyString),
          avatar: Type.Optional(NonEmptyString),
          avatarUrl: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const AgentsListResultSchema = Type.Object(
  {
    defaultId: NonEmptyString,
    mainKey: NonEmptyString,
    scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
    agents: Type.Array(AgentSummarySchema),
  },
  { additionalProperties: false },
);

export const ModelsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const ModelsListResultSchema = Type.Object(
  {
    models: Type.Array(ModelChoiceSchema),
    /** Per-provider facts for the picker's group headers / connect rows. */
    providers: Type.Optional(Type.Array(ModelProviderInfoSchema)),
  },
  { additionalProperties: false },
);

export const SkillsStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });

export const SkillsBinsResultSchema = Type.Object(
  {
    bins: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsInstallParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    installId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  },
  { additionalProperties: false },
);

export const SkillsUpdateParamsSchema = Type.Object(
  {
    skillKey: NonEmptyString,
    enabled: Type.Optional(Type.Boolean()),
    apiKey: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
  },
  { additionalProperties: false },
);
