# Restore Leads Database

## Backup location

Each time `bun scripts/fix-leads.ts --mode=apply` is run, a timestamped backup
is created at:

```
state/funnels/funnels.db.backup-YYYY-MM-DD-HHmm
```

The exact path is printed at the end of the apply run.

---

## How to restore (full rollback)

1. **Stop the InfiniBot gateway** (important — avoid write conflicts):
   ```bash
   # If running under systemd:
   systemctl --user stop infinibot
   # Or kill the node/bun process directly.
   ```

2. **Copy the backup over the live DB:**
   ```bash
   cp state/funnels/funnels.db.backup-YYYY-MM-DD-HHmm \
      state/funnels/funnels.db
   ```
   Replace `YYYY-MM-DD-HHmm` with the actual timestamp from the apply run.

3. **Restart the gateway:**
   ```bash
   systemctl --user start infinibot
   # or: bun src/index.ts  (dev mode)
   ```

---

## How to un-quarantine a single lead via the dashboard

1. Open the Leads page in the InfiniBot dashboard.
2. The pipeline view filters out `quarantined` leads by default. To see them,
   pass `?includeQuarantined=true` in the `leads.pipeline` call, or use the
   raw database viewer.
3. Find the lead, open its detail panel.
4. Change the **LifecycleStatus** (or **Status**) field from `quarantined`
   back to `raw` (or whatever stage is appropriate).
5. Optionally clear `customFields.quarantinedAt` and `customFields.quarantineReason`
   if you want to remove the quarantine metadata.

---

## Rolling back individual name fixes (nameAutoFixedFrom)

Every lead whose name was auto-fixed has two fields in its `custom_fields` JSON:

```json
{
  "nameAutoFixedAt": "2026-05-27T...",
  "nameAutoFixedFrom": "<original name>"
}
```

To restore the original name for a single lead without a full DB restore:

1. Find the lead in the dashboard.
2. Edit its name to the value in `nameAutoFixedFrom`.
3. Remove `nameAutoFixedAt` and `nameAutoFixedFrom` from `custom_fields`
   (or leave them as an audit trail — they won't affect behaviour).

---

## WAL / write-lock note

The gateway uses SQLite WAL mode. You do **not** need to stop the gateway before
running the audit script (read-only). For the apply script, the transaction
wrapper handles concurrent reads safely. However, if the gateway holds a
long-lived write lock (rare), the apply will wait up to 5 seconds (`busy_timeout`)
before failing. If that happens, stop the gateway, apply, then restart.
