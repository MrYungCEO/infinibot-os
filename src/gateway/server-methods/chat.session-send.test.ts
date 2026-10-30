/**
 * Tests for the `session.send` registry alias defined in chat.ts.
 *
 * The federation message-type registry, security allowlists, hub-forward
 * pipe, and several mobile callsites (useFederation.invokeOnNode,
 * ChatScreen.sendMessageRouted, FederationTerminalScreen) all use
 * "session.send" as the canonical name for "deliver a user message into a
 * session." server-methods.ts dispatches on the verbatim method string —
 * without this alias, every direct call against the local registry would
 * fall through to the unknown-method handler. These tests pin the alias
 * to chat.send semantics so that contract can't silently regress.
 *
 * The test stubs chat.send on the chatHandlers object after import so we
 * can observe the forwarded options without exercising the full agent
 * stack chat.send normally pulls in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../federation/hub-forward.js", () => ({
  forwardGatewayCall: vi.fn(),
}));

import { chatHandlers } from "./chat.js";
import { forwardGatewayCall } from "../../federation/hub-forward.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions } from "./types.js";

function makeOpts(
  params: Record<string, unknown>,
  respond: ReturnType<typeof vi.fn> = vi.fn(),
  method: string = "session.send",
): GatewayRequestHandlerOptions {
  return {
    req: {
      id: "req-1",
      method,
      params,
    } as GatewayRequestHandlerOptions["req"],
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as GatewayRequestHandlerOptions["context"],
  };
}

describe("session.send registry alias", () => {
  let originalChatSend: GatewayRequestHandler;

  beforeEach(() => {
    originalChatSend = chatHandlers["chat.send"];
    vi.mocked(forwardGatewayCall).mockReset();
  });

  afterEach(() => {
    chatHandlers["chat.send"] = originalChatSend;
  });

  it("is registered alongside chat.send so the gateway dispatcher recognises it", () => {
    expect(typeof chatHandlers["session.send"]).toBe("function");
    expect(typeof chatHandlers["chat.send"]).toBe("function");
  });

  it("forwards to chat.send with the caller's params intact", async () => {
    const spy = vi.fn(async (opts: GatewayRequestHandlerOptions) => {
      opts.respond(true, { ok: true });
    });
    chatHandlers["chat.send"] = spy as never;

    const respond = vi.fn();
    await chatHandlers["session.send"](
      makeOpts(
        {
          sessionKey: "agent:main",
          message: "hello",
          idempotencyKey: "k-1",
        },
        respond,
      ),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const forwarded = spy.mock.calls[0]![0];
    expect(forwarded.params.sessionKey).toBe("agent:main");
    expect(forwarded.params.message).toBe("hello");
    expect(forwarded.params.idempotencyKey).toBe("k-1");
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("auto-fills idempotencyKey when omitted (federation pipe never sets one)", async () => {
    const spy = vi.fn(async (opts: GatewayRequestHandlerOptions) => {
      opts.respond(true, { ok: true });
    });
    chatHandlers["chat.send"] = spy as never;

    await chatHandlers["session.send"](
      makeOpts({ sessionKey: "agent:main", message: "hi from federation" }),
    );

    const forwarded = spy.mock.calls[0]![0];
    expect(typeof forwarded.params.idempotencyKey).toBe("string");
    expect((forwarded.params.idempotencyKey as string).startsWith("session-send-")).toBe(true);
  });

  it("auto-fills idempotencyKey when the caller passes blank whitespace", async () => {
    const spy = vi.fn(async (opts: GatewayRequestHandlerOptions) => {
      opts.respond(true, { ok: true });
    });
    chatHandlers["chat.send"] = spy as never;

    await chatHandlers["session.send"](
      makeOpts({ sessionKey: "agent:main", message: "x", idempotencyKey: "   " }),
    );

    const forwarded = spy.mock.calls[0]![0];
    expect((forwarded.params.idempotencyKey as string).startsWith("session-send-")).toBe(true);
  });

  it("keeps req.params in sync with opts.params (some downstream paths read either)", async () => {
    const spy = vi.fn(async (opts: GatewayRequestHandlerOptions) => {
      opts.respond(true, { ok: true });
    });
    chatHandlers["chat.send"] = spy as never;

    await chatHandlers["session.send"](makeOpts({ sessionKey: "agent:main", message: "y" }));

    const forwarded = spy.mock.calls[0]![0];
    expect((forwarded.req.params as Record<string, unknown>).idempotencyKey).toBe(
      forwarded.params.idempotencyKey,
    );
  });

  it("forwards chat.send to the selected remote node and strips routing fields", async () => {
    vi.mocked(forwardGatewayCall).mockResolvedValueOnce({
      success: true,
      payload: { runId: "remote-run-1", status: "started" },
    });

    const respond = vi.fn();
    await originalChatSend(
      makeOpts(
        {
          sessionKey: "agent:main",
          message: "route this",
          idempotencyKey: "idem-remote",
          nodeId: "sat-42",
          node: "ignored-legacy",
        },
        respond,
        "chat.send",
      ),
    );

    expect(forwardGatewayCall).toHaveBeenCalledOnce();
    const [nodeId, method, forwardedParams] = vi.mocked(forwardGatewayCall).mock.calls[0];
    expect(nodeId).toBe("sat-42");
    expect(method).toBe("chat.send");
    expect(forwardedParams).toMatchObject({
      sessionKey: "agent:main",
      message: "route this",
      idempotencyKey: "idem-remote",
    });
    expect(forwardedParams).not.toHaveProperty("nodeId");
    expect(forwardedParams).not.toHaveProperty("node");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ remote: true, nodeId: "sat-42", runId: "remote-run-1" }),
      undefined,
      expect.objectContaining({ runId: "remote-run-1" }),
    );
  });
});
