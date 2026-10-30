#!/usr/bin/env bash
# Isolated end-to-end check for the Robovoice plugin + core voice-provider registry.
#
# Starts a FRESH side gateway (own HOME + state dir under $RV_E2E_DIR, loopback
# port $RV_E2E_PORT) and the mock Robovoice ($RV_E2E_MOCK_PORT) with a scrubbed
# environment (env -i, cwd outside any checkout so no .env is loaded). It never
# touches ~/.infinibot, the live gateway (:18789) or a real Robovoice stack.
#
#   extensions/robovoice/scripts/side-gateway-e2e.sh            # run checks, stop servers
#   KEEP=1 PHASE=local extensions/robovoice/scripts/side-gateway-e2e.sh  # stop after local checks, keep servers up
#   KEEP=1 extensions/robovoice/scripts/side-gateway-e2e.sh     # full run, keep servers up (screenshots)
#
# Requires a built dist/ (pnpm build) and node >= 22 (NODE_BIN_DIR).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN_DIR="${NODE_BIN_DIR:-$HOME/.nvm/versions/node/v22.23.1/bin}"
DIR="${RV_E2E_DIR:-/tmp/rv-e2e}"
PORT="${RV_E2E_PORT:-19021}"
MOCK_PORT="${RV_E2E_MOCK_PORT:-19022}"
TOKEN="rv-e2e-token"
EDGE="rve_e2e_token"
PHASE="${PHASE:-all}"
FAILS=0

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }

clean_env() {
  env -i HOME="$DIR/home" PATH="$NODE_BIN_DIR:/usr/bin:/bin" USER="${USER:-user}" \
    INFINIBOT_STATE_DIR="$DIR/state" INFINIBOT_CONFIG_PATH="$DIR/state/infinibot.json" \
    INFINIBOT_SKIP_CHANNELS=1 "$@"
}

rpc() { # rpc <method> [json]
  (cd "$DIR" && clean_env INFINIBOT_GATEWAY_TOKEN="$TOKEN" INFINIBOT_GATEWAY_PORT="$PORT" \
    node "$DIR/rpc.mjs" "$1" "${2:-}")
}

http() { # http <path> -> body
  curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT$1"
}

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);console.log(eval("o."+process.argv[1])??"")}catch{console.log("")}})' "$1"; }

stop_all() {
  for f in gateway mock; do
    [ -f "$DIR/$f.pid" ] && kill "$(cat "$DIR/$f.pid")" 2>/dev/null
  done
  # the gateway re-execs as "infinibot-gateway"; kill whatever holds our ports
  for p in "$PORT" "$MOCK_PORT"; do
    pid=$(ss -ltnp 2>/dev/null | grep "127.0.0.1:$p " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
}

wait_port() { for _ in $(seq 1 60); do ss -ltn | grep -q "127.0.0.1:$1 " && return 0; sleep 2; done; return 1; }

# ── fresh isolated state ──────────────────────────────────────────────────────
stop_all; sleep 1
rm -rf "$DIR"; mkdir -p "$DIR/home" "$DIR/state"
cat > "$DIR/state/infinibot.json" <<EOF
{ "gateway": { "mode": "local", "auth": { "mode": "token", "token": "$TOKEN" } },
  "voice": { "livekitUrlExternal": "ws://127.0.0.1:7999" } }
EOF
cat > "$DIR/state/voice.json" <<'EOF'
{ "mode": "cloud", "stt": { "provider": "groq", "apiKey": "gsk_dummy_e2e" },
  "tts": { "provider": "elevenlabs", "voice": "onwK4e9ZLuTAKqWW03F9", "apiKey": "sk_dummy_e2e" } }
EOF
cat > "$DIR/rpc.mjs" <<EOF
import { callGateway } from "$REPO/dist/gateway/call.js";
const [method, p] = process.argv.slice(2);
try {
  const res = await callGateway({ method, params: JSON.parse(p || "{}"), timeoutMs: 20000,
    url: "ws://127.0.0.1:$PORT", token: "$TOKEN" });
  process.stdout.write(JSON.stringify(res) + "\n", () => process.exit(0));
} catch (e) { console.error("ERR:", e.message); process.exit(1); }
EOF

(cd "$DIR" && clean_env node --import "$REPO/node_modules/tsx/dist/esm/index.mjs" \
  "$REPO/extensions/robovoice/test/mock-robovoice-cli.ts" "$MOCK_PORT" "$EDGE" > "$DIR/mock.log" 2>&1 & echo $! > "$DIR/mock.pid")
# The gateway resolves some CJS deps relative to cwd, so it runs from the repo;
# refuse if that checkout has a .env (it would leak live settings into the side gateway).
[ -e "$REPO/.env" ] && { fail "$REPO/.env exists — refusing (would load live settings)"; stop_all; exit 1; }
(cd "$REPO" && clean_env node "$REPO/dist/entry.js" gateway --port "$PORT" --bind loopback > "$DIR/gateway.log" 2>&1 & echo $! > "$DIR/gateway.pid")
wait_port "$MOCK_PORT" && pass "mock robovoice up :$MOCK_PORT" || fail "mock robovoice did not start"
wait_port "$PORT" && pass "side gateway up :$PORT (state $DIR/state)" || { fail "side gateway did not start"; tail -20 "$DIR/gateway.log"; stop_all; exit 1; }
# WS auth is not ready for a few seconds after the port opens — wait for RPC.
for _ in $(seq 1 30); do rpc health >/dev/null 2>&1 && break; sleep 3; done

# ── local provider (plugin off) ───────────────────────────────────────────────
S=$(http "/api/voice/connection?room=voice-e2e&participant=u1")
[ "$(echo "$S" | jget provider)" = "local" ] && [ -n "$(echo "$S" | jget token)" ] \
  && pass "local provider issues LiveKit session (url $(echo "$S" | jget url))" || fail "local session: $S"
code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/voice/connection?room=x")
[ "$code" = "401" ] && pass "unauthenticated /api/voice/connection -> 401" || fail "unauth got $code"
L=$(rpc voice.providers.list)
[ "$(echo "$L" | jget active.realtime)" = "local" ] && pass "voice.providers.list: active=local, providers=$(echo "$L" | jget 'providers.map(p=>p.id).join(",")')" || fail "providers.list: $L"

if [ "$PHASE" = "local" ]; then
  echo "SUMMARY phase=local fails=$FAILS"; [ "${KEEP:-0}" = 1 ] || stop_all; exit $FAILS
fi

# ── enable plugin (gateway restarts in-process) ───────────────────────────────
rpc plugins.setEnabled '{"id":"robovoice","enabled":true}' > /dev/null && pass "plugins.setEnabled robovoice=true"
sleep 10
for _ in $(seq 1 20); do P=$(rpc plugins.list 2>/dev/null) && break; sleep 3; done
[ "$(echo "$P" | jget 'plugins.find(p=>p.id==="robovoice").status')" = "loaded" ] && pass "robovoice plugin loaded" || fail "plugin not loaded"
L=$(rpc voice.providers.list)
[ "$(echo "$L" | jget active.realtime)" = "local" ] && pass "unconfigured robovoice: auto stays on local" || fail "auto switched before configured: $L"

# ── configure via plugin RPCs (same RPCs the settings page calls) ─────────────
rpc robovoice.settings.set "{\"deployment\":\"cloud\",\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT\",\"deviceId\":\"infinibot-e2e\"}" > /dev/null
rpc robovoice.secrets.set "{\"edgeToken\":\"$EDGE\",\"deviceKey\":\"devkey-e2e-1234\"}" > /dev/null
G=$(rpc robovoice.settings.get)
echo "$G" | grep -q "$EDGE" && fail "secret leaked in settings.get" || pass "secrets masked in settings.get ($(echo "$G" | jget secrets.edgeToken.hint))"
[ "$(stat -c %a "$DIR/state/plugin-data/robovoice/secrets.json")" = "600" ] && pass "secrets.json mode 600" || fail "secrets.json mode"
T=$(rpc robovoice.test "{\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT\"}")
[ "$(echo "$T" | jget ok)" = "true" ] && pass "robovoice.test: health=$(echo "$T" | jget health) characters=$(echo "$T" | jget characters)" || fail "test: $T"
C=$(rpc robovoice.credits.get)
[ "$(echo "$C" | jget availableCredits)" = "2450" ] && pass "credits: 2450 credits (\$$(echo "$C" | jget availableUsd))" || fail "credits: $C"
rpc robovoice.mapping.set '{"agentId":"main","characterId":"char-kate"}' > /dev/null && pass "mapped agent main -> char-kate"
PL=$(rpc robovoice.pipeline.get '{"characterId":"char-lab"}')
[ "$(echo "$PL" | jget 'safety.flags[0].code')" = "piper-lessac-voice" ] && pass "Lessac voice flagged self-host-only (cloudViolation=$(echo "$PL" | jget safety.cloudViolation))" || fail "safety: $PL"

# ── sessions via the active provider ──────────────────────────────────────────
S=$(http "/api/voice/connection?room=voice-emp_main-123e4567-e89b-12d3-a456-426614174000&participant=u1&agent=main")
[ "$(echo "$S" | jget provider)" = "robovoice" ] && [ "$(echo "$S" | jget characterId)" = "char-kate" ] \
  && pass "auto -> robovoice session: room=$(echo "$S" | jget room) character=char-kate url=$(echo "$S" | jget url)" || fail "robovoice session: $S"
R=$(rpc voice.providers.select '{"id":"local"}'); S=$(http "/api/voice/connection?room=r1&participant=u1")
[ "$(echo "$S" | jget provider)" = "local" ] && pass "select local -> local session (no restart)" || fail "select local: $S"
R=$(rpc voice.providers.select '{"id":"auto"}'); S=$(http "/api/voice/connection?room=r2&participant=u1&agent=main")
[ "$(echo "$S" | jget provider)" = "robovoice" ] && pass "select auto -> robovoice session again" || fail "select auto: $S"
S=$(http "/plugins/robovoice/connection-details?agent=main")
[ "$(echo "$S" | jget characterId)" = "char-kate" ] && pass "plugin route /plugins/robovoice/connection-details issues session" || fail "plugin connection route: $S"

# ── plugin MCP endpoint ───────────────────────────────────────────────────────
mcp() { curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d "$1" "http://127.0.0.1:$PORT/plugins/robovoice/mcp"; }
[ "$(mcp '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | jget result.serverInfo.name)" = "infinibot-robovoice" ] && pass "MCP initialize" || fail "MCP initialize"
N=$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jget 'result.tools.length'); [ "${N:-0}" -gt 0 ] && pass "MCP tools/list: $N allowlisted tools" || fail "MCP tools/list"
X=$(mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"agents_list","arguments":{}}}')
[ "$(echo "$X" | jget result.isError)" = "false" ] && pass "MCP tools/call agents_list via loopback /tools/invoke" || fail "MCP call: $(echo "$X" | head -c 200)"
[ "$(mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"gateway"}}' | jget error.code)" = "-32602" ] && pass "MCP refuses non-allowlisted tool 'gateway'" || fail "MCP allowlist"
code=$(curl -s -o /dev/null -w "%{http_code}" -d '{}' "http://127.0.0.1:$PORT/plugins/robovoice/mcp")
[ "$code" = "401" ] && pass "MCP without auth -> 401" || fail "MCP unauth got $code"

# ── SaaS link: this install becomes a Robovoice LOCATION (mock robovoice.io) ──
MOCK="http://127.0.0.1:$MOCK_PORT"
cli() { (cd "$REPO" && clean_env node "$REPO/dist/entry.js" robovoice "$@" 2>&1); }
mstate() { curl -s "$MOCK/__mock/state"; }
O=$(cli login --api "$MOCK" --no-open)
echo "$O" | grep -q "Location *InfiniBot · " && pass "CLI login: device-code approved, location '$(echo "$O" | sed -n 's/^Location *//p' | cut -d' ' -f1-3)' created" || fail "CLI login: $O"
LOC1=$(mstate | jget 'links[0].locationId'); DEV1=$(mstate | jget 'links[0].deviceId')
[ -n "$LOC1" ] && [ -n "$DEV1" ] && pass "mock SaaS has link: location=$LOC1 device=$DEV1" || fail "no link in mock"
cli login --api "$MOCK" --no-open > /dev/null
[ "$(mstate | jget 'locations.filter(l=>l.name.startsWith("InfiniBot")).length')" = "1" ] && [ "$(mstate | jget 'devices.length')" = "1" ] \
  && [ "$(mstate | jget 'links[0].locationId')" = "$LOC1" ] && pass "relink is idempotent (1 location, 1 device, same ids)" || fail "relink duplicated: $(mstate)"
grep -q '"enc:' "$DIR/state/plugin-data/robovoice/secrets.json" && ! grep -q "rve_mock_" "$DIR/state/plugin-data/robovoice/secrets.json" \
  && pass "credentials encrypted at rest (install key)" || fail "secrets.json not encrypted"
S=$(rpc robovoice.link.status '{}')
[ "$(echo "$S" | jget linked)" = "true" ] && [ "$(echo "$S" | jget 'credits.availableCredits')" = "2450" ] \
  && pass "gateway sees the link: org=$(echo "$S" | jget org.name) location=$(echo "$S" | jget location.name) credits=2450" || fail "link.status: $S"
A2=$(rpc robovoice.agents.list '{}' | jget 'agents.find(a=>!a.linked).id')
L=$(rpc robovoice.agents.link "{\"agentId\":\"$A2\",\"language\":\"es\"}")
[ "$(echo "$L" | jget "results.find(r=>r.agent_id===\"$A2\").ok")" = "true" ] && pass "agents.link $A2 -> character $(echo "$L" | jget "results.find(r=>r.agent_id===\"$A2\").character_id")" || fail "agents.link $A2: $L"
U=$(rpc robovoice.agents.link '{"agentId":"no-such-agent"}' 2>&1); echo "$U" | grep -q "Unknown InfiniBot agent" && pass "agents.link refuses an unknown agent" || fail "unknown agent: $U"
C=$(rpc robovoice.call.start '{"agentId":"main","mode":"cloud"}')
ROOM=$(echo "$C" | jget room); SINCE=$(echo "$C" | jget started_at)
echo "$C" | jget url | grep -q "/call/" && pass "call.start main: $(echo "$C" | jget url)" || fail "call.start: $C"
for _ in 1 2 3 4; do CS=$(rpc robovoice.call.status "{\"room\":\"$ROOM\",\"since\":\"$SINCE\"}"); done
[ "$(echo "$CS" | jget usage.credits_charged)" = "42" ] && pass "call.status after the call: 42 credits used, $(echo "$CS" | jget credits.available_credits) left" || fail "call.status: $CS"
T=$(curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"tool":"robovoice_call","args":{"action":"link_status"},"sessionKey":"agent:main:e2e"}' "http://127.0.0.1:$PORT/tools/invoke")
echo "$T" | grep -q 'Mock Org' && pass "robovoice_call tool via /tools/invoke (link_status)" || fail "tool: $(echo "$T" | head -c 300)"
rpc robovoice.settings.set "{\"mcpPublicUrl\":\"http://127.0.0.1:$PORT\"}" > /dev/null
M=$(rpc robovoice.link.sync '{}')
[ "$(echo "$M" | jget mcp.status)" = "bound" ] && pass "per-agent MCP bound: $(echo "$M" | jget 'mcp.agents.join(",")')" || fail "mcp bind: $M"
rpc robovoice.settings.set '{"mcpTools":["agents_list","notes","gateway"]}' > /dev/null
MT=$(mstate | jget "mcpRegistry.find(r=>r.id===\"infinibot-$A2\").auth_token")
amcp() { curl -s -H "Authorization: Bearer $1" -H "content-type: application/json" -d "$2" "http://127.0.0.1:$PORT/plugins/robovoice/agent-mcp?agent=$3"; }
N=$(amcp "$MT" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$A2" | jget 'result.tools.map(t=>t.name).join(",")')
[ -n "$N" ] && ! echo "$N" | grep -qw "gateway" && pass "agent-mcp ($A2 token) tools/list: $N (no gateway)" || fail "agent mcp list: $N"
MAINT=$(mstate | jget 'mcpRegistry.find(r=>r.id==="infinibot-main").auth_token')
X=$(amcp "$MAINT" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agents_list","arguments":{}}}' main)
[ "$(echo "$X" | jget result.isError)" = "false" ] && pass "agent-mcp (main token) tools/call agents_list ran as main" || fail "agent mcp call as main: $(echo "$X" | head -c 300)"
X=$(amcp "$MT" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"agents_list","arguments":{}}}' "$A2")
[ "$(echo "$X" | jget result.isError)" = "true" ] && echo "$X" | grep -q "not available" \
  && pass "agent-mcp ($A2 token) runs under $A2's own tool policy (agents_list refused for $A2)" || fail "per-agent policy: $(echo "$X" | head -c 300)"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "http://127.0.0.1:$PORT/plugins/robovoice/agent-mcp")
[ "$code" = "401" ] && pass "/plugins/robovoice/agent-mcp without a scoped token -> 401" || fail "agent mcp unauth got $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $MT" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "http://127.0.0.1:$PORT/plugins/robovoice/agent-mcp?agent=main")
[ "$code" = "403" ] && pass "$A2's token refused for agent main -> 403" || fail "cross-agent token got $code"
O=$(cli unlink)
[ "$(mstate | jget 'devices[0].revoked')" = "true" ] && [ "$(mstate | jget 'locations.some(l=>l.id==="'"$LOC1"'")')" = "true" ] \
  && pass "CLI unlink: device retired, location kept" || fail "unlink: $O"
O=$(cli status); echo "$O" | grep -q "unlinked .*location kept" && pass "status says unlinked (location kept)" || fail "status after unlink: $O"
cli login --api "$MOCK" --no-open > /dev/null
[ "$(mstate | jget 'links[0].locationId')" = "$LOC1" ] && [ "$(mstate | jget 'devices[0].revoked')" = "false" ] \
  && pass "relogin restores the same device at the same location" || fail "relink after unlink: $(mstate)"

echo "SUMMARY phase=all fails=$FAILS"
[ "${KEEP:-0}" = 1 ] && echo "servers kept up: gateway :$PORT (token $TOKEN), mock :$MOCK_PORT" || stop_all
exit $FAILS
