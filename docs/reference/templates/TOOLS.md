---
summary: "Workspace template for TOOLS.md"
read_when:
  - Bootstrapping a workspace manually
---
# TOOLS.md - Local Notes

Skills and built-in tools define *how* things work. This file is for *your* specifics: the details that are unique to this setup.

InfiniBot already gives you its built-in tools (files, shell, browser, messaging, memory and so on). You don't need to list them here. Use this file for the environment knowledge that makes those tools useful.

## What Goes Here

- Machines and SSH aliases (never paste private keys or passwords)
- Local services and their URLs (for example a local Ollama or Kokoro TTS endpoint)
- Preferred voices, speakers and rooms
- Project folders and repositories you work in often
- Naming conventions, device nicknames, anything environment-specific

## Where Secrets Go

Don't store API keys, tokens or passwords in this file. It is plain text and gets read into prompts. Put credentials in the InfiniBot config / credential store (`infinibot configure`) or in environment variables, and just note *which* variable to use here.

## Examples

```markdown
### SSH
- home-server → ssh alias `home`, user `me` (key in ~/.ssh)

### Local models
- Ollama → http://127.0.0.1:11434 (default model: llama3.1:8b)

### Voice
- Preferred TTS voice: "af_heart" (Kokoro)
- Default speaker: office

### Projects
- website → ~/code/my-site (deploys from `main`)
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
