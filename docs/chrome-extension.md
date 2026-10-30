# InfiniBot Browser Relay for Chrome

The InfiniBot Browser Relay gives agents visible control of tabs in an existing, logged-in Chrome profile. It does not export cookies, passwords, or storage to an agent. Chrome itself performs actions in the profile where the extension is installed, so existing sessions continue to work.

## Architecture

The implementation extends InfiniBot's existing browser stack instead of adding a second automation system:

```text
gateway agent or CLI coder (MCP)
  → `browser` tool
  → shared Playwright action/ref layer
  → authenticated local CDP relay (loopback only)
  → MV3 extension using chrome.debugger
  → explicitly granted or agent-created tabs in the user's Chrome profile
```

Design choices:

- `profile: "chrome"` is the explicit route to the user's Chrome. It never launches a new managed or headless profile.
- The local relay accepts Chrome-extension origins on loopback and requires a durable token obtained with a one-time pairing code.
- Multiple Chrome profiles may pair. Relay target and session IDs are scoped by profile so IDs cannot collide.
- Existing user tabs are off-limits by default. Use the extension popup's **Grant current tab** button to share one. Tabs agents create are grouped and labelled for the run.
- Server-side tab locks stop two agent runs from controlling the same target.
- Snapshots are wrapped as untrusted page content. Page text is data, never agent instructions.

## Build and install

From the InfiniBot repository:

```bash
pnpm ext:build
```

Outputs:

- Unpacked extension: `dist/chrome-extension/unpacked/`
- Installable archive: `dist/chrome-extension/infinibot-browser-relay.zip`

To install unpacked:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `dist/chrome-extension/unpacked/` (or the stable directory printed by `infinibot browser extension path`).
5. Pin **InfiniBot Browser Relay**.

Chrome does not load an extension directly from a ZIP. The ZIP is for download/transport; extract it first or use the unpacked directory.

## Pair with InfiniBot

1. Open InfiniBot → **Browser**.
2. Under **Your real Chrome · secure relay**, click **Create pairing code**.
3. Open the extension popup → **Pairing & settings**.
4. Name this Chrome profile, enter the one-time code, and click **Pair**.
5. The Browser page will show the profile as connected.

Pairing codes expire after 10 minutes and can be used once. The resulting token is stored in `chrome.storage.local`; InfiniBot stores only its SHA-256 hash.

## Permissions and safety

The Browser page provides:

- **Allow / Ask / Block rules** for exact hosts or wildcards such as `*.example.com`. First match wins; unlisted sites default to Ask.
- A gateway **Pause all control** kill switch.
- Connected-profile revocation.
- Active agent tab locks/groups.
- A durable audit log containing the run ID, action, URL, result, and timestamp.

The extension popup has a second local kill switch. Pausing there detaches every controlled tab and disconnects the relay.

InfiniBot creates an operator approval for:

- purchases, checkout, payments, or transfers;
- entering passwords, passcodes, OTPs, or 2FA codes;
- sending email, messages, comments, or posts;
- deleting data or changing account/security settings;
- arbitrary JavaScript evaluation;
- any site whose policy is **Ask**.

An approval is bound to the exact action payload. After approval, retry that action with the returned `approvalId`; it cannot be reused for a different browser action.

## Browser tool reference

The same `browser` tool is registered for gateway sessions and exported by InfiniBot MCP to `claude_coder`, `codex_coder`, and `opencode_coder` runs.

Common calls:

```json
{"action":"open","profile":"chrome","url":"https://example.com"}
{"action":"snapshot","profile":"chrome"}
{"action":"click","profile":"chrome","ref":"e12"}
{"action":"type","profile":"chrome","ref":"e7","text":"hello"}
{"action":"press","profile":"chrome","key":"Enter"}
{"action":"scroll","profile":"chrome","direction":"down"}
{"action":"screenshot","profile":"chrome","fullPage":true}
{"action":"tabs","profile":"chrome"}
{"action":"tab","profile":"chrome","index":2}
{"action":"back","profile":"chrome"}
{"action":"forward","profile":"chrome"}
{"action":"reload","profile":"chrome"}
```

Snapshots return accessibility/text content with stable element refs. Every result includes a fresh snapshot; use refs from the latest result. Screenshots are saved as media artifacts and displayed in InfiniBot.

### Gateway agent

Ask an InfiniBot agent to use its `browser` tool with `profile: "chrome"`. The tool call passes through the normal policy, approval, audit, and tab-lock layers.

### CLI coder through MCP

Coder processes receive the same tool from the InfiniBot MCP registry as `mcp__infinibot__browser` (the client prefix varies). For a raw MCP client, list tools and invoke `browser` with the JSON arguments above.

### CLI command

The existing CLI remains useful for inspection:

```bash
infinibot browser --browser-profile chrome tabs
infinibot browser --browser-profile chrome snapshot
```

## Owner activation guide (live gateway)

This branch can be built and reviewed without affecting the live gateway. Activating the new pairing RPCs and policy layer requires deploying the commit and reloading gateway code. Because a gateway/watchdog restart terminates active coder runs, this work intentionally does not restart either service.

When no coder runs are active:

1. Merge `feat/chrome-extension` into the live deploy branch through the normal release process.
2. Build outside the live serving directory, then stage the verified bundles into the deploy folder.
3. Restart the gateway once through the watchdog.
4. Run `pnpm ext:build`, load/reload the unpacked extension in Chrome, and pair it from InfiniBot → Browser.

Reloading only the Chrome extension is non-disruptive. Loading new gateway TypeScript/RPC handlers is the one step that requires a gateway activation restart.

## Troubleshooting

- **PAIR badge / Pairing required:** create a fresh code on the Browser page and pair again.
- **Reconnecting:** confirm the gateway is running and the relay port in extension settings matches the Browser page (default `18792`).
- **No tab available:** grant the current tab from the extension popup, or let the agent open a new tab.
- **Action needs approval:** approve it in Telegram or the InfiniBot approvals inbox, wait for the decision, then retry with `approvalId`.
- **Blocked by site policy:** change the matching rule on the Browser page. More-specific rules should appear before broad wildcards.
- **Chrome shows the debugger infobar:** expected; it is Chrome's visible indicator that `chrome.debugger` controls the tab.
