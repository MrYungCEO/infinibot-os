---
summary: "CLI reference for `infinibot cron` (schedule and run background jobs)"
read_when:
  - You want scheduled jobs and wakeups
  - You’re debugging cron execution and logs
---

# `infinibot cron`

Manage cron jobs for the Gateway scheduler.

Related:
- Cron jobs: [Cron jobs](/automation/cron-jobs)

Tip: run `infinibot cron --help` for the full command surface.

## Common edits

Update delivery settings without changing the message:

```bash
infinibot cron edit <job-id> --deliver --channel telegram --to "123456789"
```

Disable delivery for an isolated job:

```bash
infinibot cron edit <job-id> --no-deliver
```
