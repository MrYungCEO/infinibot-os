#!/usr/bin/env python3
"""Allow InfiniBot federation spawn tools in Claude Code without prompting.

Merges the required entries into ~/.claude/settings.json -> .permissions.allow.
Idempotent: safe to re-run. Writes atomically with a .bak backup.

Usage:
    python3 scripts/allow-federation-spawns.py

One-liner (curl + run):
    curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/allow-federation-spawns.py | python3 -
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ENTRIES = [
    "mcp__infinibot__infinibot_sessions_spawn",
    "mcp__infinibot__sessions_spawn",
]


def main() -> int:
    path = Path.home() / ".claude" / "settings.json"
    path.parent.mkdir(parents=True, exist_ok=True)

    if path.exists():
        try:
            data = json.loads(path.read_text() or "{}")
        except json.JSONDecodeError as e:
            print(f"error: {path} is not valid JSON ({e}); refusing to overwrite", file=sys.stderr)
            return 1
    else:
        data = {}

    if not isinstance(data, dict):
        print(f"error: {path} root is not an object", file=sys.stderr)
        return 1

    perms = data.setdefault("permissions", {})
    if not isinstance(perms, dict):
        print("error: .permissions is not an object", file=sys.stderr)
        return 1

    allow = perms.get("allow", [])
    if not isinstance(allow, list):
        print("error: .permissions.allow is not an array", file=sys.stderr)
        return 1

    existing = set(allow)
    added = [e for e in ENTRIES if e not in existing]
    if not added:
        print(f"ok: {path} already allows federation spawns ({len(ENTRIES)} entries)")
        return 0

    perms["allow"] = sorted(existing | set(ENTRIES))

    if path.exists():
        backup = path.with_suffix(path.suffix + ".bak")
        backup.write_bytes(path.read_bytes())

    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".settings.", suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    print(f"ok: added {len(added)} entrie(s) to {path}: {', '.join(added)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
