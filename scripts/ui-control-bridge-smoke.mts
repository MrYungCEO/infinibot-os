#!/usr/bin/env node
/**
 * End-to-end smoke for the UI Control bridge.
 *
 * Simulates: agent calls dispatchToUI → server broadcasts ui.request →
 * mock UI client receives broadcast → mock dispatches an action → mock
 * sends ui.response via the regular handler → dispatchToUI promise resolves.
 *
 * Verifies the wire shape and the round-trip without spinning a full WS
 * server. Uses the in-process module API directly.
 */

import {
    dispatchToUI,
    listConnectedUIClients,
    setUIControlBroadcaster,
    uiControlHandlers,
} from "../src/gateway/server-methods/ui-control.js";
import type { GatewayWsClient } from "../src/gateway/server/ws-types.js";

interface BroadcastedEvent {
    event: string;
    payload: unknown;
}

async function main() {
    const events: BroadcastedEvent[] = [];

    // Mock the broadcaster — capture every event the bridge emits.
    const broadcaster = {
        broadcast: (event: string, payload: unknown) => {
            events.push({ event, payload });
        },
    };

    // Mock a single connected UI client.
    const fakeClient: GatewayWsClient = {
        socket: {} as never,
        connId: "fake-conn-1",
        connect: {
            client: { id: "infinibot-control-ui", mode: "webchat" } as never,
            role: "operator",
        } as never,
        presenceKey: undefined,
    };
    const clients = new Set<GatewayWsClient>([fakeClient]);

    setUIControlBroadcaster({ broadcaster, clients });

    console.log("=== 1. listConnectedUIClients ===");
    const list = listConnectedUIClients();
    console.log("connected:", list.length, list);
    if (list.length !== 1) throw new Error("expected 1 connected UI client");

    console.log("\n=== 2. dispatchToUI broadcasts a ui.request ===");
    // Fire dispatchToUI in the background, then mimic the browser's response.
    const dispatchPromise = dispatchToUI("kanban", "list", {}, { timeoutMs: 2_000 });

    // Wait for the broadcast to fire (microtask).
    await new Promise((r) => setImmediate(r));
    if (events.length !== 1) throw new Error(`expected 1 broadcast, got ${events.length}`);
    if (events[0].event !== "ui.request") throw new Error(`expected ui.request, got ${events[0].event}`);
    const payload = events[0].payload as { requestId: string; view: string; action: string };
    console.log("broadcast event:", events[0].event);
    console.log("payload:", payload);
    if (!payload.requestId) throw new Error("requestId missing from broadcast");
    if (payload.view !== "kanban" || payload.action !== "list") {
        throw new Error("view/action mismatch in broadcast");
    }

    console.log("\n=== 3. Simulate browser ui.response ===");
    // Build a synthetic request frame as if it came from a browser.
    const responseFrame = {
        type: "req" as const,
        id: "req-fake-1",
        method: "ui.response",
        params: {
            requestId: payload.requestId,
            ok: true,
            payload: { count: 3, items: ["a", "b", "c"] },
        },
    };
    let respondCalled = false;
    let respondedOk = false;
    let respondedPayload: unknown = undefined;
    await uiControlHandlers["ui.response"]({
        req: responseFrame,
        respond: (ok: boolean, p?: unknown) => {
            respondCalled = true;
            respondedOk = ok;
            respondedPayload = p;
        },
        client: fakeClient,
        isWebchatConnect: false,
        context: {} as never,
    } as never);
    console.log("respond called:", respondCalled, "ok:", respondedOk, "payload:", respondedPayload);
    if (!respondCalled || !respondedOk) throw new Error("ui.response handler did not respond ok");

    console.log("\n=== 4. dispatchToUI promise resolves ===");
    const result = await dispatchPromise;
    console.log("result:", result);
    if (!result.ok) throw new Error("dispatchToUI did not resolve ok");
    if (!result.payload || (result.payload as { count?: number }).count !== 3) {
        throw new Error("payload not propagated correctly");
    }

    console.log("\n=== 5. Timeout path ===");
    // Don't deliver any response — the dispatch should time out cleanly.
    const before = Date.now();
    const r2 = await dispatchToUI("nonexistent", "noop", {}, { timeoutMs: 200 });
    const elapsed = Date.now() - before;
    console.log("timed-out result:", r2);
    console.log("elapsed:", elapsed, "ms");
    if (r2.ok) throw new Error("expected timeout to set ok=false");
    if (!String(r2.error).includes("timed out")) throw new Error("error message should mention timeout");

    console.log("\n=== 6. No clients connected ===");
    setUIControlBroadcaster({ broadcaster, clients: new Set() });
    const r3 = await dispatchToUI("kanban", "list", {}, { timeoutMs: 200 });
    console.log("no-clients result:", r3);
    if (r3.ok) throw new Error("expected ok=false when no clients connected");
    if (!String(r3.error).includes("no UI client connected")) {
        throw new Error("error should explain no UI client connected");
    }

    console.log("\nOK — bridge round-trip verified");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
