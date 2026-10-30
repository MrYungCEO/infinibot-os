---
summary: "CLI reference for `infinibot reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
---

# `infinibot reset`

Reset local config/state (keeps the CLI installed).

```bash
infinibot reset
infinibot reset --dry-run
infinibot reset --scope config+creds+sessions --yes --non-interactive
```

