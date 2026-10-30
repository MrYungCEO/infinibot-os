import { z } from "zod";

const ExecApprovalForwardTargetSchema = z
  .object({
    channel: z.string().min(1),
    to: z.string().min(1),
    accountId: z.string().optional(),
    threadId: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

const ExecApprovalForwardingSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.union([z.literal("session"), z.literal("targets"), z.literal("both")]).optional(),
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    targets: z.array(ExecApprovalForwardTargetSchema).optional(),
  })
  .strict()
  .optional();

const TelegramApprovalsSchema = z
  .object({
    enabled: z.boolean().optional(),
    chatId: z.string().optional(),
    operatorIds: z.array(z.union([z.string(), z.number()])).optional(),
    accountId: z.string().optional(),
    sources: z.array(z.string()).optional(),
    minRisk: z
      .union([z.literal("low"), z.literal("medium"), z.literal("high"), z.literal("critical")])
      .optional(),
    digestWindowMs: z.number().int().min(0).optional(),
    minIntervalMs: z.number().int().min(0).optional(),
  })
  .strict()
  .optional();

export const ApprovalsSchema = z
  .object({
    exec: ExecApprovalForwardingSchema,
    telegram: TelegramApprovalsSchema,
    checkpointTimeoutMinutes: z.number().positive().optional(),
  })
  .strict()
  .optional();
