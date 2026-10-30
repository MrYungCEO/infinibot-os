#!/usr/bin/env node
/**
 * Round-trip test for the voice_route persistent setting.
 *
 * Drives the actual handleVoiceConfigRequest handler via mock req/res so
 * it exercises the same code path the gateway uses, without spinning up
 * an HTTP server.
 *
 * Verifies:
 *   1. Default GET → voice_route === "gateway_agent"
 *   2. POST { voice_route: "claude_code" } persists
 *   3. Subsequent GET → voice_route === "claude_code"
 *   4. POST { voice_route: "gateway_agent" } restores
 *   5. Final GET → voice_route === "gateway_agent"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";

import { handleVoiceConfigRequest } from "../src/gateway/server-voice-config.js";

const SETTINGS_FILE = path.join(process.cwd(), "voice-settings.json");

function snapshotFile(): string | null {
    try {
        return fs.readFileSync(SETTINGS_FILE, "utf-8");
    } catch {
        return null;
    }
}

function restoreFile(snapshot: string | null) {
    if (snapshot === null) {
        try { fs.unlinkSync(SETTINGS_FILE); } catch {}
    } else {
        fs.writeFileSync(SETTINGS_FILE, snapshot, "utf-8");
    }
}

class MockResponse extends EventEmitter {
    statusCode = 0;
    headers: Record<string, string> = {};
    body = "";
    setHeader(name: string, value: string) {
        this.headers[name] = value;
    }
    writeHead(code: number, hdrs?: Record<string, string>) {
        this.statusCode = code;
        if (hdrs) Object.assign(this.headers, hdrs);
    }
    end(chunk?: string) {
        if (chunk) this.body += chunk;
    }
    write(chunk: string) {
        this.body += chunk;
    }
}

function mockRequest(method: string, urlPath: string, body?: string): import("node:http").IncomingMessage {
    const ee = new EventEmitter() as unknown as import("node:http").IncomingMessage & EventEmitter;
    (ee as unknown as { method: string }).method = method;
    (ee as unknown as { url: string }).url = urlPath;
    (ee as unknown as { headers: Record<string, string> }).headers = { host: "localhost" };
    setImmediate(() => {
        if (body !== undefined) ee.emit("data", Buffer.from(body));
        ee.emit("end");
    });
    return ee;
}

async function call(method: string, urlPath: string, body?: object): Promise<{ status: number; json: Record<string, unknown> }> {
    const req = mockRequest(method, urlPath, body !== undefined ? JSON.stringify(body) : undefined);
    const res = new MockResponse();
    const handled = await handleVoiceConfigRequest(req as never, res as never);
    if (!handled) throw new Error(`handler did not match ${method} ${urlPath}`);
    let parsed: Record<string, unknown> = {};
    try {
        parsed = JSON.parse(res.body);
    } catch {
        /* not JSON */
    }
    return { status: res.statusCode, json: parsed };
}

async function main() {
    const snapshot = snapshotFile();
    try {
        // Reset to a known minimal state — keep tts_provider so other tests pass.
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ tts_provider: "kokoro" }, null, 2), "utf-8");

        console.log("=== 1. Default GET — should be gateway_agent ===");
        const g1 = await call("GET", "/api/settings");
        console.log("status:", g1.status, "voice_route:", g1.json.voice_route);
        if (g1.json.voice_route !== "gateway_agent") throw new Error("default should be gateway_agent");

        console.log("\n=== 2. POST claude_code ===");
        const p1 = await call("POST", "/api/settings", { voice_route: "claude_code" });
        console.log("status:", p1.status, "ok:", p1.json.ok);
        if (!p1.json.ok) throw new Error("post failed");

        console.log("\n=== 3. GET — should now be claude_code ===");
        const g2 = await call("GET", "/api/settings");
        console.log("status:", g2.status, "voice_route:", g2.json.voice_route);
        if (g2.json.voice_route !== "claude_code") throw new Error("post did not persist");

        console.log("\n=== 4. POST gateway_agent ===");
        const p2 = await call("POST", "/api/settings", { voice_route: "gateway_agent" });
        if (!p2.json.ok) throw new Error("post failed");

        console.log("\n=== 5. GET — should be gateway_agent again ===");
        const g3 = await call("GET", "/api/settings");
        console.log("status:", g3.status, "voice_route:", g3.json.voice_route);
        if (g3.json.voice_route !== "gateway_agent") throw new Error("restore failed");

        console.log("\n=== 6. Verify other settings still persist alongside ===");
        const p3 = await call("POST", "/api/settings", { tts_voice_kokoro: "am_onyx" });
        if (!p3.json.ok) throw new Error("post failed");
        const g4 = await call("GET", "/api/settings");
        console.log("voice_route:", g4.json.voice_route, "tts_voice_kokoro:", g4.json.tts_voice_kokoro);
        if (g4.json.voice_route !== "gateway_agent") throw new Error("voice_route lost during merge");
        if (g4.json.tts_voice_kokoro !== "am_onyx") throw new Error("tts_voice_kokoro not merged");

        console.log("\nOK — round-trip verified");
    } finally {
        restoreFile(snapshot);
    }
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
