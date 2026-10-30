#!/usr/bin/env bash
# Isolated latency + audio check of a voice turn through the Robovoice path.
#
# Side gateway (own HOME + state dir, loopback port, env -i, channels / cron /
# MCP clients off) + the MOCK Robovoice (link, location, scoped voice-LLM
# token). Each turn is driven by voice-turn-bench.mjs the way Robovoice's voice
# agent does it: spoken WAV → STT → the scoped callback (SSE) → first sentence →
# TTS → first audio byte, with an energy check of the audio produced.
# Never touches ~/.infinibot, the live gateways, or the real Robovoice.
#
#   voice-latency-e2e.sh up      start side gateway + mock, link, enable agent main
#   voice-latency-e2e.sh bench   before (mode=agent) vs after (mode=auto) table
#   voice-latency-e2e.sh down    stop everything, remove the state dir
#
# REAL_MODEL=1  use the owner's default model provider (key copied into the side
#               config only, never printed); otherwise a fake local model.
# OWNER_WORKSPACE=<dir>  copy that agent workspace's *.md bootstrap files so the
#               full-agent prompt is as large as the real one.
# STT / TTS: local Speaches (:8002) and Kokoro (:8882) containers.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN_DIR="${NODE_BIN_DIR:-$HOME/.nvm/versions/node/v22.23.1/bin}"
DIR="${RV_LAT_DIR:-/tmp/rv-voice-latency}"
PORT="${RV_LAT_PORT:-19071}"
MOCK_PORT="${RV_LAT_MOCK_PORT:-19072}"
LLM_PORT="${RV_LAT_LLM_PORT:-19073}"
TOKEN="rv-lat-token"
MOCK="http://127.0.0.1:$MOCK_PORT"
RUNS="${RUNS:-3}"
OWNER_CONFIG="${OWNER_CONFIG:-$HOME/.infinibot/infinibot.json}"

clean_env() {
  env -i HOME="$DIR/home" PATH="$NODE_BIN_DIR:/usr/bin:/bin" USER="${USER:-user}" \
    INFINIBOT_STATE_DIR="$DIR/state" INFINIBOT_CONFIG_PATH="$DIR/state/infinibot.json" \
    INFINIBOT_SKIP_CHANNELS=1 INFINIBOT_SKIP_CRON=1 INFINIBOT_SKIP_GMAIL_WATCHER=1 \
    INFINIBOT_SKIP_CANVAS_HOST=1 INFINIBOT_SKIP_BROWSER_CONTROL_SERVER=1 INFINIBOT_SKIP_TUNNEL=1 \
    INFINIBOT_SKIP_FEDERATION_INTEGRATION=1 INFINIBOT_SKIP_AUTO_UPDATE=1 INFINIBOT_SKIP_MCP_CLIENTS=1 \
    INFINIBOT_SKIP_CLAUDE_CODE_WATCHER=1 INFINIBOT_SKIP_CLAUDE_CODE_REGISTER=1 INFINIBOT_SKIP_EMAIL_INBOUND=1 \
    INFINIBOT_TMUX_SOCKET="rv-voice-latency" "$@"
}
rpc() { (cd "$DIR" && clean_env node "$DIR/rpc.mjs" "$1" "${2:-}"); }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=eval("o."+process.argv[1]);console.log(v===null||v===undefined?"":typeof v==="object"?JSON.stringify(v):v)}catch{console.log("")}})' "$1"; }
cli() { (cd "$REPO" && clean_env node "$REPO/dist/entry.js" robovoice "$@" 2>&1); }
wait_port() { for _ in $(seq 1 60); do ss -ltn | grep -q "127.0.0.1:$1 " && return 0; sleep 2; done; return 1; }

stop_all() {
  # The gateway re-execs as "infinibot-gateway": kill whatever holds OUR ports (never by name).
  for p in "$PORT" "$MOCK_PORT" "$LLM_PORT"; do
    pid=$(ss -ltnp 2>/dev/null | grep "127.0.0.1:$p " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
}

up() {
  for p in "$PORT" "$MOCK_PORT" "$LLM_PORT"; do
    ss -ltn | grep -q "127.0.0.1:$p " && { echo "port $p busy — refusing"; exit 1; }
  done
  [ -e "$REPO/.env" ] && { echo "$REPO/.env exists — refusing (would load live settings)"; exit 1; }
  rm -rf "$DIR"; mkdir -p "$DIR/home" "$DIR/state"
  PATH="$NODE_BIN_DIR:$PATH" REAL_MODEL="${REAL_MODEL:-0}" node -e '
    const fs = require("fs");
    const [dir, token, llmPort, ownerPath] = process.argv.slice(1);
    let providers = { fakellm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, apiKey: "fake-key", api: "openai-completions",
      models: [{ id: "fake-voice", name: "Fake voice model", contextWindow: 128000, maxTokens: 2048 }] } };
    let model = { primary: "fakellm/fake-voice" };
    if (process.env.REAL_MODEL === "1") {
      const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      model = { primary: owner.agents.defaults.model.primary };
      const name = model.primary.split("/")[0];
      providers = { [name]: owner.models.providers[name] };
    }
    fs.writeFileSync(`${dir}/state/infinibot.json`, JSON.stringify({
      gateway: { mode: "local", auth: { mode: "token", token } },
      models: { providers },
      agents: { defaults: { model, sandbox: { mode: "off" } }, list: [{ id: "main", default: true, name: "INFINI" }] },
    }, null, 1), { mode: 0o600 });
    console.log(`side config: model ${model.primary}`);
  ' "$DIR" "$TOKEN" "$LLM_PORT" "$OWNER_CONFIG"
  if [ -n "${OWNER_WORKSPACE:-}" ] && [ -d "$OWNER_WORKSPACE" ]; then
    mkdir -p "$DIR/home/infinibot"
    cp "$OWNER_WORKSPACE"/*.md "$DIR/home/infinibot/" 2>/dev/null
    echo "workspace: $(ls "$DIR/home/infinibot" | wc -l) bootstrap files, $(cat "$DIR/home/infinibot"/*.md | wc -c) chars"
  fi
  cat > "$DIR/rpc.mjs" <<EOF
import { callGateway } from "$REPO/dist/gateway/call.js";
const [method, p] = process.argv.slice(2);
try {
  const res = await callGateway({ method, params: JSON.parse(p || "{}"), timeoutMs: 120000,
    url: "ws://127.0.0.1:$PORT", token: "$TOKEN" });
  process.stdout.write(JSON.stringify(res) + "\n", () => process.exit(0));
} catch (e) { console.error("ERR:", e.message); process.exit(1); }
EOF
  (cd "$DIR" && clean_env node --import "$REPO/node_modules/tsx/dist/esm/index.mjs" \
    "$REPO/extensions/robovoice/test/mock-robovoice-cli.ts" "$MOCK_PORT" > "$DIR/mock.log" 2>&1 &) > /dev/null 2>&1 < /dev/null
  [ "${REAL_MODEL:-0}" = 1 ] || (cd "$DIR" && clean_env node "$REPO/extensions/robovoice/test/fake-openai-llm.mjs" "$LLM_PORT" > "$DIR/llm.log" 2>&1 &) > /dev/null 2>&1 < /dev/null
  (cd "$REPO" && clean_env node "$REPO/dist/entry.js" gateway --port "$PORT" --bind loopback > "$DIR/gateway.log" 2>&1 &) > /dev/null 2>&1 < /dev/null
  wait_port "$MOCK_PORT" || { echo "mock did not start"; exit 1; }
  wait_port "$PORT" || { echo "gateway did not start"; tail -30 "$DIR/gateway.log"; stop_all; exit 1; }
  for _ in $(seq 1 30); do rpc health >/dev/null 2>&1 && break; sleep 3; done
  rpc plugins.setEnabled '{"id":"robovoice","enabled":true}' > /dev/null
  sleep 10
  for _ in $(seq 1 30); do
    [ "$(rpc plugins.list 2>/dev/null | jget 'plugins.find(p=>p.id==="robovoice").status')" = "loaded" ] && break; sleep 3
  done
  rpc robovoice.settings.set "{\"mcpPublicUrl\":\"http://127.0.0.1:$PORT\"}" > /dev/null
  cli login --api "$MOCK" --no-open | tail -3
  rpc robovoice.voiceAgent.set '{"agentId":"main","enabled":true,"llm":"infinibot","llmBackend":"gateway"}' > /dev/null
  LOC=$(rpc robovoice.account.get | jget selectedLocationId)
  curl -s "$MOCK/__mock/voice-llm-token" | jget "valueOf()[\"$LOC\"]" > "$DIR/rvllm.token"
  chmod 600 "$DIR/rvllm.token"
  echo "up: gateway :$PORT (state $DIR/state), mock :$MOCK_PORT, location $LOC, voice-LLM token saved"
}

bench() {
  local cb="http://127.0.0.1:$PORT/plugins/robovoice/voice-llm/v1" tok
  tok=$(cat "$DIR/rvllm.token")
  mkdir -p "$DIR/bench"
  for mode in agent auto; do
    local label; [ "$mode" = agent ] && label=before || label=after
    rpc robovoice.voiceLlm.set "{\"mode\":\"$mode\"}" > /dev/null
    echo "── $label (voiceLlmMode=$mode) ──"
    PATH="$NODE_BIN_DIR:$PATH" node "$REPO/extensions/robovoice/scripts/voice-turn-bench.mjs" \
      --callback "$cb" --token "$tok" --agent main --label "$label" --runs "$RUNS" \
      --out "$DIR/bench" --json "$DIR/bench/$label.json" \
      --say "Hey, how are you doing today?" --say "Nice. Tell me a fun fact about the ocean." || echo "bench $label: audio check FAILED"
  done
  rpc robovoice.voiceLlm.set '{"mode":"auto"}' > /dev/null
  echo "── gateway log lines (one per turn) ──"
  grep -h "voice-llm main" "$DIR/gateway.log" "$DIR"/state/logs/*.log 2>/dev/null | grep -o 'voice-llm main[^"]*' | tail -$((RUNS * 4))
}

case "${1:-}" in
  up) up ;;
  bench) bench ;;
  down) stop_all; sleep 1; rm -rf "$DIR"; echo "down" ;;
  *) echo "usage: $0 up|bench|down"; exit 2 ;;
esac
