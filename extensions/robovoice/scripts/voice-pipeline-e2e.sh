#!/usr/bin/env bash
# Isolated end-to-end check: InfiniBot voice ↔ Robovoice location pipeline.
#
# Fresh side gateway (own HOME + state dir, loopback port, env -i: no secrets,
# channels / cron / providers off) + the MOCK Robovoice + a fake
# OpenAI-compatible model (the gateway agent's LLM) + a fake Claude Code CLI.
# Never touches ~/.infinibot, the live gateway, or any real Robovoice.
#
#   extensions/robovoice/scripts/voice-pipeline-e2e.sh          # run, stop servers
#   KEEP=1 extensions/robovoice/scripts/voice-pipeline-e2e.sh   # keep servers up (screenshots)
#
# Checks: link (install = location), org + location, pipeline editor RPCs with
# precedence, two voice agents synced (main = gateway agent, coder = CLI agent),
# voice turns through the mock Robovoice agent → scoped callback → streamed text,
# callback auth, W5 trust (caller turns only get untrusted tools), Voice page
# provider status (Robovoice + org + location), local fallback.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN_DIR="${NODE_BIN_DIR:-$HOME/.nvm/versions/node/v22.23.1/bin}"
DIR="${RV_VP_DIR:-/tmp/rv-voice-pipeline}"
PORT="${RV_VP_PORT:-19031}"
MOCK_PORT="${RV_VP_MOCK_PORT:-19032}"
LLM_PORT="${RV_VP_LLM_PORT:-19033}"
TOKEN="rv-vp-token"
MOCK="http://127.0.0.1:$MOCK_PORT"
FAILS=0

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }

clean_env() {
  env -i HOME="$DIR/home" PATH="$NODE_BIN_DIR:/usr/bin:/bin" USER="${USER:-user}" \
    INFINIBOT_STATE_DIR="$DIR/state" INFINIBOT_CONFIG_PATH="$DIR/state/infinibot.json" \
    INFINIBOT_SKIP_CHANNELS=1 INFINIBOT_SKIP_CRON=1 INFINIBOT_SKIP_GMAIL_WATCHER=1 \
    INFINIBOT_SKIP_CANVAS_HOST=1 INFINIBOT_SKIP_BROWSER_CONTROL_SERVER=1 INFINIBOT_SKIP_TUNNEL=1 \
    INFINIBOT_SKIP_FEDERATION_INTEGRATION=1 INFINIBOT_SKIP_AUTO_UPDATE=1 INFINIBOT_SKIP_MCP_CLIENTS=1 \
    INFINIBOT_SKIP_CLAUDE_CODE_WATCHER=1 INFINIBOT_SKIP_CLAUDE_CODE_REGISTER=1 INFINIBOT_SKIP_EMAIL_INBOUND=1 \
    INFINIBOT_VOICE_CLI_CLAUDE_CODE="$REPO/extensions/robovoice/test/fake-claude-cli.mjs" \
    FAKE_CLI_LOG="$DIR/fake-cli.log" "$@"
}

rpc() { (cd "$DIR" && clean_env node "$DIR/rpc.mjs" "$1" "${2:-}"); }
http() { curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT$1"; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=eval("o."+process.argv[1]);console.log(v===null||v===undefined?"":typeof v==="object"?JSON.stringify(v):v)}catch{console.log("")}})' "$1"; }
cli() { (cd "$REPO" && clean_env node "$REPO/dist/entry.js" robovoice "$@" 2>&1); }
mstate() { curl -s "$MOCK/__mock/state"; }

stop_all() {
  for f in gateway mock llm; do [ -f "$DIR/$f.pid" ] && kill "$(cat "$DIR/$f.pid")" 2>/dev/null; done
  # The gateway re-execs as "infinibot-gateway": kill whatever holds OUR ports (never by name).
  for p in "$PORT" "$MOCK_PORT" "$LLM_PORT"; do
    pid=$(ss -ltnp 2>/dev/null | grep "127.0.0.1:$p " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
}
wait_port() { for _ in $(seq 1 60); do ss -ltn | grep -q "127.0.0.1:$1 " && return 0; sleep 2; done; return 1; }

for p in "$PORT" "$MOCK_PORT" "$LLM_PORT"; do
  ss -ltn | grep -q "127.0.0.1:$p " && { echo "port $p busy — refusing"; exit 1; }
done
[ -e "$REPO/.env" ] && { echo "$REPO/.env exists — refusing (would load live settings)"; exit 1; }

rm -rf "$DIR"; mkdir -p "$DIR/home" "$DIR/state"
cat > "$DIR/state/infinibot.json" <<EOF
{ "gateway": { "mode": "local", "auth": { "mode": "token", "token": "$TOKEN" } },
  "voice": { "livekitUrlExternal": "ws://127.0.0.1:7999" },
  "models": { "providers": { "fakellm": { "baseUrl": "http://127.0.0.1:$LLM_PORT/v1", "apiKey": "fake-key",
    "api": "openai-completions",
    "models": [ { "id": "fake-voice", "name": "Fake voice model", "contextWindow": 128000, "maxTokens": 2048 } ] } } },
  "agents": { "defaults": { "model": { "primary": "fakellm/fake-voice" }, "sandbox": { "mode": "off" } },
    "list": [ { "id": "main", "default": true, "name": "INFINI" }, { "id": "coder", "name": "Coder" } ] } }
EOF
cat > "$DIR/state/voice.json" <<'EOF'
{ "mode": "cloud", "stt": { "provider": "groq", "apiKey": "gsk_dummy_e2e" },
  "tts": { "provider": "elevenlabs", "voice": "onwK4e9ZLuTAKqWW03F9", "apiKey": "sk_dummy_e2e" } }
EOF
cat > "$DIR/rpc.mjs" <<EOF
import { callGateway } from "$REPO/dist/gateway/call.js";
const [method, p] = process.argv.slice(2);
try {
  const res = await callGateway({ method, params: JSON.parse(p || "{}"), timeoutMs: 60000,
    url: "ws://127.0.0.1:$PORT", token: "$TOKEN" });
  process.stdout.write(JSON.stringify(res) + "\n", () => process.exit(0));
} catch (e) { console.error("ERR:", e.message); process.exit(1); }
EOF

(cd "$DIR" && clean_env node --import "$REPO/node_modules/tsx/dist/esm/index.mjs" \
  "$REPO/extensions/robovoice/test/mock-robovoice-cli.ts" "$MOCK_PORT" > "$DIR/mock.log" 2>&1 & echo $! > "$DIR/mock.pid")
(cd "$DIR" && clean_env node "$REPO/extensions/robovoice/test/fake-openai-llm.mjs" "$LLM_PORT" > "$DIR/llm.log" 2>&1 & echo $! > "$DIR/llm.pid")
(cd "$REPO" && clean_env node "$REPO/dist/entry.js" gateway --port "$PORT" --bind loopback > "$DIR/gateway.log" 2>&1 & echo $! > "$DIR/gateway.pid")
wait_port "$MOCK_PORT" && pass "mock Robovoice up :$MOCK_PORT" || fail "mock did not start"
wait_port "$LLM_PORT" && pass "fake LLM up :$LLM_PORT" || fail "fake llm did not start"
wait_port "$PORT" && pass "side gateway up :$PORT (state $DIR/state)" || { fail "gateway did not start"; tail -30 "$DIR/gateway.log"; stop_all; exit 1; }
for _ in $(seq 1 30); do rpc health >/dev/null 2>&1 && break; sleep 3; done

# ── local voice first (plugin off) ────────────────────────────────────────────
S=$(http "/api/voice/connection?room=voice-vp&participant=u1")
[ "$(echo "$S" | jget provider)" = "local" ] && pass "plugin off: Voice page gets a local session" || fail "local session: $S"

rpc plugins.setEnabled '{"id":"robovoice","enabled":true}' > /dev/null && pass "plugins.setEnabled robovoice=true"
sleep 10
PST=""
for _ in $(seq 1 30); do
  PST=$(rpc plugins.list 2>/dev/null | jget 'plugins.find(p=>p.id==="robovoice").status')
  [ "$PST" = "loaded" ] && break; sleep 3
done
[ "$PST" = "loaded" ] && pass "robovoice plugin loaded" || fail "plugin not loaded (status: ${PST:-none})"

# ── link: install becomes a Robovoice location ────────────────────────────────
rpc robovoice.settings.set "{\"mcpPublicUrl\":\"http://127.0.0.1:$PORT\"}" > /dev/null
O=$(cli login --api "$MOCK" --no-open)
echo "$O" | grep -q "Location *InfiniBot · " && pass "device-code login → location created" || fail "login: $O"
A=$(rpc robovoice.account.get)
ORG=$(echo "$A" | jget org.name); LOC=$(echo "$A" | jget selectedLocationId)
[ "$ORG" = "Mock Org" ] && [ -n "$LOC" ] && pass "account: org=$ORG, locations=$(echo "$A" | jget 'locations.map(l=>l.name).join(" | ")'), selected=$LOC" || fail "account: $A"

# ── two voice agents: main (gateway agent) + coder (CLI agent) ────────────────
V=$(rpc robovoice.voiceAgent.set '{"agentId":"main","enabled":true,"llm":"infinibot","llmBackend":"gateway","ttsProvider":"kokoro","voice":"am_puck"}')
V=$(rpc robovoice.voiceAgent.set '{"agentId":"coder","enabled":true,"llm":"infinibot","llmBackend":"claude-code","ttsProvider":"elevenlabs","voice":"21m00Tcm4TlvDq8ikWAM"}')
[ -z "$(echo "$V" | jget syncError)" ] && pass "voiceAgent.set main (gateway) + coder (claude-code) synced" || fail "voiceAgent.set: $V"
MAINC=$(echo "$V" | jget 'agents.find(a=>a.id==="main").characterId'); CODERC=$(echo "$V" | jget 'agents.find(a=>a.id==="coder").characterId')
MS=$(mstate)
[ "$(echo "$MS" | jget "characterPipeline[\"$MAINC\"].llm_model")" = "infinibot:main" ] && [ "$(echo "$MS" | jget "characterPipeline[\"$CODERC\"].llm_model")" = "infinibot:coder" ] \
  && pass "Robovoice characters $MAINC / $CODERC have LLM step = InfiniBot" || fail "character pipeline: $(echo "$MS" | jget characterPipeline)"
[ "$(echo "$MS" | jget "voiceLlm[\"$LOC\"].base_url")" = "http://127.0.0.1:$PORT/plugins/robovoice/voice-llm/v1" ] \
  && pass "location voice-LLM binding: $(echo "$MS" | jget "voiceLlm[\"$LOC\"].base_url") token $(echo "$MS" | jget "voiceLlm[\"$LOC\"].token")" || fail "binding: $(echo "$MS" | jget voiceLlm)"
N1=$(mstate | jget 'links.map(l=>Object.keys(l.agents).length)[0]')
rpc robovoice.voiceAgent.set '{"agentId":"coder","enabled":true}' > /dev/null; rpc robovoice.link.sync > /dev/null
[ "$(mstate | jget 'links.map(l=>Object.keys(l.agents).length)[0]')" = "$N1" ] && [ "$(rpc robovoice.voiceAgents.list | jget 'agents.find(a=>a.id==="coder").characterId')" = "$CODERC" ] \
  && pass "resync is idempotent ($N1 agents, coder keeps $CODERC)" || fail "resync duplicated"

# ── location pipeline editor (org → location → character → override) ─────────
G=$(rpc robovoice.pipeline.config.get)
[ "$(echo "$G" | jget effective.location.llm.providerFrom)" = "org" ] && pass "pipeline: location inherits LLM $(echo "$G" | jget effective.location.llm.provider) from org" || fail "pipeline get: $(echo "$G" | head -c 300)"
E=$(rpc robovoice.pipeline.config.set '{"values":{"stt_provider":"groq","tts_voice_kokoro":"bf_emma"}}')
[ "$(echo "$E" | jget view.effective.location.stt.providerFrom)" = "location" ] && [ "$(echo "$E" | jget view.effective.location.stt.model)" = "whisper-large-v3-turbo" ] \
  && pass "location override: STT groq (model follows provider: whisper-large-v3-turbo)" || fail "location set: $(echo "$E" | head -c 400)"
E=$(rpc robovoice.pipeline.config.set "{\"characterId\":\"$MAINC\",\"values\":{\"tts_provider\":\"elevenlabs\",\"tts_voice_elevenlabs\":\"onwK4e9ZLuTAKqWW03F9\"}}")
[ "$(echo "$E" | jget "view.effective.characters[\"$MAINC\"].tts.providerFrom")" = "override" ] && [ "$(echo "$E" | jget "view.effective.characters[\"$MAINC\"].llm.provider")" = "infinibot" ] \
  && pass "per-agent override at the location: main TTS elevenlabs (override), LLM infinibot (agent)" || fail "char set: $(echo "$E" | head -c 400)"
E=$(rpc robovoice.pipeline.config.set '{"values":{"stt_provider":"speaches"}}')
[ "$(echo "$E" | jget 'view.defaults.stt_provider')" = "" ] && pass "value equal to inherited clears the override (decide)" || fail "decide: $(echo "$E" | jget view.defaults)"
[ "$(mstate | jget "locationConfigs[\"$LOC\"].defaults.tts_voice_kokoro")" = "bf_emma" ] && pass "written to Robovoice location_configs (mock): $(mstate | jget "locationConfigs[\"$LOC\"]")" || fail "mock location config"

# ── voice turns: mock Robovoice agent → scoped callback → gateway / CLI ───────
# Full-agent mode first: these checks are about the agent run (voice prompt, W5 tools).
rpc robovoice.voiceLlm.set '{"mode":"agent"}' > /dev/null
T=$(curl -s -d "{\"character_id\":\"$MAINC\",\"text\":\"What can you do for me?\",\"room\":\"robopark-e2e-1\"}" "$MOCK/__mock/voice-turn")
echo "$T" > "$DIR/turn-main.json"
echo "$T" | jget text | grep -q "gateway agent" && [ "$(echo "$T" | jget infinibot.backend)" = "gateway" ] \
  && pass "voice turn → main (gateway agent): \"$(echo "$T" | jget text)\" · $(echo "$T" | jget chunks) chunks · first token $(echo "$T" | jget first_token_ms) ms (gateway-side $(echo "$T" | jget infinibot.first_token_ms) ms) · total $(echo "$T" | jget total_ms) ms" \
  || fail "gateway turn: $T"
R=$(curl -s "http://127.0.0.1:$LLM_PORT/__requests")
TOOLS=$(echo "$R" | jget 'at(-1).tools.join(",")')
[ "$(echo "$R" | jget 'at(-1).voiceCallPrompt')" = "true" ] && [ "$(echo "$R" | jget 'at(-1).callerNotOwner')" = "true" ] \
  && pass "gateway agent got the voice-call prompt (caller is not the owner)" || fail "llm request: $(echo "$R" | jget 'at(-1)')"
if echo ",$TOOLS," | grep -qE ",(exec|claude_coder|sessions_spawn|gateway|message)," ; then fail "W5: untrusted caller was offered host tools: $TOOLS"; else pass "W5: caller turn offered only untrusted tools [${TOOLS:-none}]"; fi
T=$(curl -s -d "{\"character_id\":\"$CODERC\",\"text\":\"Summarize the build\",\"room\":\"robopark-e2e-2\"}" "$MOCK/__mock/voice-turn")
echo "$T" > "$DIR/turn-coder.json"
echo "$T" | jget text | grep -q "Claude CLI here. You said: Summarize the build" && [ "$(echo "$T" | jget infinibot.backend)" = "claude-code" ] \
  && pass "voice turn → coder (CLI agent): \"$(echo "$T" | jget text)\" · $(echo "$T" | jget chunks) chunks · first token $(echo "$T" | jget first_token_ms) ms" || fail "cli turn: $T"
T=$(curl -s -d "{\"character_id\":\"$CODERC\",\"text\":\"And now?\",\"room\":\"robopark-e2e-2\"}" "$MOCK/__mock/voice-turn")
echo "$T" | jget text | grep -q "Claude CLI here again" && pass "second turn of the same call resumes the CLI session" || fail "cli resume: $T"
tail -1 "$DIR/fake-cli.log" | grep -q -- "--disallowedTools" && ! grep -q "dangerously" "$DIR/fake-cli.log" && pass "CLI caller turn: no permission bypass, shell/edit tools disallowed" || fail "cli argv: $(tail -1 "$DIR/fake-cli.log")"
ST=$(rpc robovoice.voiceLlm.status)
[ "$(echo "$ST" | jget bound)" = "true" ] && [ "$(echo "$ST" | jget 'turns.length')" -ge 3 ] && pass "voiceLlm.status: bound, $(echo "$ST" | jget 'turns.length') turns, first-token p50 $(echo "$ST" | jget summary.firstTokenP50Ms) ms" || fail "status: $(echo "$ST" | head -c 300)"

# ── fast path (default mode): conversation = one direct model call, no agent run ─
rpc robovoice.voiceLlm.set '{"mode":"auto"}' > /dev/null
T=$(curl -s -d "{\"character_id\":\"$MAINC\",\"text\":\"How are you today?\",\"room\":\"robopark-e2e-fast\"}" "$MOCK/__mock/voice-turn")
R=$(curl -s "http://127.0.0.1:$LLM_PORT/__requests")
[ "$(echo "$T" | jget infinibot.path)" = "fast" ] && [ "$(echo "$R" | jget 'at(-1).tools.join(",")')" = "handoff_to_agent" ] && echo "$R" | jget 'at(-1).systemHead' | grep -q "Live voice call" \
  && pass "fast path: \"$(echo "$T" | jget text)\" · path=$(echo "$T" | jget infinibot.path) · model $(echo "$T" | jget infinibot.model) · prep $(echo "$T" | jget infinibot.prep_ms) ms · first token $(echo "$T" | jget infinibot.first_token_ms) ms · only tool offered: handoff_to_agent" \
  || fail "fast turn: $T / $(echo "$R" | jget 'at(-1)')"

# ── callback auth ─────────────────────────────────────────────────────────────
CB="http://127.0.0.1:$PORT/plugins/robovoice/voice-llm/v1/chat/completions"
body='{"model":"infinibot:main","messages":[{"role":"user","content":"hi"}]}'
code=$(curl -s -o /dev/null -w "%{http_code}" -H "content-type: application/json" -d "$body" "$CB"); [ "$code" = "401" ] && pass "callback without token → 401" || fail "no token: $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d "$body" "$CB"); [ "$code" = "401" ] && pass "gateway password is NOT a voice-LLM token → 401" || fail "gateway token: $code"
OLD=$(rpc robovoice.voiceLlm.status | jget token.hint)
rpc robovoice.voiceLlm.rotate > /dev/null
NEWT=$(mstate | jget "voiceLlm[\"$LOC\"].token")
[ "$(rpc robovoice.voiceLlm.status | jget token.hint)" != "$OLD" ] && pass "token rotated ($OLD → $(rpc robovoice.voiceLlm.status | jget token.hint)) and re-sent ($NEWT)" || fail "rotate"
T=$(curl -s -d "{\"character_id\":\"$MAINC\",\"text\":\"still there?\",\"room\":\"robopark-e2e-3\"}" "$MOCK/__mock/voice-turn")
echo "$T" | jget text | grep -q "gateway agent" && pass "turn works with the rotated token" || fail "after rotate: $T"

# ── Voice page provider status ────────────────────────────────────────────────
L=$(rpc voice.providers.list)
[ "$(echo "$L" | jget active.realtime)" = "robovoice" ] && pass "Voice page provider: robovoice · $(echo "$L" | jget 'providers.find(p=>p.id==="robovoice").status.account')" || fail "providers: $(echo "$L" | head -c 400)"
S=$(http "/api/voice/connection?room=voice-emp_main-123e4567-e89b-12d3-a456-426614174000&participant=u1&agent=main")
[ "$(echo "$S" | jget provider)" = "robovoice" ] && [ "$(echo "$S" | jget characterId)" = "$MAINC" ] && pass "Voice page session from Robovoice connection-details (character $MAINC)" || fail "robovoice session: $S"

echo "SUMMARY fails=$FAILS"
if [ "${KEEP:-0}" = 1 ]; then echo "kept up: gateway :$PORT (token $TOKEN), mock :$MOCK_PORT, llm :$LLM_PORT"; else stop_all; fi
exit $FAILS
