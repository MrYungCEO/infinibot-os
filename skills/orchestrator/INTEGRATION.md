# Integration Points for MAIN Orchestrator

This document details how the MAIN agent connects to the broader InfiniBot ecosystem.

---

## 🗂️ Kanban Integration

### Notion Sync Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   MAIN Agent    │────▶│  kanban tool    │────▶│  Notion API     │
│   (Infini)         │     │  (gateway)      │     │  (KK databases) │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │
         │                       ▼
         │              ┌─────────────────┐
         │              │  Local Store    │
         │              │  (kanban.json)  │
         │              └─────────────────┘
         │
         ▼
┌─────────────────┐
│  Sub-Agents     │ ── also update kanban
└─────────────────┘
```

### Database Mappings

| InfiniBot Concept | Notion Database | ID |
|-----------------|-----------------|-----|
| Projects | Configured projects database | `notion.projectsDbId` |
| Tasks | Configured tasks database | `notion.tasksDbId` |

### Status Mappings

| InfiniBot Status | KK Tasks Status | KK Projects Status |
|----------------|-----------------|-------------------|
| `backlog` | Not started | Not started |
| `todo` | Not started | Not started |
| `in_progress` | In progress | In progress |
| `review` | Awaiting Response | Reviewing |
| `done` | Done | Completed |

### Usage in Orchestration

```javascript
// Create task when work begins
const task = await kanban({
  action: "create_task",
  title: "Build Authentication API",
  project: "infinibot-project-id",
  priority: "high",
  assignee: "coder",
  description: "Implement JWT-based auth..."
});

// Update as work progresses
await kanban({
  action: "update_task",
  task_id: task.id,
  status: "in_progress",
  description: task.description + "\n\n## Progress\n- Started implementation"
});

// Mark complete
await kanban({
  action: "update_task",
  task_id: task.id,
  status: "done",
  description: task.description + "\n\n## Result\n- API implemented, tests pass"
});
```

---

## 🌐 Federation (Multi-Node)

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     FEDERATION MESH                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   Windows    │◀──▶│  Kali Linux  │◀──▶│   macOS      │       │
│  │   (Master)   │    │   (Node)     │    │   (Node)     │       │
│  │              │    │              │    │              │       │
│  │  MAIN (Infini)  │    │  Infinicode  │    │  iOS Dev     │       │
│  │  Sub-agents  │    │  Secure ops  │    │  Xcode       │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│         │                   │                   │                │
│         └───────────────────┴───────────────────┘                │
│                     Gateway Mesh                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Node Capabilities

| Node | Capabilities | Use Cases |
|------|--------------|-----------|
| Windows (Master) | Full tools, all agents | Primary work, orchestration |
| Kali Linux | Infinicode, secure CLI | Security tasks, isolated coding |
| macOS | Xcode, iOS/macOS dev | Apple platform development |
| Mobile (paired) | Camera, location, notifs | Real-world integration |

### Cross-Node Spawning

```javascript
// Spawn agent on specific node
mesh({
  action: "spawn",
  agentId: "coder",
  node: "kali-linux",
  label: "🔒 Secure: Audit Dependencies",
  task: "Run security audit on node_modules..."
});

// Discover agents across nodes
mesh({
  action: "discover",
  node: "kali-linux",
  capabilities: ["infinicode"]
});
```

### Federation Config

```json
{
  "federation": {
    "mode": "master",
    "masterUrl": "",
    "nodes": {
      "kali-linux": {
        "url": "http://gateway-host:47913",
        "capabilities": ["infinicode", "security", "linux"]
      }
    }
  }
}
```

---

## 💾 Session Management

### Session Storage

```
~/.infinibot/
├── agents/
│   └── main/
│       ├── sessions/
│       │   ├── 2026-03-22_abc123.jsonl  # Session logs
│       │   └── 2026-03-21_def456.jsonl
│       └── agent/
│           └── models.json
└── subagents/
    ├── session-key-1/
    │   └── messages.jsonl
    └── session-key-2/
        └── messages.jsonl
```

### Session Lifecycle

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Created    │────▶│   Running    │────▶│  Completed   │
│   (spawn)    │     │  (working)   │     │   (done)     │
└──────────────┘     └──────────────┘     └──────────────┘
                           │
                           │ (error/timeout)
                           ▼
                     ┌──────────────┐
                     │   Failed     │
                     │  (cleanup)   │
                     └──────────────┘
```

### Monitoring Sessions

```javascript
// List all active sub-agents
const agents = await subagents_list({ includeCompleted: false });
// Returns: [{ runId, sessionKey, label, status, progress, ... }]

// Get specific agent details
const agent = await mesh({
  action: "getAgent",
  sessionKey: "agent:coder:subagent:abc123"
});

// Get agent message history
const messages = await mesh({
  action: "getMessages",
  sessionKey: "agent:coder:subagent:abc123",
  limit: 50
});

// Kill stuck agent
await mesh({
  action: "kill",
  sessionKey: "agent:coder:subagent:abc123",
  reason: "Stuck for 30 minutes, no progress"
});
```

---

## 💰 Budget Integration

### Budget Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  MAIN Agent     │────▶│  budget tool    │────▶│  Usage Store    │
│  route_task()   │     │                 │     │  (state/*.json) │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│  Model Router   │ ── selects optimal model based on:
│                 │    - Task complexity
│                 │    - Budget remaining
│                 │    - Provider availability
└─────────────────┘
```

### Usage Flow

```javascript
// 1. Before expensive operation, check budget
const budget = await budget({ action: "check_budget" });
// Returns: { monthlyLimit, spent, remaining, providers: [...] }

// 2. Get routing recommendation
const route = await budget({
  action: "route_task",
  title: "Build complex feature",
  description: "Multi-file refactor with tests"
});
// Returns: { recommendedModel, estimatedCost, reasoning }

// 3. Execute with recommended model
mesh({
  action: "spawn",
  agentId: "coder",
  model: route.recommendedModel,  // if different from default
  ...
});

// 4. Record usage after completion
await budget({
  action: "record_usage",
  provider: "anthropic",
  model: "claude-opus-4",
  tokens_in: 5000,
  tokens_out: 2000,
  cost_usd: 0.15
});
```

### Budget Thresholds

| Remaining | Action |
|-----------|--------|
| >50% | Use optimal model |
| 25-50% | Consider cheaper alternatives |
| <25% | Route to local/free models |
| <10% | Notify user, defer non-critical |

---

## 🎯 Focus Board Integration

### Focus Architecture

```
┌─────────────────┐     ┌─────────────────┐
│  Focus Board    │────▶│  Notion Sync    │
│  (top 5)        │     │  (optional)     │
└─────────────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│  Priority Queue │ ── drives task order
└─────────────────┘
```

### Usage

```javascript
// Check current focus
const focus = await focus({ action: "list" });
// Returns: [{ position, itemId, title, status }, ...]

// Add task to focus (by Notion ID)
await focus({
  action: "add_task",
  taskId: "notion-page-id"
});

// Add project to focus
await focus({
  action: "add_project",
  projectId: "notion-project-page-id"
});

// Reorder priorities
await focus({
  action: "reorder",
  itemId: "...",
  position: 1  // Move to top
});

// Clear focus when switching contexts
await focus({ action: "clear" });
```

### Focus-Driven Workflow

```javascript
// On heartbeat, check focus
const priorities = await focus({ action: "list" });

if (priorities.length > 0) {
  const topPriority = priorities[0];
  
  // Check if already being worked on
  const agents = await subagents_list({});
  const working = agents.some(a => a.label.includes(topPriority.title));
  
  if (!working) {
    // Spawn agent for top priority
    mesh({
      action: "spawn",
      agentId: "coder",
      label: `🎯 Focus: ${topPriority.title}`,
      task: `Priority #1: ${topPriority.title}\n\n${topPriority.description}`
    });
  }
}
```

---

## 📡 Communication Channels

### Available Channels

| Channel | Use Case | Config Key |
|---------|----------|------------|
| Telegram | Primary user communication | `channels.telegram` |
| Discord | Community/team | `channels.discord` |
| WhatsApp | Mobile notifications | `channels.whatsapp` |

### Channel Selection

```javascript
// User's primary channel (from session context)
// Usually determined by where the conversation started

// Explicit notification
message({
  action: "send",
  channel: "telegram",  // or detect from context
  message: "🚨 Task completed: ..."
});
```

### Cross-Channel Considerations

- **Don't spam** — one channel for notifications is enough
- **Respect quiet hours** — check time before sending
- **Group awareness** — different behavior in groups vs DMs

---

## 🔄 Heartbeat Integration

### Heartbeat Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Scheduler   │────▶│  HEARTBEAT.md│────▶│  MAIN Agent  │
│  (every 1h)  │     │  (checklist) │     │  (execute)   │
└──────────────┘     └──────────────┘     └──────────────┘
```

### Orchestration Heartbeat Tasks

On each heartbeat, MAIN should:

1. **Check sub-agents** — any stuck or completed?
2. **Check focus board** — priorities still aligned?
3. **Check budget** — any warnings?
4. **Check kanban** — any overdue tasks?
5. **Update memory** — any insights to persist?

### HEARTBEAT.md Template

```markdown
# Orchestration Heartbeat

## Check Sub-Agents
- [ ] Any agents stuck >10 min?
- [ ] Any agents completed but not cleaned up?
- [ ] Any agents needing context?

## Check Priorities
- [ ] Focus board reflects current priorities?
- [ ] Any urgent items not being worked on?

## Check Resources
- [ ] Budget status OK?
- [ ] Any errors in recent logs?

## Housekeeping
- [ ] Clean up completed sessions
- [ ] Update memory with learnings
```

---

## 🔗 Integration Checklist

### Before Deployment

- [ ] Notion API key configured
- [ ] Kanban databases connected (KK Tasks, KK Projects)
- [ ] Budget tool working
- [ ] Focus tool working
- [ ] Mesh tool working
- [ ] Telegram channel active

### After Deployment

- [ ] Test sub-agent spawn
- [ ] Test kanban create/update
- [ ] Test focus add/remove
- [ ] Test budget check
- [ ] Test cross-agent communication

### Ongoing

- [ ] Monitor sub-agent health
- [ ] Track budget usage
- [ ] Update priorities as needed
- [ ] Clean up completed work

---

🔌 Integration is the glue. Keep everything connected and flowing.
