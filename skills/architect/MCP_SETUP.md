# 🔌 MCP Setup for Architect Agent

This document contains installation commands and configuration for the MCPs used by the Architect agent.

## Required Environment Variables

Add these to your `.env` file:

```env
# Figma API Access
FIGMA_ACCESS_TOKEN=your_figma_token_here

# Vercel Deployment
VERCEL_TOKEN=your_vercel_token_here

# Cloudflare Deployment
CLOUDFLARE_API_TOKEN=your_cloudflare_token_here
CLOUDFLARE_ACCOUNT_ID=your_account_id_here
```

---

## MCP Installation Commands

### 1. Figma MCP (Official)
Design tokens extraction, component specs, style guides.

```bash
# Install globally (recommended for MCPs)
npm install -g @anthropic/mcp-figma

# Or run directly with npx (configured in agent.yaml)
npx @anthropic/mcp-figma
```

**Get Figma Token:**
1. Go to https://www.figma.com/developers/api#access-tokens
2. Generate a new personal access token
3. Add to `.env` as `FIGMA_ACCESS_TOKEN`

**Usage:**
```
# Get file styles/colors
figma: get_file_styles(fileKey="ABC123")

# Get specific component
figma: get_component(fileKey="ABC123", nodeId="1:23")

# Get component set (variants)
figma: get_component_set(fileKey="ABC123", nodeId="1:45")
```

---

### 2. Playwright MCP
Browser automation, visual testing, E2E testing.

```bash
# Install
npm install -g @anthropic/mcp-playwright

# Install Playwright browsers
npx playwright install chromium firefox webkit
```

**Usage:**
```
# Navigate and screenshot
playwright: navigate(url="http://localhost:3000")
playwright: screenshot(path="./screenshot.png", fullPage=true)

# Interactive testing
playwright: click(selector="button.submit")
playwright: fill(selector="input#email", value="test@example.com")

# Visual comparison
playwright: compare(baseline="./baseline.png", current="./current.png")
```

---

### 3. Vercel MCP
Deploy previews, production deployments, project management.

```bash
# Install
npm install -g @anthropic/mcp-vercel

# Or use npx
npx @anthropic/mcp-vercel
```

**Get Vercel Token:**
1. Go to https://vercel.com/account/tokens
2. Create a new token with appropriate scope
3. Add to `.env` as `VERCEL_TOKEN`

**Usage:**
```
# Deploy preview
vercel: deploy(projectPath="./", preview=true)

# Deploy to production
vercel: deploy(projectPath="./", production=true)

# List deployments
vercel: list_deployments(projectId="prj_xxx")

# Get deployment status
vercel: get_deployment(deploymentId="dpl_xxx")
```

---

### 4. Cloudflare MCP
Edge deployment, Workers, Pages, R2 storage.

```bash
# Install
npm install -g @anthropic/mcp-cloudflare
```

**Get Cloudflare Credentials:**
1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Create a token with:
   - Zone:DNS:Edit
   - Zone:Zone:Read  
   - Account:Cloudflare Pages:Edit
   - Account:Workers Scripts:Edit
3. Get your Account ID from the dashboard
4. Add to `.env`:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`

**Usage:**
```
# Deploy to Cloudflare Pages
cloudflare: pages_deploy(
  projectName="my-website",
  directory="./dist",
  branch="main"
)

# Create/update Worker
cloudflare: worker_deploy(
  scriptName="my-api",
  scriptPath="./worker.js"
)

# Purge cache
cloudflare: purge_cache(zoneId="xxx", purgeEverything=true)
```

---

### 5. Excalidraw MCP
Wireframing, diagramming, architecture sketches.

```bash
# Already included in InfiniBot - no installation needed
# Located at: ${INFINIBOT_DIR}/dist/mcp/excalidraw-server.js
```

**Usage:**
```
# Create new diagram
excalidraw: create_diagram(name="component-architecture")

# Add shapes
excalidraw: add_rectangle(x=100, y=100, width=200, height=100, text="Header")
excalidraw: add_arrow(startX=200, startY=200, endX=200, endY=300)

# Export
excalidraw: export_png(diagramId="xxx", path="./architecture.png")
```

---

### 6. Filesystem MCP
Project file management with write access.

```bash
# Install
npm install -g @anthropic/mcp-filesystem

# Run with write permissions
npx @anthropic/mcp-filesystem --allow-write ./
```

**Usage:**
```
# Read file
filesystem: read_file(path="./src/App.tsx")

# Write file
filesystem: write_file(path="./src/NewComponent.tsx", content="...")

# List directory
filesystem: list_directory(path="./src/components")

# Create directory
filesystem: create_directory(path="./src/components/ui")
```

---

## Quick Install Script (Windows)

```powershell
# Run this to install all MCPs at once
@"
Installing Architect MCPs...
"@

npm install -g @anthropic/mcp-figma
npm install -g @anthropic/mcp-playwright
npm install -g @anthropic/mcp-vercel
npm install -g @anthropic/mcp-cloudflare
npm install -g @anthropic/mcp-filesystem

# Install Playwright browsers
npx playwright install chromium firefox webkit

Write-Host "✅ All MCPs installed!" -ForegroundColor Green
Write-Host ""
Write-Host "Don't forget to set environment variables:" -ForegroundColor Yellow
Write-Host "  FIGMA_ACCESS_TOKEN"
Write-Host "  VERCEL_TOKEN"
Write-Host "  CLOUDFLARE_API_TOKEN"
Write-Host "  CLOUDFLARE_ACCOUNT_ID"
```

Save as `install-architect-mcps.ps1` and run with:
```powershell
.\install-architect-mcps.ps1
```

---

## Quick Install Script (macOS/Linux)

```bash
#!/bin/bash
echo "Installing Architect MCPs..."

npm install -g @anthropic/mcp-figma
npm install -g @anthropic/mcp-playwright
npm install -g @anthropic/mcp-vercel
npm install -g @anthropic/mcp-cloudflare
npm install -g @anthropic/mcp-filesystem

# Install Playwright browsers
npx playwright install chromium firefox webkit

echo "✅ All MCPs installed!"
echo ""
echo "Don't forget to set environment variables:"
echo "  export FIGMA_ACCESS_TOKEN=your_token"
echo "  export VERCEL_TOKEN=your_token"
echo "  export CLOUDFLARE_API_TOKEN=your_token"
echo "  export CLOUDFLARE_ACCOUNT_ID=your_id"
```

Save as `install-architect-mcps.sh` and run with:
```bash
chmod +x install-architect-mcps.sh
./install-architect-mcps.sh
```

---

## Verification

After installation, verify MCPs are working:

```bash
# Check Figma connection
npx @anthropic/mcp-figma --help

# Check Playwright
npx playwright --version

# Check Vercel
npx @anthropic/mcp-vercel --help

# Check Cloudflare  
npx @anthropic/mcp-cloudflare --help
```

---

## Troubleshooting

### "FIGMA_ACCESS_TOKEN not set"
Ensure the token is in your `.env` file and the gateway has been restarted.

### "Playwright browsers not installed"
Run: `npx playwright install`

### "Permission denied" on filesystem operations
Ensure the MCP is started with `--allow-write` flag.

### "Vercel deployment failed"
Check that your project has a `vercel.json` or is a supported framework (Next.js, etc.)

---

## Related Documentation

- [Figma MCP Docs](https://github.com/anthropics/mcp-figma)
- [Playwright MCP Docs](https://github.com/anthropics/mcp-playwright)
- [Vercel MCP Docs](https://github.com/anthropics/mcp-vercel)
- [Cloudflare MCP Docs](https://github.com/anthropics/mcp-cloudflare)
- [MCP Protocol Spec](https://modelcontextprotocol.io/)
