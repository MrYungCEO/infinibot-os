#!/usr/bin/env bash
# InfiniBot setup from a git checkout (Linux / macOS).
#
# Safe to re-run. It never rewrites your git remotes, never switches branches,
# never stashes or resets your work. It only checks prerequisites, installs
# dependencies from the committed lockfile and builds the gateway + control UI.
#
# Usage:
#   git clone <repo-url> InfiniBot && cd InfiniBot
#   bash scripts/satellite-setup.sh            # install + build
#   bash scripts/satellite-setup.sh --update   # also fast-forward the current
#                                              # branch first (skipped if the
#                                              # tree has local changes)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UPDATE=0
for arg in "$@"; do
  case "$arg" in
    --update) UPDATE=1 ;;
    -h | --help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

cd "$REPO_DIR"
echo "=== InfiniBot setup ==="
echo "  repo: $REPO_DIR"
echo ""

# 1) Node 22.12+
echo "[1/4] checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js 22.12+ is required (https://nodejs.org, or: nvm install 22)." >&2
  exit 1
fi
NODE_VERSION="$(node -p 'process.versions.node')"
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)'; then
  echo "ERROR: Node $NODE_VERSION found; InfiniBot needs Node 22.12 or newer (nvm install 22)." >&2
  exit 1
fi
echo "      node $NODE_VERSION"

# 2) pnpm (via corepack when available; version pinned by package.json)
echo "[2/4] checking pnpm"
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
  fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "ERROR: pnpm not found. Run: corepack enable   (or: npm install -g pnpm)" >&2
  exit 1
fi
echo "      pnpm $(pnpm --version)"

# Optional: fast-forward only, never destructive.
if [ "$UPDATE" = "1" ]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "      --update skipped: you have local changes (commit or stash them first)."
  elif ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    echo "      --update skipped: current branch has no upstream."
  else
    echo "      fast-forwarding $(git rev-parse --abbrev-ref HEAD)"
    git pull --ff-only
  fi
fi

# 3) Install dependencies exactly as locked.
echo "[3/4] installing dependencies"
pnpm install --frozen-lockfile

# 4) Build backend + control UI.
echo "[4/4] building (backend + control UI)"
pnpm build:all

echo ""
echo "Done. Next:"
echo "  pnpm infinibot onboard      # pick a model provider, set a gateway password"
echo "  pnpm infinibot gateway      # start the gateway, then open the printed URL"
