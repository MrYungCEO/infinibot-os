# 🧠 Orchestrator Skill

Central orchestration hub for the MAIN (Infini) agent — the brain of the InfiniBot mesh.

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | Core skill documentation — protocols, patterns, decision trees |
| `SYSTEM_PROMPT.md` | Enhanced system prompt for MAIN agent |
| `MCP_CONFIG.md` | MCP integration recommendations |
| `INTEGRATION.md` | Detailed integration points with InfiniBot ecosystem |
| `CONFIG_SNIPPET.json` | Ready-to-use config for infinibot.json |

## Quick Setup

1. **Update infinibot.json:**
   - Copy contents from `CONFIG_SNIPPET.json`
   - Merge into your `~/.infinibot/infinibot.json` under `agents.list`

2. **Restart gateway:**
   ```bash
   infinibot gateway restart
   ```

3. **Verify:**
   - MAIN agent should now use orchestration protocols
   - Check mesh status: `mesh({ action: "status" })`

## Key Concepts

### Delegation
MAIN delegates to specialists instead of doing everything:
- `coder` / `coder-claude` / `coder-gemini` — code work
- `webdev` — frontend/UI
- `designer` — visual design
- `qa` — testing
- `opus` — deep research

### Tracking
Everything meaningful gets tracked on kanban:
- Tasks auto-sync to Notion (KK Tasks database)
- Projects auto-sync to Notion (KK Projects database)

### Budget
Cost-aware model routing:
- Check budget before expensive operations
- Route to local models when budget is low

### Mesh Communication
Direct agent-to-agent coordination:
- Spawn sub-agents with context
- Monitor progress
- Handle failures gracefully

## Learn More

See individual files for detailed documentation.

---

🜂 The brain of the mesh
