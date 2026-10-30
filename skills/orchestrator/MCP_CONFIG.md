# MCP Configuration for MAIN Orchestrator

This document outlines MCP (Model Context Protocol) integrations to enhance the MAIN agent's orchestration capabilities.

---

## Current MCPs (Already Configured)

### 0. Canva MCP ✅
**Package:** `@mcp_factory/canva-mcp-server@1.0.0` (npm, MIT)
**Purpose:** Manage Canva designs, assets, exports, folders, and brand templates via the Canva Connect REST API

**Status:** Registered in `~/.infinibot/mcp-servers.json`. Requires `CANVA_ACCESS_TOKEN` to activate.

**Tools (25):**
- `canva_list_designs`, `canva_create_designs`, `canva_get_designs`, `canva_get_designs_pages`
- `canva_create_exports`, `canva_get_exports` (PDF, PNG, JPG, PPTX, GIF, MP4)
- `canva_create_folders`, `canva_get_folders`, `canva_update_folders`, `canva_delete_folders`, `canva_get_folders_items`, `canva_create_folders_move`
- `canva_get_assets`, `canva_update_assets`, `canva_delete_assets`
- `canva_list_brand_templates`, `canva_get_brand_templates`, `canva_get_brand_templates_dataset`, `canva_create_autofills`, `canva_get_autofills`
- `canva_list_users_me`, `canva_list_me_profile`
- `canva_create_designs_comments`, `canva_get_comments_replies`, `canva_create_comments_replies`

**Auth:** Canva Connect API personal access token (OAuth bearer). No full OAuth flow — just a single token.

**Setup (3 steps):**
1. Go to https://www.canva.com/developers/apps → create an integration (or open existing)
2. Under the integration, click **Generate token** → copy the access token
3. Open `~/.infinibot/mcp-servers.json` and replace `""` with your token:
   ```json
   "canva": {
     "command": "npx",
     "args": ["-y", "@mcp_factory/canva-mcp-server@1.0.0"],
     "env": { "CANVA_ACCESS_TOKEN": "YOUR_TOKEN_HERE" }
   }
   ```
4. Restart the InfiniBot gateway: `infinibot gateway restart`

**To enable for an agent**, add `"canva"` to its `enabledMCPs` array:
```json
{ "id": "coder", "enabledMCPs": ["canva"] }
```

**Registry entry (verbatim, as stored in `~/.infinibot/mcp-servers.json`):**
```json
"canva": {
  "command": "npx",
  "args": ["-y", "@mcp_factory/canva-mcp-server@1.0.0"],
  "env": {
    "CANVA_ACCESS_TOKEN": ""
  },
  "description": "Canva Connect API — designs, assets, exports, brand templates (25 tools)",
  "syncToClaudeCode": true
}
```

---

### 1. Notion MCP ✅
**Purpose:** Kanban sync, workspace integration, document management

**Status:** Built into InfiniBot via `NOTION_API_KEY`

**Capabilities:**
- Sync tasks/projects to Notion databases (KK Tasks, KK Projects)
- Create/update pages
- Query databases

**Config:**
```json
{
  "env": {
    "vars": {
      "NOTION_API_KEY": "ntn_..."
    }
  }
}
```

### 2. Brave Search MCP ✅
**Purpose:** Web search for research and fact-checking

**Status:** Built into InfiniBot via `BRAVE_API_KEY`

**Config:**
```json
{
  "env": {
    "vars": {
      "BRAVE_API_KEY": "BSA..."
    }
  }
}
```

---

## Recommended MCPs to Add

### 3. MetaMCP (Unified MCP Management)
**Purpose:** Single gateway to manage all MCPs dynamically

**Benefits:**
- Add/remove MCPs without config changes
- Share MCPs across agents
- Centralized MCP health monitoring

**Installation:**
```bash
npm install -g @anthropic/metamcp
```

**Config (add to ~/.claude/mcp.json):**
```json
{
  "mcpServers": {
    "metamcp": {
      "command": "metamcp",
      "args": ["serve"],
      "env": {}
    }
  }
}
```

**Note:** MetaMCP is still evolving. Monitor https://github.com/anthropics/anthropic-cookbook for updates.

---

### 4. Pipedream MCP (2500+ API Integrations)
**Purpose:** Trigger automations, connect to external services without custom code

**Benefits:**
- No-code API connections
- Webhook triggers
- 2500+ pre-built integrations (Slack, GitHub, Google, etc.)

**Setup:**
1. Create account at https://pipedream.com
2. Get API key from Settings → API Keys
3. Configure workflows in Pipedream dashboard

**Config:**
```json
{
  "mcpServers": {
    "pipedream": {
      "command": "npx",
      "args": ["-y", "@pipedream/mcp-server"],
      "env": {
        "PIPEDREAM_API_KEY": "pd_..."
      }
    }
  }
}
```

**Use Cases:**
- Trigger deployments on task completion
- Send Slack notifications to team
- Sync data between services
- Schedule recurring workflows

---

### 5. Slack MCP (Team Channel Coordination)
**Purpose:** Direct Slack integration for team notifications

**Benefits:**
- Send messages to channels/users
- Read channel history
- Create threads for task updates

**Config:**
```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@anthropic/slack-mcp"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_APP_TOKEN": "xapp-..."
      }
    }
  }
}
```

**Required Slack App Scopes:**
- `chat:write`
- `channels:history`
- `channels:read`
- `users:read`

---

### 6. Telegram MCP (Enhanced Channel Control)
**Purpose:** Richer Telegram automation beyond built-in plugin

**Note:** InfiniBot already has built-in Telegram support. This MCP would add:
- Scheduled messages
- Inline query responses
- Bot command handling
- Group management

**Config:**
```json
{
  "mcpServers": {
    "telegram": {
      "command": "npx",
      "args": ["-y", "@your-org/telegram-mcp"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "..."
      }
    }
  }
}
```

---

### 7. GitHub MCP (Enhanced Repo Operations)
**Purpose:** Rich GitHub integration beyond CLI

**Benefits:**
- Create/manage issues programmatically
- Review PRs with structured feedback
- Manage releases
- Track CI status

**Config:**
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    }
  }
}
```

---

### 8. Google Calendar MCP (Time-Aware Scheduling)
**Purpose:** Calendar integration for scheduling-aware orchestration

**Benefits:**
- Check availability before scheduling
- Create events for deadlines
- Time-block focus periods
- Meeting reminders

**Note:** Already have calendar-api.ps1 helper. MCP would provide native integration.

**Config:**
```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "npx",
      "args": ["-y", "@anthropic/google-calendar-mcp"],
      "env": {
        "GOOGLE_CALENDAR_CREDENTIALS": "/path/to/credentials.json"
      }
    }
  }
}
```

---

## InfiniBot Config Additions

Add these to `~/.infinibot/infinibot.json`:

### Agent-Specific MCP Access

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "mcps": {
          "allow": ["notion", "metamcp", "pipedream", "slack", "github", "calendar"]
        }
      },
      {
        "id": "coder",
        "mcps": {
          "allow": ["github", "notion"]
        }
      },
      {
        "id": "monitor",
        "mcps": {
          "allow": ["slack", "notion"]
        }
      }
    ]
  }
}
```

### Global MCP Settings

```json
{
  "mcp": {
    "servers": {
      "pipedream": {
        "enabled": true,
        "command": "npx",
        "args": ["-y", "@pipedream/mcp-server"],
        "env": {
          "PIPEDREAM_API_KEY": "${PIPEDREAM_API_KEY}"
        }
      }
    },
    "timeout": 30000,
    "healthCheck": {
      "enabled": true,
      "interval": "5m"
    }
  }
}
```

---

## Integration Patterns

### Pattern: Task Completion → Slack Notification

```javascript
// In sub-agent task:
// When done, call Pipedream webhook or Slack MCP directly

// Via Pipedream:
fetch("https://eo123abc.m.pipedream.net", {
  method: "POST",
  body: JSON.stringify({
    event: "task_complete",
    task: "Build Authentication",
    agent: "coder",
    status: "done"
  })
});

// Via Slack MCP:
slack.postMessage({
  channel: "#builds",
  text: "✅ Task Complete: Build Authentication"
});
```

### Pattern: GitHub PR → Auto-Review Spawn

```javascript
// GitHub webhook triggers Pipedream
// Pipedream calls InfiniBot gateway wake
// MAIN spawns QA agent to review

// Pipedream workflow:
// 1. Receive GitHub PR webhook
// 2. POST to infinibot gateway: /wake?text=Review PR #123
// 3. MAIN agent receives, spawns QA agent
```

### Pattern: Calendar-Aware Scheduling

```javascript
// Before spawning long task:
const availability = await calendar.checkAvailability({
  start: new Date(),
  duration: "2h"
});

if (availability.busy) {
  // Schedule for next free block
  kanban({ action: "update_task", status: "backlog", description: "Scheduled for " + availability.nextFree });
} else {
  // Spawn immediately
  mesh({ action: "spawn", ... });
}
```

---

## Security Considerations

### MCP Token Management

- Store tokens in `infinibot.json` env vars (encrypted at rest)
- Use environment variables for CI/CD
- Rotate tokens periodically
- Scope tokens to minimum required permissions

### MCP Sandboxing

- MCPs run in isolated processes
- Network access controlled by MCP config
- File access limited to declared paths
- Audit logs for sensitive operations

### Cross-Agent MCP Access

- Default: MCPs available to all agents
- Override with agent-specific `mcps.allow` list
- Sensitive MCPs (payments, admin) → restricted to MAIN only

---

## Monitoring & Health

### MCP Health Checks

```javascript
// Check MCP status periodically
const mcpStatus = await mcp.healthCheck();
// Returns: { notion: "healthy", slack: "degraded", ... }
```

### MCP Fallbacks

When MCP fails:
1. Log error with context
2. Attempt retry (3x with backoff)
3. Fall back to alternative (e.g., direct API call)
4. Notify user if critical

---

## Implementation Priority

1. **Now:** Ensure Notion + Brave working optimally
2. **Soon:** Add Pipedream for API integrations
3. **Later:** GitHub MCP for PR workflows
4. **Consider:** MetaMCP when stable, Slack for team features

---

🔌 MCPs extend your reach. Use them wisely.
