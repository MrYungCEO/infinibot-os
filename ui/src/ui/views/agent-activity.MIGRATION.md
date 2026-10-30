# Spawn Notification Migration Hand-off

**For:** Activity dashboard agent (PID 1331200)  
**Why this file exists:** The notification revamp agent could not touch `agent-activity.ts` (your lane). This documents the one change needed to bridge spawn notifications into the new global glass notification system.

## Current Situation

`agent-activity.ts` maintains a **separate** spawn notification array (`AppViewState.agentActivityState.spawnNotifications`) that renders via its own `renderSpawnNotifications()` function. These notifications:
- Do **not** auto-dismiss
- Do **not** appear in the notifications panel modal
- Do **not** have the glassmorphism style

The new global notification controller (`controllers/notifications.ts`) now supports `type: "spawn"` with an 8-second auto-dismiss TTL and full history tracking.

## The Change (one call site)

In `agent-activity.ts`, find where new spawn notifications are pushed (around line 544):

```typescript
// BEFORE
as.spawnNotifications.push({
  id: `spawn-${row.key}-${Date.now()}`,
  agentId,
  parentAgent: "main",
  task: row.label || row.displayName || row.derivedTitle || row.key,
  timestamp: Date.now(),
  dismissed: false,
});
```

**After** (add this alongside or instead of the existing push):

```typescript
// ADD: bridge to global notification system
const nState = state; // AppViewState satisfies NotificationsState via state.notifications etc.
// You'll need to pass state.notifications, state.notificationHistory, etc.
// OR emit a custom event that app-gateway.ts can handle:
window.dispatchEvent(new CustomEvent("infinibot:spawn-notification", {
  detail: {
    agentId,
    parentAgent: "main",
    task: row.label || row.displayName || row.derivedTitle || row.key,
  },
}));
```

Then in `app-gateway.ts` (or wherever `addNotification` is imported), listen for this event:

```typescript
window.addEventListener("infinibot:spawn-notification", (e) => {
  const { agentId, task } = (e as CustomEvent).detail;
  addNotification(nState, {
    type: "spawn",
    title: "Agent Spawned",
    message: `${agentId} — ${task.slice(0, 80)}`,
    agentId,
  });
});
```

## Alternatively — Direct Call

If you can import `addNotification` and have access to `NotificationsState` in `agent-activity.ts`, the simplest path is:

```typescript
import { addNotification } from "../controllers/notifications";

// At the spawn detection site, alongside the existing push:
addNotification(/* NotificationsState */ state, {
  type: "spawn",
  title: "Agent Spawned",
  message: `${agentId}: ${task.slice(0, 80)}`,
  agentId,
});
```

## Note on the Old System

The existing `renderSpawnNotifications()` / `dismissSpawnNotification()` / `spawnNotifications[]` can remain in place — the new global system runs in parallel. Once you've wired the bridge, you may choose to remove the old inline render, but that's optional cleanup.
