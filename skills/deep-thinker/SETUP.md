# 🧠 Deep Thinker Agent — Setup Guide

This document contains MCP installation commands and configuration for the OPUS Deep Thinker agent.

---

## Prerequisites

- **uv** (Python package manager) - `pip install uv` or `winget install astral-sh.uv`
- **Node.js/npm** - for npx-based MCPs
- **API Keys** - for various services (see below)

---

## 🔧 MCP Installation Commands

### 1. Exa MCP — Semantic Web Search

Exa provides neural/semantic search that understands intent, not just keywords.

**Get API Key:** https://exa.ai

**Option A: Remote (no install needed)**
```json
{
  "exa": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "https://mcp.exa.ai/mcp"]
  }
}
```

**Option B: Local with API key**
```json
{
  "exa": {
    "command": "npx",
    "args": ["-y", "exa-mcp-server"],
    "env": {
      "EXA_API_KEY": "your-exa-api-key"
    }
  }
}
```

**Install globally (optional):**
```bash
npm install -g exa-mcp-server
```

---

### 2. Perplexity MCP — AI-Powered Research

Perplexity Sonar provides real-time web research with AI synthesis.

**Get API Key:** https://www.perplexity.ai/settings/api

**Option A: Official Server (recommended)**
```bash
# One-time setup (adds to Claude config)
claude mcp add perplexity --env PERPLEXITY_API_KEY="your-key" -- npx -y @perplexity-ai/mcp-server
```

**Option B: Manual config**
```json
{
  "perplexity": {
    "command": "npx",
    "args": ["-y", "@perplexity-ai/mcp-server"],
    "env": {
      "PERPLEXITY_API_KEY": "your-perplexity-api-key"
    }
  }
}
```

**Option C: Python version (uvx)**
```json
{
  "perplexity": {
    "command": "uvx",
    "args": ["perplexity-mcp"],
    "env": {
      "PERPLEXITY_API_KEY": "your-key",
      "PERPLEXITY_MODEL": "sonar"
    }
  }
}
```

---

### 3. arXiv MCP — Academic Paper Search

Search and analyze arXiv papers directly.

**Install:**
```bash
uv tool install arxiv-mcp-server
```

**Config:**
```json
{
  "arxiv": {
    "command": "uv",
    "args": [
      "tool", "run", "arxiv-mcp-server",
      "--storage-path", "${HOME}/.infinibot/arxiv-papers"
    ]
  }
}
```

**Alternative (via Smithery):**
```bash
npx -y @smithery/cli install arxiv-mcp-server --client claude
```

**Tools provided:**
- `search_papers` — Query with filters (date, category)
- `download_paper` — Download by arXiv ID
- `list_papers` — View downloaded papers
- `read_paper` — Access paper content

---

### 4. Obsidian MCP — Note Vault Integration

Connect to your Obsidian vault for knowledge management.

**Install:**
```bash
npm install -g obsidian-mcp
```

**Config:**
```json
{
  "obsidian": {
    "command": "npx",
    "args": ["-y", "obsidian-mcp"],
    "env": {
      "OBSIDIAN_VAULT_PATH": "C:\\path\\to\\your\\vault"
    }
  }
}
```

**Alternative: obsidian-mcp-server**
```json
{
  "obsidian": {
    "command": "npx",
    "args": ["-y", "obsidian-mcp-server", "--vault", "C:\\path\\to\\vault"]
  }
}
```

---

### 5. Chroma MCP — Vector Database for RAG

Semantic document storage and retrieval.

**Install:**
```bash
uv tool install chroma-mcp
```

**Config (Persistent storage):**
```json
{
  "chroma": {
    "command": "uvx",
    "args": [
      "chroma-mcp",
      "--client-type", "persistent",
      "--data-dir", "${HOME}/.infinibot/chroma-data"
    ]
  }
}
```

**Config (HTTP server):**
```json
{
  "chroma": {
    "command": "uvx",
    "args": [
      "chroma-mcp",
      "--client-type", "http",
      "--host", "http://localhost:8000",
      "--port", "8000"
    ]
  }
}
```

**Start Chroma server (if using HTTP mode):**
```bash
chroma run --host localhost --port 8000 --path ./chroma_data
```

---

## 📄 Complete MCP Configuration

Add to your Claude MCP configuration:

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["<workspace>/mcp_excalidraw/dist/index.js"],
      "env": {
        "EXPRESS_SERVER_URL": "http://localhost:3000",
        "ENABLE_CANVAS_SYNC": "true"
      }
    },
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp"
    },
    "infranodus": {
      "type": "http",
      "url": "https://mcp.infranodus.com/"
    },
    "exa": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.exa.ai/mcp"]
    },
    "perplexity": {
      "command": "npx",
      "args": ["-y", "@perplexity-ai/mcp-server"],
      "env": {
        "PERPLEXITY_API_KEY": "${PERPLEXITY_API_KEY}"
      }
    },
    "arxiv": {
      "command": "uv",
      "args": [
        "tool", "run", "arxiv-mcp-server",
        "--storage-path", "${HOME}/.infinibot/arxiv-papers"
      ]
    },
    "chroma": {
      "command": "uvx",
      "args": [
        "chroma-mcp",
        "--client-type", "persistent",
        "--data-dir", "${HOME}/.infinibot/chroma-data"
      ]
    }
  }
}
```

---

## 🔑 Required API Keys

| Service | Where to Get | Env Variable |
|---------|--------------|--------------|
| Exa | https://exa.ai | `EXA_API_KEY` |
| Perplexity | https://perplexity.ai/settings/api | `PERPLEXITY_API_KEY` |

**Set in environment:**
```powershell
# PowerShell
$env:PERPLEXITY_API_KEY = "pplx-xxxx"
$env:EXA_API_KEY = "exa-xxxx"

# Or add to system environment variables permanently
[Environment]::SetEnvironmentVariable("PERPLEXITY_API_KEY", "pplx-xxxx", "User")
[Environment]::SetEnvironmentVariable("EXA_API_KEY", "exa-xxxx", "User")
```

---

## 🚀 Quick Install Script

```powershell
# Install all MCPs
Write-Host "Installing Deep Thinker MCPs..." -ForegroundColor Cyan

# arXiv (Python)
uv tool install arxiv-mcp-server

# Chroma (Python)
uv tool install chroma-mcp

# Create storage directories
New-Item -ItemType Directory -Force -Path "$HOME\.infinibot\arxiv-papers"
New-Item -ItemType Directory -Force -Path "$HOME\.infinibot\chroma-data"

Write-Host "Done! Add the MCP configs to ~/.claude/mcp.json" -ForegroundColor Green
```

---

## 📊 Usage Patterns

### Research Workflow
```
1. Exa → Semantic search for concepts/ideas
2. Perplexity → AI-synthesized research summaries  
3. arXiv → Deep dive into academic papers
4. Chroma → Store and retrieve research for RAG
5. research/notes tools → Document findings
```

### Architecture Decision
```
1. Web search → Gather options
2. Perplexity → Compare approaches
3. arXiv → Check academic best practices
4. notes → Create ADR document
5. Chroma → Store for future reference
```

---

## 🧪 Testing MCPs

After configuration, test each MCP:

```bash
# Test Exa
claude "Use exa to search for 'transformer architecture innovations 2025'"

# Test Perplexity
claude "Use perplexity to research current best practices for API rate limiting"

# Test arXiv
claude "Search arxiv for papers on 'attention mechanisms' from 2024"

# Test Chroma
claude "Create a chroma collection called 'research' and add a test document"
```

---

## Notes

- **Brave Search** is already available via the `web_search` tool in InfiniBot
- **Obsidian** only needed if you use Obsidian as your note vault
- **Chroma** requires Python and can be memory-intensive
- All MCPs are optional — install based on your research needs
