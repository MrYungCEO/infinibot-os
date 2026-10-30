# 💻 CODER Agent — Setup & Installation

This document covers the installation and configuration of MCPs for the CODER agent.

---

## 🚀 Quick Install

All MCPs use `npx -y` which auto-installs on first run. No manual installation required!

However, if you want to pre-install for faster startup:

```bash
# Install all MCPs globally
npm install -g @anthropic/mcp-github
npm install -g @anthropic/mcp-run-python
npm install -g @anthropic/mcp-postgres
npm install -g @anthropic/mcp-sqlite
npm install -g @anthropic/mcp-redis
npm install -g @anthropic/mcp-docker
npm install -g @anthropic/mcp-filesystem
npm install -g @anthropic/mcp-git
```

---

## 🔧 MCP Configuration

### 1. GitHub MCP

**Purpose:** Version control, PRs, issues, GitHub Actions

**Environment Variables:**
```bash
GITHUB_TOKEN=ghp_your_personal_access_token
```

**Required Scopes:**
- `repo` — Full repository access
- `workflow` — GitHub Actions
- `read:org` — Organization membership (optional)

**Get Token:** https://github.com/settings/tokens

**Available Tools:**
- `github_create_issue` — Create new issues
- `github_create_pull_request` — Open PRs
- `github_list_pull_requests` — List PRs
- `github_get_pull_request` — Get PR details
- `github_merge_pull_request` — Merge PRs
- `github_list_issues` — List issues
- `github_get_issue` — Get issue details
- `github_add_comment` — Comment on issues/PRs
- `github_list_commits` — List commits
- `github_search_code` — Search code
- `github_list_workflows` — List Actions workflows
- `github_trigger_workflow` — Trigger workflow

---

### 2. Python Sandbox (mcp-run-python)

**Purpose:** Execute Python code in a secure Pyodide sandbox

**No Configuration Required** — Runs in-browser sandbox

**Available Tools:**
- `run_python` — Execute Python code safely

**Supported Packages:**
- numpy, pandas, scipy
- matplotlib, seaborn
- requests, beautifulsoup4
- And many more (check Pyodide docs)

**Example:**
```python
import pandas as pd
df = pd.DataFrame({'a': [1, 2, 3], 'b': [4, 5, 6]})
df.describe()
```

---

### 3. PostgreSQL MCP

**Purpose:** Database queries, schema management

**Environment Variables:**
```bash
DATABASE_URL=postgresql://user:password@localhost:5432/dbname
```

**Available Tools:**
- `query` — Execute SQL queries
- `list_tables` — List all tables
- `describe_table` — Get table schema
- `list_databases` — List databases

**Security Notes:**
- Read-only by default
- Use with caution in production
- Consider using a read replica

---

### 4. SQLite MCP

**Purpose:** Lightweight local database operations

**Environment Variables:**
```bash
SQLITE_DB_PATH=./data.db  # Path to SQLite file
```

**Available Tools:**
- `query` — Execute SQL
- `list_tables` — List tables
- `describe_table` — Table schema
- `create_table` — Create new table
- `insert` — Insert data

---

### 5. Redis MCP

**Purpose:** Caching, key-value operations, pub/sub

**Environment Variables:**
```bash
REDIS_URL=redis://localhost:6379
# Or with auth:
REDIS_URL=redis://:password@localhost:6379
```

**Available Tools:**
- `get` — Get value by key
- `set` — Set key-value
- `del` — Delete key
- `keys` — List keys by pattern
- `expire` — Set TTL
- `incr` / `decr` — Increment/decrement
- `hget` / `hset` — Hash operations
- `lpush` / `rpush` — List operations

---

### 6. Docker MCP

**Purpose:** Container management

**Environment Variables:**
```bash
DOCKER_HOST=unix:///var/run/docker.sock  # Linux/Mac
# Or for Windows:
DOCKER_HOST=npipe:////./pipe/docker_engine
# Or TCP:
DOCKER_HOST=tcp://localhost:2375
```

**Available Tools:**
- `list_containers` — List running containers
- `start_container` — Start container
- `stop_container` — Stop container
- `logs` — Get container logs
- `exec` — Execute command in container
- `build` — Build image from Dockerfile
- `pull` — Pull image from registry
- `list_images` — List local images

---

### 7. Filesystem MCP

**Purpose:** Advanced file operations

**Configuration:**
```yaml
filesystem:
  command: npx
  args: ["-y", "@anthropic/mcp-filesystem", "--allow-write", "./"]
```

**Available Tools:**
- `read_file` — Read file contents
- `write_file` — Write to file
- `list_directory` — List directory contents
- `create_directory` — Create directory
- `move_file` — Move/rename file
- `delete_file` — Delete file
- `search_files` — Search for files

---

### 8. Git MCP

**Purpose:** Direct git operations

**Configuration:**
```yaml
git:
  command: npx
  args: ["-y", "@anthropic/mcp-git", "--repository", "."]
```

**Available Tools:**
- `git_status` — Repository status
- `git_diff` — Show changes
- `git_log` — Commit history
- `git_branch` — List/create branches
- `git_checkout` — Switch branches
- `git_commit` — Create commit
- `git_push` — Push to remote
- `git_pull` — Pull from remote
- `git_stash` — Stash changes

---

## 📋 Environment Variables Template

Create a `.env` file with these variables:

```bash
# GitHub
GITHUB_TOKEN=ghp_xxxxxxxxxxxx

# PostgreSQL (optional)
DATABASE_URL=postgresql://user:pass@localhost:5432/db

# SQLite (optional)
SQLITE_DB_PATH=./data.db

# Redis (optional)
REDIS_URL=redis://localhost:6379

# Docker (optional - usually auto-detected)
DOCKER_HOST=unix:///var/run/docker.sock
```

---

## 🧪 Testing MCP Connections

### Test GitHub MCP
```bash
npx -y @anthropic/mcp-github
# Then call: github_list_repos
```

### Test Python Sandbox
```bash
npx -y @anthropic/mcp-run-python
# Then call: run_python with code "print('hello')"
```

### Test PostgreSQL
```bash
npx -y @anthropic/mcp-postgres "$DATABASE_URL"
# Then call: list_tables
```

### Test Redis
```bash
npx -y @anthropic/mcp-redis
# Then call: keys "*"
```

---

## 🔐 Security Considerations

1. **Token Scope**: Give GitHub token minimum required permissions
2. **Database Access**: Use read-only credentials when possible
3. **Redis**: Enable AUTH in production
4. **Docker**: Consider rootless Docker
5. **Filesystem**: Restrict `--allow-write` to project directories

---

## 🐛 Troubleshooting

### MCP Won't Start
```bash
# Clear npm cache
npm cache clean --force

# Reinstall
npm install -g @anthropic/mcp-<name>
```

### GitHub Token Issues
- Verify token has required scopes
- Check token expiration
- Try regenerating token

### Database Connection Failed
- Verify connection string format
- Check firewall/network access
- Ensure database is running

### Docker Permission Denied
```bash
# Linux: Add user to docker group
sudo usermod -aG docker $USER
# Then logout and login
```

---

## 📚 Additional Resources

- [MCP Specification](https://modelcontextprotocol.io/)
- [Anthropic MCP Servers](https://github.com/anthropics/mcp-servers)
- [GitHub CLI](https://cli.github.com/)
- [Docker Documentation](https://docs.docker.com/)
