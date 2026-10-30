#!/usr/bin/env bash
# Rebuild the control UI into a temp dir and swap it into dist/control-ui
# atomically, so a gateway serving this tree never sees a half-built UI.
# Serialized with flock (parallel authors share one worktree).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK="${LEARN_UI_LOCK:-/tmp/learn-ui-build.lock}"
exec 9>"$LOCK"
flock 9
cd "$ROOT/ui"
npx vite build --outDir "$ROOT/dist/control-ui.next" --emptyOutDir > "${LEARN_UI_LOG:-/tmp/learn-ui-build.log}" 2>&1 || { tail -30 "${LEARN_UI_LOG:-/tmp/learn-ui-build.log}"; exit 1; }
cd "$ROOT/dist"
rm -rf control-ui.old
[ -d control-ui ] && mv control-ui control-ui.old
mv control-ui.next control-ui
rm -rf control-ui.old
echo "ui swapped: $ROOT/dist/control-ui"
