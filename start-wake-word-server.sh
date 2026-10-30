#!/usr/bin/env bash
# OpenWakeWord Server (100% Local) — Linux / macOS launcher.
# Mirrors start-wake-word-server.bat so the wake-word feature has a
# one-shot launcher on every platform.
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================"
echo "  OpenWakeWord Server (100% Local)"
echo "========================================"
echo

# Install dependencies if openwakeword isn't importable yet.
if ! python3 -c "import openwakeword" 2>/dev/null; then
  echo "Installing dependencies…"
  python3 -m pip install --user openwakeword websockets numpy
  echo
fi

echo "Starting wake word server on ws://localhost:8765/wake"
echo 'Say "Hey Jarvis" to trigger wake word detection'
echo
exec python3 -m infinibot_stt.wake_word_server
