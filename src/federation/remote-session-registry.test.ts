import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { FederationHub } from "./hub.js";
import {
  clearRemoteSessions,
  listRemoteSessions,
  registerRemoteSession,
  stopRemoteSessionSweeper,
} from "./remote-session-registry.js";

describe("remote session cleanup on satellite disconnect", () => {
  beforeEach(() => {
    clearRemoteSessions();
  });

  afterEach(() => {
    clearRemoteSessions();
    stopRemoteSessionSweeper();
  });

  it("removes stale remote sessions and emits an aborted lifecycle event", () => {
    registerRemoteSession({
      runId: "run-1",
      sessionKey: "session-1",
      nodeId: "sat-1",
      agentId: "coder",
      task: "remote task",
    });
    registerRemoteSession({
      runId: "run-2",
      sessionKey: "session-2",
      nodeId: "sat-2",
      agentId: "coder",
      task: "other task",
    });

    const events: Array<{ event: string; payload: unknown }> = [];
    const hub = new FederationHub({ enableDiscovery: false });
    hub.setGatewayBroadcaster({
      broadcast: (event, payload) => {
        events.push({ event, payload });
      },
    });

    (
      hub as unknown as {
        cleanupRemoteSessionsForDisconnectedNode: (nodeId: string, reason: string) => void;
      }
    ).cleanupRemoteSessionsForDisconnectedNode("sat-1", "socket closed");

    expect(listRemoteSessions({ nodeId: "sat-1" })).toEqual([]);
    expect(listRemoteSessions({ nodeId: "sat-2" })).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "subagent.complete",
      payload: {
        runId: "run-1",
        sessionKey: "session-1",
        outcome: {
          status: "aborted",
          reason: "federation-disconnect",
        },
      },
    });
  });
});
