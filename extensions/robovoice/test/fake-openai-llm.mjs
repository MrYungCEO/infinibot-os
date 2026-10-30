#!/usr/bin/env node
/**
 * Fake OpenAI-compatible chat model for the voice-pipeline side-gateway e2e.
 * The side gateway's gateway agent uses it as its model (no real LLM, no keys).
 * Streams a short reply word by word and records every request (the tool list
 * offered to the model is how the e2e proves voice callers get untrusted tools).
 *   node fake-openai-llm.mjs <port>      GET /__requests → recorded requests
 */
import http from "node:http";

const port = Number(process.argv[2] ?? 0);
const requests = [];
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  if (req.url === "/__requests") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(requests));
    return;
  }
  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  const body = raw ? JSON.parse(raw) : {};
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const text = (m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p.text ?? "").join(" ") : "");
  const system = msgs.filter((m) => m.role === "system" || m.role === "developer").map(text).join("\n");
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const said = text(lastUser).split("\n").filter(Boolean).pop() ?? "";
  requests.push({
    at: Date.now(),
    model: body.model,
    tools: (body.tools ?? []).map((t) => t.function?.name ?? t.name),
    voiceCallPrompt: system.includes("[Voice call"),
    callerNotOwner: system.includes("NOT the owner"),
    lastUser: said.slice(0, 200),
    roles: msgs.map((m) => m.role),
    systemHead: system.slice(0, 160),
    systemHasVoice: JSON.stringify(body).includes("[Voice call"),
    toolCount: (body.tools ?? []).length,
  });
  if (process.env.FAKE_LLM_DUMP) (await import("node:fs")).writeFileSync(process.env.FAKE_LLM_DUMP, JSON.stringify(body, null, 1));
  const reply = `Hi, this is the gateway agent. You said: ${said.replace(/^.*?:\s*/, "").slice(0, 80)}`;
  const id = "chatcmpl-fake";
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(chunk({ role: "assistant" }));
    for (const w of reply.split(/(?<= )/)) {
      res.write(chunk({ content: w }));
      await new Promise((r) => setTimeout(r, 15));
    }
    res.write(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({ id, object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
  );
});
server.listen(port, "127.0.0.1", () => console.log(`fake llm on http://127.0.0.1:${server.address().port}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
