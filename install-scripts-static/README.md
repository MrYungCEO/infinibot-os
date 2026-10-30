# InfiniBot install scripts (static copy)

`install.sh` and `install.ps1` here are generated copies of `scripts/install-infinibot.sh` and `scripts/install-infinibot.ps1`. Do not edit them: change the source and run

```bash
pnpm install-scripts:sync     # refresh the copies here and in docs/
pnpm install-scripts:check    # fail if a copy drifted (part of pnpm release:check)
```

## Where the scripts are actually served

The public one-liners point at the landing site, not at this folder:

```bash
curl -fsSL https://infinibotos.com/install.sh | bash          # macOS / Linux / WSL
```

```powershell
iwr -useb https://infinibotos.com/install.ps1 | iex            # Windows PowerShell
```

`infinibotos.com` is the Netlify site `infinibot-landing`, published from `docs/`, so those URLs serve `docs/install.sh` and `docs/install.ps1`. Deploy steps are in `docs/install/installer.md`.

## Using this folder

This folder is a self-contained static site (scripts, a small index page and `vercel.json` headers) for hosting the installers on a separate origin, for example a mirror or an `install.` subdomain:

```bash
cd install-scripts-static
npx vercel --prod                 # or: npx netlify deploy --prod --dir .
```

| File | Description |
|------|-------------|
| `install.sh` | Bash installer (macOS / Linux / WSL) |
| `install.ps1` | PowerShell installer (Windows) |
| `index.html` | Page listing the install commands |
| `vercel.json` | Headers (plain text, CORS, cache) |
