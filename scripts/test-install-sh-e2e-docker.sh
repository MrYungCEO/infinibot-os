#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${INFINIBOT_INSTALL_E2E_IMAGE:-infinibot-install-e2e:local}"
INSTALL_URL="${INFINIBOT_INSTALL_URL:-https://infinibotos.com/install.sh}"

OPENAI_API_KEY="${OPENAI_API_KEY:-}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
ANTHROPIC_API_TOKEN="${ANTHROPIC_API_TOKEN:-}"
INFINIBOT_E2E_MODELS="${INFINIBOT_E2E_MODELS:-}"

echo "==> Build image: $IMAGE_NAME"
docker build \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/docker/install-sh-e2e/Dockerfile" \
  "$ROOT_DIR/scripts/docker/install-sh-e2e"

echo "==> Run E2E installer test"
docker run --rm \
  -e INFINIBOT_INSTALL_URL="$INSTALL_URL" \
  -e INFINIBOT_INSTALL_TAG="${INFINIBOT_INSTALL_TAG:-latest}" \
  -e INFINIBOT_E2E_MODELS="$INFINIBOT_E2E_MODELS" \
  -e INFINIBOT_INSTALL_E2E_PREVIOUS="${INFINIBOT_INSTALL_E2E_PREVIOUS:-}" \
  -e INFINIBOT_INSTALL_E2E_SKIP_PREVIOUS="${INFINIBOT_INSTALL_E2E_SKIP_PREVIOUS:-0}" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e ANTHROPIC_API_TOKEN="$ANTHROPIC_API_TOKEN" \
  "$IMAGE_NAME"
