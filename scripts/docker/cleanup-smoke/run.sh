#!/usr/bin/env bash
set -euo pipefail

cd /repo

export INFINIBOT_STATE_DIR="/tmp/infinibot-test"
export INFINIBOT_CONFIG_PATH="${INFINIBOT_STATE_DIR}/infinibot.json"

echo "==> Seed state"
mkdir -p "${INFINIBOT_STATE_DIR}/credentials"
mkdir -p "${INFINIBOT_STATE_DIR}/agents/main/sessions"
echo '{}' >"${INFINIBOT_CONFIG_PATH}"
echo 'creds' >"${INFINIBOT_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${INFINIBOT_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
pnpm infinibot reset --scope config+creds+sessions --yes --non-interactive

test ! -f "${INFINIBOT_CONFIG_PATH}"
test ! -d "${INFINIBOT_STATE_DIR}/credentials"
test ! -d "${INFINIBOT_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${INFINIBOT_STATE_DIR}/credentials"
echo '{}' >"${INFINIBOT_CONFIG_PATH}"

echo "==> Uninstall (state only)"
pnpm infinibot uninstall --state --yes --non-interactive

test ! -d "${INFINIBOT_STATE_DIR}"

echo "OK"
