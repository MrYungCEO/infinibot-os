#!/usr/bin/env bash
# The ui type check already fails on the base (hundreds of older errors), so a
# raw `tsc --noEmit` exit code says nothing about a branch. This compares the
# branch's errors against a base ref and exits 0 only when none are new.
#
#   bash ui/src/ui/cloud/verify/tsc-no-new-errors.sh [base-ref]   (default 8d98e1b4)
#
# Not shipped. Uses a scratch worktree with the same symlinked node_modules.
set -uo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
BASE_REF="${1:-8d98e1b4}"
TMP="$(mktemp -d /tmp/tsc-base.XXXXXX)"
cleanup() { git -C "$ROOT" worktree remove --force "$TMP/wt" >/dev/null 2>&1; rm -rf "$TMP"; git -C "$ROOT" worktree prune; }
trap cleanup EXIT

git -C "$ROOT" worktree add -q --detach "$TMP/wt" "$BASE_REF" || exit 3
ln -s "$(readlink -f "$ROOT/node_modules")" "$TMP/wt/node_modules"
ln -s "$(readlink -f "$ROOT/ui/node_modules")" "$TMP/wt/ui/node_modules"

# Line and column numbers shift with unrelated edits; compare file + message.
errors() { (cd "$1/ui" && npx tsc -p tsconfig.json --noEmit 2>&1) | grep "error TS" | sed 's/([0-9,]*)//' | sort; }
errors "$TMP/wt" > "$TMP/base.txt"
errors "$ROOT" > "$TMP/branch.txt"
comm -13 "$TMP/base.txt" "$TMP/branch.txt" > "$TMP/new.txt"

echo "base ($BASE_REF): $(wc -l < "$TMP/base.txt") errors, branch: $(wc -l < "$TMP/branch.txt") errors, new: $(wc -l < "$TMP/new.txt")"
if [ -s "$TMP/new.txt" ]; then cat "$TMP/new.txt"; exit 1; fi
[ -s "$TMP/base.txt" ] || { echo "base produced no errors: tsc did not run?"; exit 3; }
echo "OK: no new type errors versus $BASE_REF"
