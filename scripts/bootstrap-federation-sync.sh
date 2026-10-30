#!/usr/bin/env bash
# InfiniBot Federation Sync Bootstrap
# Detects platform and sets up periodic code sync via GitHub.
# Usage: bash scripts/bootstrap-federation-sync.sh [role] [remote] [branch]
set -euo pipefail

ROLE="${1:-satellite}"
REMOTE="${2:-origin}"
BRANCH="${3:-main}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOSTNAME="$(hostname 2>/dev/null || echo 'unknown')"

echo "=== InfiniBot Federation Sync Bootstrap ==="
echo "  Host:    $HOSTNAME"
echo "  Role:    $ROLE"
echo "  Remote:  $REMOTE"
echo "  Branch:  $BRANCH"
echo "  Repo:    $REPO_DIR"
echo ""

# Validate git repo
if ! git -C "$REPO_DIR" rev-parse --git-dir > /dev/null 2>&1; then
  echo "ERROR: $REPO_DIR is not a git repository"
  exit 1
fi

# Validate remote
if ! git -C "$REPO_DIR" remote get-url "$REMOTE" > /dev/null 2>&1; then
  echo "ERROR: Remote '$REMOTE' not found. Available remotes:"
  git -C "$REPO_DIR" remote -v
  exit 1
fi

# Ensure we're on the right branch
CUR_BRANCH=$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)
if [ "$CUR_BRANCH" != "$BRANCH" ]; then
  echo "WARNING: Current branch is '$CUR_BRANCH', not '$BRANCH'."
  echo "  The sync system will track $REMOTE/$BRANCH regardless."
fi

# Set up environment for the sync daemon
export FEDERATION_ROLE="$ROLE"
export FEDERATION_GIT_REMOTE="$REMOTE"
export FEDERATION_GIT_BRANCH="$BRANCH"
export FEDERATION_REPO_PATH="$REPO_DIR"

PLATFORM=$(uname -s)

case "$PLATFORM" in
  Linux)
    echo "Detected Linux — installing systemd timer..."
    cd "$REPO_DIR"
    pnpm federation-sync:daemon
    echo ""
    echo "Timer status:"
    systemctl status federation-sync.timer --no-pager 2>&1 | head -5
    ;;
  Darwin)
    echo "Detected macOS — installing launchd agent..."
    cd "$REPO_DIR"
    pnpm federation-sync:daemon
    echo ""
    echo "LaunchAgent status:"
    launchctl list com.infinibot.federation-sync 2>&1
    ;;
  *)
    echo "Detected $PLATFORM — manual setup required."
    echo "To sync manually:"
    echo "  cd $REPO_DIR && pnpm federation-sync sync"
    echo ""
    echo "To see sync status:"
    echo "  cd $REPO_DIR && pnpm federation-sync status"
    ;;
esac

echo ""
echo "=== Bootstrap Complete ==="
echo "Run 'pnpm federation-sync status' to check sync status."
echo "Run 'pnpm federation-sync sync --dry-run' for a safe test."