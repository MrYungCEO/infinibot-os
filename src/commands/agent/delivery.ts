import { AGENT_LANE_NESTED } from "../../agents/lanes.js";
import { isSecureSessionKey } from "../../secure-mode/session-key.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import type { InfinibotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { buildOutboundResultEnvelope } from "../../infra/outbound/envelope.js";
import {
  formatOutboundPayloadLog,
  type NormalizedOutboundPayload,
  normalizeOutboundPayloads,
  normalizeOutboundPayloadsForJson,
} from "../../infra/outbound/payloads.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import type { RuntimeEnv } from "../../runtime.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { AgentCommandOpts } from "./types.js";

type RunResult = Awaited<
  ReturnType<(typeof import("../../agents/pi-embedded.js"))["runEmbeddedPiAgent"]>
>;

const NESTED_LOG_PREFIX = "[agent:nested]";

/**
 * Fallback text delivered when an agent turn produced only tool calls (or empty/
 * whitespace text) but a reply is expected on an external channel. Without this,
 * such turns silently drop and the user sees nothing.
 */
const EMPTY_AGENT_REPLY_FALLBACK = "✅ Done — I finished that. (No additional details to report.)";

/** A payload counts as deliverable only if it carries visible content. */
function payloadHasRenderableContent(payload: ReplyPayload): boolean {
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
  const hasChannelData = Boolean(
    payload.channelData && Object.keys(payload.channelData).length > 0,
  );
  return text.length > 0 || hasMedia || hasChannelData;
}

function hasDeliverableContent(payloads: ReplyPayload[] | undefined | null): boolean {
  return Boolean(payloads?.some(payloadHasRenderableContent));
}

function formatNestedLogPrefix(opts: AgentCommandOpts): string {
  const parts = [NESTED_LOG_PREFIX];
  const session = opts.sessionKey ?? opts.sessionId;
  if (session) parts.push(`session=${session}`);
  if (opts.runId) parts.push(`run=${opts.runId}`);
  const channel = opts.messageChannel ?? opts.channel;
  if (channel) parts.push(`channel=${channel}`);
  if (opts.to) parts.push(`to=${opts.to}`);
  if (opts.accountId) parts.push(`account=${opts.accountId}`);
  return parts.join(" ");
}

function logNestedOutput(runtime: RuntimeEnv, opts: AgentCommandOpts, output: string) {
  const prefix = formatNestedLogPrefix(opts);
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    runtime.log(`${prefix} ${line}`);
  }
}

export async function deliverAgentCommandResult(params: {
  cfg: InfinibotConfig;
  deps: CliDeps;
  runtime: RuntimeEnv;
  opts: AgentCommandOpts;
  sessionEntry: SessionEntry | undefined;
  result: RunResult;
  payloads: RunResult["payloads"];
}) {
  const { cfg, deps, runtime, opts, sessionEntry, payloads, result } = params;
  const deliver = opts.deliver === true;
  const bestEffortDeliver = opts.bestEffortDeliver === true;
  const deliveryPlan = resolveAgentDeliveryPlan({
    sessionEntry,
    requestedChannel: opts.replyChannel ?? opts.channel,
    explicitTo: opts.replyTo ?? opts.to,
    explicitThreadId: opts.threadId,
    accountId: opts.replyAccountId ?? opts.accountId,
    wantsDelivery: deliver,
  });
  const deliveryChannel = deliveryPlan.resolvedChannel;
  // Channel docking: delivery channels are resolved via plugin registry.
  const deliveryPlugin = !isInternalMessageChannel(deliveryChannel)
    ? getChannelPlugin(normalizeChannelId(deliveryChannel) ?? deliveryChannel)
    : undefined;

  const isDeliveryChannelKnown =
    isInternalMessageChannel(deliveryChannel) || Boolean(deliveryPlugin);

  const targetMode =
    opts.deliveryTargetMode ??
    deliveryPlan.deliveryTargetMode ??
    (opts.to ? "explicit" : "implicit");
  const resolvedAccountId = deliveryPlan.resolvedAccountId;
  const resolved =
    deliver && isDeliveryChannelKnown && deliveryChannel
      ? resolveAgentOutboundTarget({
          cfg,
          plan: deliveryPlan,
          targetMode,
          validateExplicitTarget: true,
        })
      : {
          resolvedTarget: null,
          resolvedTo: deliveryPlan.resolvedTo,
          targetMode,
        };
  const resolvedTarget = resolved.resolvedTarget;
  const deliveryTarget = resolved.resolvedTo;
  const resolvedThreadId = deliveryPlan.resolvedThreadId ?? opts.threadId;
  const resolvedReplyToId =
    deliveryChannel === "slack" && resolvedThreadId != null ? String(resolvedThreadId) : undefined;
  const resolvedThreadTarget = deliveryChannel === "slack" ? undefined : resolvedThreadId;

  const logDeliveryError = (err: unknown) => {
    const message = `Delivery failed (${deliveryChannel}${deliveryTarget ? ` to ${deliveryTarget}` : ""}): ${String(err)}`;
    runtime.error?.(message);
    if (!runtime.error) runtime.log(message);
  };

  if (deliver) {
    if (!isDeliveryChannelKnown) {
      const err = new Error(`Unknown channel: ${deliveryChannel}`);
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    } else if (resolvedTarget && !resolvedTarget.ok) {
      if (!bestEffortDeliver) throw resolvedTarget.error;
      logDeliveryError(resolvedTarget.error);
    }
  }

  // Reliability hardening: a native gateway agent turn that produced only tool
  // calls (or empty/whitespace text) must still deliver a visible message to an
  // external channel instead of silently dropping. Synthesize a fallback here.
  const willDeliverToChannel =
    deliver &&
    Boolean(deliveryChannel) &&
    !isInternalMessageChannel(deliveryChannel) &&
    Boolean(deliveryTarget);
  const rawPayloads = payloads ?? [];
  const usedEmptyReplyFallback = willDeliverToChannel && !hasDeliverableContent(rawPayloads);
  const effectivePayloads: ReplyPayload[] = usedEmptyReplyFallback
    ? [{ text: EMPTY_AGENT_REPLY_FALLBACK }]
    : rawPayloads;
  if (usedEmptyReplyFallback) {
    runtime.log(
      `[agent:delivery] Empty/tool-only agent turn — delivering fallback message to ${deliveryChannel}${deliveryTarget ? ` (${deliveryTarget})` : ""}`,
    );
  }

  const normalizedPayloads = normalizeOutboundPayloadsForJson(effectivePayloads);
  // Secure Mode: secure replies never go to the gateway log or to an external
  // channel; the caller gets them back through the RPC result only.
  if (isSecureSessionKey(opts.sessionKey)) {
    if (deliver && deliveryChannel && !isInternalMessageChannel(deliveryChannel)) {
      runtime.log(`[agent:delivery] Secure Mode: reply kept local (not delivered to ${deliveryChannel})`);
    }
    return { payloads: normalizedPayloads, meta: result.meta };
  }
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        buildOutboundResultEnvelope({
          payloads: normalizedPayloads,
          meta: result.meta,
        }),
        null,
        2,
      ),
    );
    if (!deliver) return { payloads: normalizedPayloads, meta: result.meta };
  }

  if (!effectivePayloads || effectivePayloads.length === 0) {
    runtime.log("No reply from agent.");
    return { payloads: [], meta: result.meta };
  }

  const deliveryPayloads = normalizeOutboundPayloads(effectivePayloads);
  const logPayload = (payload: NormalizedOutboundPayload) => {
    if (opts.json) return;
    const output = formatOutboundPayloadLog(payload);
    if (!output) return;
    if (opts.lane === AGENT_LANE_NESTED) {
      logNestedOutput(runtime, opts, output);
      return;
    }
    runtime.log(output);
  };
  if (!deliver) {
    for (const payload of deliveryPayloads) logPayload(payload);
  }
  if (deliver && deliveryChannel && !isInternalMessageChannel(deliveryChannel)) {
    if (deliveryTarget) {
      const deliveryResults = await deliverOutboundPayloads({
        cfg,
        channel: deliveryChannel,
        to: deliveryTarget,
        accountId: resolvedAccountId,
        payloads: deliveryPayloads,
        replyToId: resolvedReplyToId ?? null,
        threadId: resolvedThreadTarget ?? null,
        bestEffort: bestEffortDeliver,
        onError: (err) => logDeliveryError(err),
        onPayload: logPayload,
        deps: createOutboundSendDeps(deps),
      });
      // Surface the silent-drop case: content existed but nothing reached the wire.
      if (deliveryResults.length === 0 && deliveryPayloads.length > 0) {
        logDeliveryError(
          new Error(
            "agent produced content but no messages were delivered (empty render or send failure)",
          ),
        );
      }
    }
  }

  return { payloads: normalizedPayloads, meta: result.meta };
}
