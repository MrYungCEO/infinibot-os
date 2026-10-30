#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${INFINIBOT_IMAGE:-infinibot:local}"
CONFIG_DIR="${INFINIBOT_CONFIG_DIR:-$HOME/.infinibot}"
WORKSPACE_DIR="${INFINIBOT_WORKSPACE_DIR:-$HOME/clawd}"
PROFILE_FILE="${INFINIBOT_PROFILE_FILE:-$HOME/.profile}"

PROFILE_MOUNT=()
if [[ -f "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/node/.profile:ro)
fi

echo "==> Build image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo "==> Run gateway live model tests (profile keys)"
docker run --rm -t \
  --entrypoint bash \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
  -e INFINIBOT_LIVE_TEST=1 \
  -e INFINIBOT_LIVE_GATEWAY_MODELS="${INFINIBOT_LIVE_GATEWAY_MODELS:-all}" \
  -e INFINIBOT_LIVE_GATEWAY_PROVIDERS="${INFINIBOT_LIVE_GATEWAY_PROVIDERS:-}" \
  -e INFINIBOT_LIVE_GATEWAY_MODEL_TIMEOUT_MS="${INFINIBOT_LIVE_GATEWAY_MODEL_TIMEOUT_MS:-}" \
  -v "$CONFIG_DIR":/home/node/.infinibot \
  -v "$WORKSPACE_DIR":/home/node/clawd \
  "${PROFILE_MOUNT[@]}" \
  "$IMAGE_NAME" \
  -lc "set -euo pipefail; [ -f \"$HOME/.profile\" ] && source \"$HOME/.profile\" || true; cd /app && pnpm test:live"
