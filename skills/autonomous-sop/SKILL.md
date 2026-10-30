# ASOP — Agent Standard Operating Procedure for Autonomous Work

**Purpose:** Structured collaborative workflow for autonomous task execution. Ensures the agent understands scope, has what it needs, knows success criteria, and can communicate with the partner throughout.

## When This Applies

- **ALWAYS** for user-assigned top-level tasks (via Kanban, Autonomy tab, or direct request)
- **NOT** for subtasks the agent creates to achieve the main task
- **NOT** for quick queries or conversational exchanges

## Pre-Flight Checklist (MANDATORY)

Before starting ANY autonomous task, answer these questions:

### 1. What Am I Doing?

```
□ Is this a NEW PROJECT or a TASK within an existing project?
□ What is the project name/context?
□ What are the boundaries of this task?
□ What am I NOT supposed to do?
```

**Context Detection Protocol:**
- Search Kanban projects for matching names/keywords
- Check existing project directories in workspace
- Look for related documentation
- **NEVER create a new app/project if updating existing**

Example: "Update sidebar on Infinibot" → Find existing Infinibot project, update within it

### 2. What Do I Need?

```
□ API keys or credentials?
□ Access to specific services?
□ Files or documentation?
□ Clarification on requirements?
□ Partner availability for questions?
```

**If anything is missing:** Message partner on Telegram BEFORE starting.

### 3. What Does Success Look Like?

```
□ Concrete deliverable defined?
□ Acceptance criteria clear?
□ How will partner verify completion?
□ What does "done" mean specifically?
```

### 4. What Does The Partner Need To Do?

```
□ Any human actions required during execution?
□ Any handoffs at completion?
□ Partner review/approval needed?
□ External dependencies on partner?
```

### 5. How Do I Reach The Partner?

```
□ Primary channel: Telegram
□ Urgency threshold defined?
□ When to message vs. when to proceed?
```

**Default:** Message on Telegram for any blocker. Don't wait silently.

### 6. What's My Test Workflow?

```
□ How do I verify this works before marking complete?
□ Automated tests where possible?
□ Manual test steps documented?
□ Partner verification workflow?
```

**Rule:** NO functional task is complete without a test workflow.

---

## Task Brief Template

Create this for EVERY autonomous task before execution:

```markdown
## Task Brief: [Task Name]

**ID:** [auto-xxx]
**Project:** [Existing project name or "NEW: [name]"]
**Assigned:** [timestamp]
**Partner Contact:** Telegram

### Scope
- [ ] New Project / [ ] Task in Existing Project
- Boundaries: [what this includes]
- Excluded: [what this does NOT include]

### Requirements
- Resources needed: [API keys, access, files]
- Missing: [anything not yet obtained]
- Clarifications needed: [questions for partner]

### Success Criteria
- Deliverable: [what will exist when done]
- Verification: [how to confirm it works]
- Partner sign-off: [yes/no, what they review]

### Partner Dependencies
- Actions needed from partner: [if any]
- Handoffs: [what partner receives]

### Test Workflow
**Automated:**
- [ ] [test 1]
- [ ] [test 2]

**Manual (Partner Verification):**
1. [Step 1]
2. [Step 2]
3. [Expected result]

### Status
- [ ] Pre-flight complete
- [ ] Requirements gathered
- [ ] In progress
- [ ] Testing complete
- [ ] Partner verified
- [ ] DONE
```

---

## Communication Protocol

### When To Message Partner (Telegram)

**IMMEDIATELY:**
- Missing API key or credential
- Unclear requirements that block progress
- Discovered scope is larger than expected
- Found existing work that conflicts with task
- Test failure you can't resolve
- Any security/safety concern

**AT CHECKPOINTS:**
- Midway progress update (optional, for long tasks)
- Completion notification
- Test results summary

**DON'T MESSAGE FOR:**
- Routine progress (unless asked)
- Self-resolvable issues
- Information you can find yourself

### Message Format

```
🤖 [AUTONOMOUS TASK UPDATE]

Task: [name]
Status: [blocked/progress/complete]

[Specific question or update]

Need: [what you need from partner]
```

---

## Project Context Detection

Before creating ANYTHING new, search for existing context:

```python
# Pseudo-code for context detection
1. Parse task description for project names/keywords
2. Search kanban.projects for matches
3. Search workspace directories for matching paths
4. Check recent session history for related work
5. If found: work WITHIN existing project
6. If not found: confirm with partner before creating new
```

### Red Flags (Pause and Confirm)

- Task mentions app/project name that might exist
- Multiple projects with similar names
- Task seems to duplicate existing work
- Scope seems larger than stated

---

## Test Workflow Requirements

### For Code/Functional Tasks:

1. **Unit tests** where applicable
2. **Integration test** if multiple components
3. **Manual verification steps** documented
4. **Partner verification workflow** provided

### For Documentation/Research:

1. **Accuracy check** — verify sources
2. **Completeness check** — all sections filled
3. **Clarity check** — partner can understand it

### For Configuration/Setup:

1. **Validation command** — how to verify it works
2. **Rollback steps** — how to undo if needed
3. **Success indicator** — what confirms it's working

---

## Updated Queue Schema

```json
{
  "id": "auto-xxx",
  "title": "Task name",
  "description": "What needs to be done",
  
  "context": {
    "projectId": "kanban-project-id or null",
    "projectName": "Existing project name",
    "isNewProject": false,
    "existingPaths": ["paths/to/existing/code"],
    "relatedTasks": ["task-ids"]
  },
  
  "brief": {
    "scope": "description of boundaries",
    "excluded": "what this does NOT include",
    "requirements": {
      "apiKeys": ["list of needed keys"],
      "access": ["services/systems needed"],
      "clarifications": ["pending questions"]
    },
    "successCriteria": "concrete deliverable definition",
    "partnerDependencies": ["actions partner must take"],
    "testWorkflow": {
      "automated": ["test descriptions"],
      "manual": ["verification steps"]
    }
  },
  
  "partnerContact": {
    "channel": "telegram",
    "lastContact": "timestamp",
    "pendingQuestions": []
  },
  
  "preflightComplete": false,
  "approvalLevel": "auto|notify|requires_approval",
  "status": "pending_preflight|pending_approval|approved|in_progress|blocked|testing|complete|failed",
  
  "execution": {
    "type": "code|research|file_ops|documentation|communication",
    "instructions": "specific instructions",
    "maxDurationMinutes": 30
  },
  
  "audit": { ... }
}
```

---

## Workflow Integration Points

### Kanban → Autonomous Assignment

When task is dragged to "Assign to Agent" in Kanban:
1. Create task brief skeleton
2. Set status to `pending_preflight`
3. Agent fills pre-flight checklist
4. If questions: message partner on Telegram
5. Once pre-flight complete: set status to `approved` (or `pending_approval` if complex)
6. Execute with full context

### Autonomy Tab (Web/Mobile)

Display:
- Current task brief
- Pre-flight checklist status
- Communication log
- Test workflow status
- Progress indicators

Actions:
- View/edit task brief
- Approve pending tasks
- Send message to agent
- View audit log

### Heartbeat Execution

Modified flow:
1. Check for tasks with `status: approved`
2. Verify `preflightComplete: true`
3. If not complete: attempt to complete pre-flight
4. If blocked: message partner
5. Execute only when pre-flight satisfied

---

## Example Flow

**Partner assigns:** "Update sidebar on Infinibot" via Kanban drag

**Agent Pre-Flight:**
```
1. WHAT: Task in existing project "Infinibot"
   - Found: /path/to/project
   - This is a UI update, not new project
   
2. NEED: 
   - ✅ Access to codebase (have it)
   - ❓ What should sidebar contain? → MESSAGE PARTNER
   
3. SUCCESS: Sidebar renders with new content, matches design
   
4. PARTNER: Review updated sidebar in dev
   
5. CONTACT: Telegram
   
6. TEST:
   - Automated: Component renders without error
   - Manual: Partner views at localhost:3000, confirms content
```

**Agent messages Telegram:**
```
🤖 [AUTONOMOUS TASK UPDATE]

Task: Update sidebar on Infinibot
Status: blocked (pre-flight)

Found existing Infinibot project at expected path.
Before I update the sidebar, I need to know:
- What content should the sidebar display?
- Any specific design/layout requirements?

Need: Sidebar content specification
```

**Partner responds, agent proceeds.**

---

🜂 Collaborative autonomy. Structured trust.
