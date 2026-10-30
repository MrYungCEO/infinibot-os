---
summary: "CLI reference for `infinibot logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
---

# `infinibot logs`

Tail Gateway file logs over RPC (works in remote mode).

Related:
- Logging overview: [Logging](/logging)

## Examples

```bash
infinibot logs
infinibot logs --follow
infinibot logs --json
infinibot logs --limit 500
```

