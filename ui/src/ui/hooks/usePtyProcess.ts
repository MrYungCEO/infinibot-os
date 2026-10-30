/**
 * usePtyProcess Hook
 * Manages PTY process lifecycle via WebSocket gateway. When `nodeId` points
 * to a remote federation satellite, every call is round-tripped through
 * `federation.node.invoke` so the PTY actually lives on that node — and
 * `terminal.output` events that the satellite forwards back to the master
 * carry a `federationNodeId` tag the xterm subscriber can filter on.
 */

import type { GatewayBrowserClient } from '../gateway.js';

export interface UsePtyProcessOptions {
    terminalId: string;
    cwd: string;
    projectPath?: string;
    cols: number;
    rows: number;
    skipCreation?: boolean;
    /** CLI being launched — when set to an agent CLI the gateway
     *  registers a SessionEntry so the activity feed can surface this terminal. */
    cliType?: "claude" | "opencode" | "gemini" | "codex" | "grok" | "ollama" | "shell";
    /** Pre-derived session key. Lets the InfiniBot MCP server inside the PTY
     *  attribute its tool calls to a session that the activity feed listens to. */
    sessionKey?: string;
    /** Federation node id. `"local"` (or undefined) spawns on this device.
     *  Anything else routes through `federation.node.invoke`. */
    nodeId?: string;
    onCreated?: () => void;
    onError?: (error: string) => void;
}

const isRemote = (nodeId?: string): boolean =>
    !!nodeId && nodeId !== "local";

async function invokeRemote<T = unknown>(
    client: GatewayBrowserClient,
    nodeId: string,
    method: string,
    params: Record<string, unknown>,
): Promise<T> {
    const res = (await client.request("federation.node.invoke", {
        nodeId,
        method,
        params,
    })) as { status?: string; payload?: T; error?: string };
    if (res?.status !== "ok") {
        throw new Error(res?.error || `remote ${method} failed`);
    }
    return res.payload as T;
}

/**
 * Create and manage PTY process for a terminal
 */
export async function createPtyProcess(
    client: GatewayBrowserClient,
    options: UsePtyProcessOptions
): Promise<void> {
    if (options.skipCreation) {
        return;
    }

    const params = {
        id: options.terminalId,
        cwd: options.cwd,
        projectPath: options.projectPath,
        cols: options.cols,
        rows: options.rows,
        cliType: options.cliType,
        sessionKey: options.sessionKey,
    };

    try {
        const result = isRemote(options.nodeId)
            ? await invokeRemote<{ success: boolean; error?: string }>(
                  client,
                  options.nodeId!,
                  "terminal.create",
                  params,
              )
            : await client.request<{ success: boolean; error?: string }>(
                  "terminal.create",
                  params,
              );

        if (result?.success) {
            options.onCreated?.();
        } else {
            options.onError?.(result?.error || "Failed to create terminal");
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.onError?.(message);
    }
}

/**
 * Destroy PTY process
 */
export async function destroyPtyProcess(
    client: GatewayBrowserClient,
    terminalId: string,
    nodeId?: string,
): Promise<void> {
    try {
        if (isRemote(nodeId)) {
            await invokeRemote(client, nodeId!, "terminal.destroy", { id: terminalId });
        } else {
            await client.request("terminal.destroy", { id: terminalId });
        }
    } catch (error) {
        console.error('[usePtyProcess] Failed to destroy terminal:', error);
    }
}

/**
 * Resize PTY process
 */
export async function resizePtyProcess(
    client: GatewayBrowserClient,
    terminalId: string,
    cols: number,
    rows: number,
    nodeId?: string,
): Promise<void> {
    try {
        if (isRemote(nodeId)) {
            await invokeRemote(client, nodeId!, "terminal.resize", {
                id: terminalId,
                cols,
                rows,
            });
        } else {
            await client.request("terminal.resize", { id: terminalId, cols, rows });
        }
    } catch (error) {
        console.warn('[usePtyProcess] Failed to resize terminal:', error);
    }
}

/**
 * Send input to PTY process. Errors are logged AND re-emitted via a
 * `pty-input-error` CustomEvent on `window` so the UI can surface a
 * toast — silent swallows here used to hide federation routing
 * failures (e.g. satellite typing into a master-owned PTY when the
 * federation tunnel had dropped).
 */
export async function sendPtyInput(
    client: GatewayBrowserClient,
    terminalId: string,
    data: string,
    nodeId?: string,
): Promise<void> {
    try {
        if (isRemote(nodeId)) {
            await invokeRemote(client, nodeId!, "terminal.write", { id: terminalId, data });
        } else {
            await client.request("terminal.write", { id: terminalId, data });
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[usePtyProcess] Failed to send input:', message);
        try {
            window.dispatchEvent(
                new CustomEvent("pty-input-error", {
                    detail: { terminalId, nodeId: nodeId ?? "local", message },
                }),
            );
        } catch { /* SSR / no DOM — ignore */ }
    }
}
