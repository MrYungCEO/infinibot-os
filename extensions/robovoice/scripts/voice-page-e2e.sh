#!/usr/bin/env bash
# Isolated side gateway for the Robovoice-only Voice page (UI walk-through).
#
# Fresh side gateway (own HOME + state dir, loopback port, env -i: no secrets,
# channels / cron / providers off) + the MOCK Robovoice (ROBOVOICE_API points
# the device-code sign-in at it) + a fake OpenAI-compatible model. Robovoice
# plugin ON, install NOT linked — the Voice page starts in its connect state.
# Never touches ~/.infinibot, the live gateway, or any real Robovoice.
#
#   extensions/robovoice/scripts/voice-page-e2e.sh up      # start (stays up)
#   extensions/robovoice/scripts/voice-page-e2e.sh down    # stop (by the PIDs owning OUR ports)
#   node extensions/robovoice/scripts/voice-page-shots.mjs # drive the UI + screenshots
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN_DIR="${NODE_BIN_DIR:-$HOME/.nvm/versions/node/v22.23.1/bin}"
DIR="${RV_VPG_DIR:-/tmp/rv-voice-page}"
PORT="${RV_VPG_PORT:-19041}"
MOCK_PORT="${RV_VPG_MOCK_PORT:-19042}"
LLM_PORT="${RV_VPG_LLM_PORT:-19043}"
TOKEN="rv-vpg-token"
MOCK="http://127.0.0.1:$MOCK_PORT"

clean_env() {
  env -i HOME="$DIR/home" PATH="$NODE_BIN_DIR:/usr/bin:/bin" USER="${USER:-user}" \
    INFINIBOT_STATE_DIR="$DIR/state" INFINIBOT_CONFIG_PATH="$DIR/state/infinibot.json" \
    INFINIBOT_SKIP_CHANNELS=1 INFINIBOT_SKIP_CRON=1 INFINIBOT_SKIP_GMAIL_WATCHER=1 \
    INFINIBOT_SKIP_CANVAS_HOST=1 INFINIBOT_SKIP_BROWSER_CONTROL_SERVER=1 INFINIBOT_SKIP_TUNNEL=1 \
    INFINIBOT_SKIP_FEDERATION_INTEGRATION=1 INFINIBOT_SKIP_AUTO_UPDATE=1 INFINIBOT_SKIP_MCP_CLIENTS=1 \
    INFINIBOT_SKIP_CLAUDE_CODE_WATCHER=1 INFINIBOT_SKIP_CLAUDE_CODE_REGISTER=1 INFINIBOT_SKIP_EMAIL_INBOUND=1 \
    ROBOVOICE_API="$MOCK" MOCK_PUBLIC_ROSTER="${MOCK_PUBLIC_ROSTER:-}" \
    MOCK_APPROVE_AFTER_POLLS="${MOCK_APPROVE_AFTER_POLLS:-6}" MOCK_CALL_SCRIPT="${MOCK_CALL_SCRIPT:-1,400}" \
    "$@"
}

stop_all() {
  for f in gateway mock llm; do [ -f "$DIR/$f.pid" ] && kill "$(cat "$DIR/$f.pid")" 2>/dev/null; done
  # The gateway re-execs as "infinibot-gateway": kill whatever holds OUR ports (never by name).
  for p in "$PORT" "$MOCK_PORT" "$LLM_PORT"; do
    pid=$(ss -ltnp 2>/dev/null | grep "127.0.0.1:$p " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
  echo "stopped side gateway :$PORT, mock :$MOCK_PORT, llm :$LLM_PORT"
}
wait_port() { for _ in $(seq 1 60); do ss -ltn | grep -q "127.0.0.1:$1 " && return 0; sleep 2; done; return 1; }
rpc() { (cd "$DIR" && clean_env node "$DIR/rpc.mjs" "$1" "${2:-}"); }

[ "${1:-up}" = down ] && { stop_all; exit 0; }

for p in "$PORT" "$MOCK_PORT" "$LLM_PORT"; do
  ss -ltn | grep -q "127.0.0.1:$p " && { echo "port $p busy — refusing"; exit 1; }
done
[ -e "$REPO/.env" ] && { echo "$REPO/.env exists — refusing (would load live settings)"; exit 1; }

rm -rf "$DIR"; mkdir -p "$DIR/home" "$DIR/state"
cat > "$DIR/state/infinibot.json" <<EOF
{ "gateway": { "mode": "local", "auth": { "mode": "token", "token": "$TOKEN" } },
  "models": { "providers": { "fakellm": { "baseUrl": "http://127.0.0.1:$LLM_PORT/v1", "apiKey": "fake-key",
    "api": "openai-completions",
    "models": [ { "id": "fake-voice", "name": "Fake voice model", "contextWindow": 128000, "maxTokens": 2048 } ] } } },
  "agents": { "defaults": { "model": { "primary": "fakellm/fake-voice" }, "sandbox": { "mode": "off" } },
    "list": [ { "id": "main", "default": true, "name": "INFINI" }, { "id": "coder", "name": "Coder" } ] } }
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
  "$REPO/extensions/robovoice/test/mock-robovoice-cli.ts" "$MOCK_PORT" > "$DIR/mock.log" 2>&1 & echo $! > "$DIR/mock.pid") < /dev/null > /dev/null 2>&1
(cd "$DIR" && clean_env node "$REPO/extensions/robovoice/test/fake-openai-llm.mjs" "$LLM_PORT" > "$DIR/llm.log" 2>&1 & echo $! > "$DIR/llm.pid") < /dev/null > /dev/null 2>&1
(cd "$REPO" && clean_env node "$REPO/dist/entry.js" gateway --port "$PORT" --bind loopback > "$DIR/gateway.log" 2>&1 & echo $! > "$DIR/gateway.pid") < /dev/null > /dev/null 2>&1
wait_port "$MOCK_PORT" || { echo "mock did not start"; stop_all; exit 1; }
wait_port "$LLM_PORT" || { echo "fake llm did not start"; stop_all; exit 1; }
wait_port "$PORT" || { echo "gateway did not start"; tail -30 "$DIR/gateway.log"; stop_all; exit 1; }
for _ in $(seq 1 30); do rpc health >/dev/null 2>&1 && break; sleep 3; done

rpc plugins.setEnabled '{"id":"robovoice","enabled":true}' > /dev/null
for _ in $(seq 1 30); do
  rpc robovoice.link.status '{"remote":false}' > /dev/null 2>&1 && break; sleep 3
done
rpc robovoice.settings.set "{\"mcpPublicUrl\":\"http://127.0.0.1:$PORT\"}" > /dev/null
echo "up: gateway http://127.0.0.1:$PORT/voice?token=$TOKEN · mock $MOCK · state $DIR/state"
echo "link: $(rpc robovoice.link.status '{"remote":false}' | head -c 200)"
