---
id: project-onboarding
name: Project Onboarding
version: 1.0.0
events:
  - command:new
description: |
  Automatically triggers project onboarding when a new session is created.
  Prompts the user to set up a tracked project with mission, goals, and subtasks.
---

# Project Onboarding Hook

This hook auto-triggers the project onboarding flow when:
- A `/new` command is used to start a fresh session
- A webchat session starts without a linked project

## What It Does

1. Detects when a new session is created
2. Checks for existing active projects
3. Presents onboarding prompt with options:
   - **Continue** existing project
   - **Extend** existing project (add subtasks)
   - **Create** new project
   - **Skip** project tracking

## Configuration

No configuration needed - this hook is automatically enabled.

## User Commands

After this hook triggers, users can also manually control projects with:
- `/project list` — List all projects
- `/project new` — Start new project setup
- `/project status` — Show current project status
- `/session link <id>` — Link session to existing project
