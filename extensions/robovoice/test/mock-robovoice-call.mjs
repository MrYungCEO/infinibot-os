// Minimal Robovoice cloud stand-in: call start + device connection-details, real room naming rules.
import http from "node:http";
const port = Number(process.argv[2] || 18978);
const log = (...a) => console.log(new Date().toISOString(), ...a);
http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const u = new URL(req.url, "http://x");
  const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  log(req.method, u.pathname + u.search);
  if (u.pathname === "/api/edge/infinibot/calls" && req.method === "POST") {
    const b = JSON.parse(body || "{}");
    const characterId = "186bd3f9-e155-4357-a8ca-6758fae9f5b4";
    if (b.mode === "local") return send(200, { ok: true, mode: "local", character_id: characterId, room: "robopark-desktop-mock", started_at: new Date().toISOString(), device: { device_id: "desktop-mock", name: "Desktop", hostname: null }, credits: {} });
    // frontend/lib/edge/infinibot.ts startAgentCall (cloud)
    return send(200, { ok: true, mode: "cloud", character_id: characterId, url: `http://mock/call/${characterId}`, room: `robopark-${characterId}`, started_at: new Date().toISOString(), credits: {} });
  }
  if (u.pathname === "/api/edge/infinibot/calls") return send(200, { room: u.searchParams.get("room"), live: true, participants: 2, hold: null, usage: { sessions: 0, billable_seconds: 0, credits_charged: 0, last_ended_at: null }, local: null, credits: {} });
  if (u.pathname === "/api/connection-details") {
    // frontend/app/api/connection-details/route.ts: room = robopark-<device>
    const b = JSON.parse(body || "{}");
    const device = b.device_id || u.searchParams.get("device") || "rand";
    return send(200, { serverUrl: "wss://mock.livekit", roomName: `robopark-${device}`, participantName: "user", participantToken: "mock-jwt" });
  }
  if (u.pathname === "/api/health") return send(200, { status: "ok", agent: "ok" });
  if (u.pathname === "/api/call/characters") return send(200, { characters: [{ id: "186bd3f9-e155-4357-a8ca-6758fae9f5b4", name: "INFINI" }], active_character_id: null, default_character_id: null });
  return send(200, {});
}).listen(port, "127.0.0.1", () => log("mock robovoice on", port));
