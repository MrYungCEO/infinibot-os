import type { LearnTrack } from "../types.js";

/**
 * Security basics: gateway auth (token / password, Setup › Config), device
 * pairing and exec approvals (/nodes), users & roles (/users), plugin
 * permissions incl. gated ones (/plugins), and where keys live (/apikeys,
 * MCP Quick Install's gateway key).
 *
 * Explain-only for anything that changes security: no approve / reject /
 * rotate / revoke, no permission or policy change, no user is created (the
 * New User dialog is opened and cancelled).
 */
export const track: LearnTrack = {
  id: "security",
  title: "Security basics",
  summary:
    "Who can reach your gateway, which devices and people are allowed in, and the guardrails on risky actions.",
  overview: [
    "Your gateway runs your agents, holds your keys and can act on your behalf. These are the controls that decide who gets in and what may happen without you.",
    "",
    "This track covers:",
    "- **Gateway access.** Every connection must present the gateway's **token** or **password** (`gateway.auth`). Keep the gateway on loopback or your tailnet rather than the open internet.",
    "- **Devices.** Browsers, phones and nodes pair with the gateway. You approve pending requests, and each paired device gets role tokens you can rotate or revoke.",
    "- **Users and roles.** Until the first user exists, every connection is admin. After that, only `admin` users can manage accounts, and each user can be limited to certain folders and pages.",
    "- **Guardrails.** Exec approvals decide whether agents may run shell commands on a host. Plugin permissions, including **gated** ones that stay off by default, decide what each plugin may do.",
    "- **Keys.** Provider API keys live on the API Keys page and are shown masked.",
    "",
    "The tours only point at these controls. They never change a security setting for you.",
  ].join("\n"),
  category: "Foundations",
  level: "intermediate",
  certRequired: true,
  order: 98,
  estMinutes: 15,
  routes: ["/users", "/nodes", "/apikeys", "/config"],
  signals: ["users", "nodes", "apikeys", "config"],
  badge: { id: "security", label: "Gatekeeper", icon: "🛡️" },
  walkthroughs: [
    {
      id: "gateway-access",
      title: "Who can reach your gateway",
      summary:
        "Gateway auth (token or password), where it's configured, and the key external agents use.",
      estMinutes: 3,
      steps: [
        {
          id: "auth",
          title: "Every connection needs a secret",
          body: "The gateway accepts a connection only when it presents the **token** or **password** set in `gateway.auth`. This browser sent it when you signed in.",
          route: "/config",
          target: "main.content",
          placement: "center",
        },
        {
          id: "search",
          title: "Find the auth settings",
          body: "Type **auth** to filter the settings.",
          target: ".config-search__input",
          action: { kind: "input", match: "auth", sample: "auth" },
          skipIf: { kind: "viewport", maxWidth: 800 },
        },
        {
          id: "results",
          title: "Token or password",
          body: "`gateway.auth.mode` is `token` or `password`. On Tailscale Serve, `allowTailscale` can accept your tailnet identity instead. Changing these disconnects every client, so plan it.",
          target: [".config-content", ".config-main", "main.content"],
          practice: {
            mode: "explain",
            note: "This tour doesn't edit or save your config.",
          },
        },
        {
          id: "clear",
          title: "Clear the filter",
          body: "Click **×** to clear the search.",
          target: ".config-search__clear",
          action: { kind: "click" },
          skipIf: { kind: "viewport", maxWidth: 800 },
        },
        {
          id: "gateway-key",
          title: "The key external agents use",
          body: "Claude Code and other MCP clients connect with the same gateway key. **MCP › MCPs › Quick Install** can reveal it, and **Rotate key** replaces it, which restarts the gateway and disconnects every client until it's re-added.",
          route: "/mcp",
          target: ["learn:mcp-tab-mcps", "learn:mcp-tabs"],
          practice: {
            mode: "explain",
            note: "Nothing is revealed or rotated in this tour.",
          },
        },
      ],
    },
    {
      id: "devices",
      title: "Devices and pairing",
      summary: "Approve new devices, and rotate or revoke the tokens of paired ones.",
      estMinutes: 3,
      steps: [
        {
          id: "devices-card",
          title: "Devices",
          body: "Browsers, phones and nodes pair with the gateway. New requests wait under **Pending** until you approve or reject them. Approved devices move to **Paired**.",
          route: "/nodes",
          target: "learn:nodes-devices",
          placement: "top",
          waitMs: 12000,
        },
        {
          id: "approve",
          title: "Approve only what you recognise",
          body: "Check the device name, IP address and the role it asks for before you click **Approve**. If you didn't start the pairing, click **Reject**.",
          target: "learn:nodes-devices",
          practice: {
            mode: "explain",
            note: "This tour never approves or rejects a pairing request.",
          },
        },
        {
          id: "tokens",
          title: "Role tokens",
          body: "Each paired device holds a token per role. **Rotate** issues a new one. **Revoke** cuts that device off at once, which is what you want for a lost phone.",
          target: "learn:nodes-devices",
          practice: {
            mode: "explain",
            note: "Rotating or revoking a token disconnects that device, so it's never done from a tour.",
          },
        },
        {
          id: "nodes",
          title: "Nodes",
          body: "Nodes are paired machines that can run commands for your agents. Each one shows here with its live links.",
          target: "learn:nodes-list",
          placement: "top",
        },
      ],
    },
    {
      id: "users-roles",
      title: "Users and roles",
      summary: "Accounts, admin vs user, and how to fence a user into their own folders and pages.",
      estMinutes: 4,
      steps: [
        {
          id: "users",
          title: "The Users page",
          body: "Until the first account exists, every connection is treated as the **implicit admin**. Once you create a user, only accounts with the **admin** role can manage users.",
          route: "/users",
          target: "learn:users-header",
          placement: "bottom",
          waitMs: 12000,
        },
        {
          id: "new",
          title: "Look at the New User form",
          body: "Click **New User**. You'll look at the form and cancel. Nothing is created.",
          target: "learn:users-new",
          action: { kind: "click" },
        },
        {
          id: "role",
          title: "Role",
          body: "**admin** can create, edit and delete users. **user** can change only their own profile. The **Gateway password** field is how InfiniBot tells which account a connection belongs to.",
          target: ["learn:users-role", "learn:users-dialog"],
        },
        {
          id: "lock",
          title: "Fence in the agent",
          body: "**Lock agent to home + allowed directories** keeps this user's agents inside their home folder and the folders you list.",
          target: ["learn:users-lock-dirs", "learn:users-dialog"],
        },
        {
          id: "pages",
          title: "Limit the pages",
          body: "**Allowed pages** lists the only pages this user may open, for example `chat, projects`. Leave it empty to allow all.",
          target: ["learn:users-allowed-pages", "learn:users-dialog"],
        },
        {
          id: "cancel",
          title: "Cancel",
          body: "Click **Cancel** to close the form without creating anyone.",
          target: "learn:users-dialog-cancel",
          action: { kind: "click" },
        },
      ],
    },
    {
      id: "guardrails",
      title: "Guardrails on risky actions",
      summary: "Exec approvals for shell commands, and gated plugin permissions.",
      estMinutes: 3,
      steps: [
        {
          id: "exec",
          title: "Exec approvals",
          body: "Decides whether agents may run shell commands on the gateway or on a node. A command runs only when the policy, the allowlist and, if needed, your approval all agree.",
          route: "/nodes",
          target: "learn:nodes-exec-approvals",
          placement: "bottom",
          waitMs: 12000,
        },
        {
          id: "policy",
          title: "Security and Ask",
          body: "**Security**: Deny blocks everything, Allowlist runs only listed binaries, Full allows anything. **Ask**: Off, On miss (prompt when the allowlist doesn't match) or Always. If nobody can answer the prompt, **Ask fallback** decides.",
          target: ["learn:nodes-exec-policy", "learn:nodes-exec-approvals"],
          practice: {
            mode: "explain",
            note: "This tour doesn't change or save the approval policy.",
          },
        },
        {
          id: "prompt",
          title: "Allow once, always, or deny",
          body: "When a command needs approval, InfiniBot shows a prompt with **Allow once**, **Always allow** and **Deny**. Always allow adds the command to the allowlist.",
          target: "main.content",
          placement: "center",
        },
        {
          id: "gated",
          title: "Gated plugin permissions",
          body: "Plugins declare what they need. Risky abilities, like Infinitrade's `gated:orders`, are **Off by default** until you grant them on the plugin's Permissions section.",
          route: "/plugins?plugin=infinitrade&ptab=permissions",
          target: [
            '[data-permission="gated:orders"]',
            "learn:plugin-detail-permissions",
            "learn:plugin-section-permissions",
          ],
          waitMs: 12000,
          practice: {
            mode: "explain",
            note: "This tour never grants or revokes a permission.",
          },
        },
      ],
    },
    {
      id: "keys",
      title: "Where your keys live",
      summary: "Provider API keys, masked on the API Keys page.",
      estMinutes: 2,
      steps: [
        {
          id: "api-keys",
          title: "API Keys",
          body: "Keys for model providers live here, one entry per provider. Keys are shown masked, so the page is safe to open on a shared screen.",
          route: "/apikeys",
          target: [".api-keys-header", "main.content"],
          placement: "bottom",
        },
        {
          id: "search",
          title: "Find a key",
          body: "Type **openai** to filter the providers.",
          target: ".api-keys-search__input",
          action: { kind: "input", match: "openai", sample: "openai" },
        },
        {
          id: "habits",
          title: "Good habits",
          body: "Give each key the smallest scope and spending limit the provider allows. If one leaks, revoke it at the provider first, then replace it here.",
          target: [".api-keys-header", "main.content"],
          practice: {
            mode: "explain",
            note: "This tour doesn't add, reveal or delete a key.",
          },
        },
      ],
    },
  ],
  quiz: [
    {
      id: "implicit-admin",
      prompt: "No users have been created yet. Who is admin?",
      options: [
        "Nobody until you restart",
        "Every connection that passes gateway auth (the implicit admin)",
        "Only the first phone that pairs",
        "Only connections from Telegram",
      ],
      answer: 1,
      explain:
        "The implicit-admin rule closes as soon as the first user exists. From then on only admin users manage accounts.",
    },
    {
      id: "lost-phone",
      prompt: "You lost a paired phone. What's the right move?",
      options: [
        "Nothing, it can't connect without you",
        "Revoke its token on the Devices card",
        "Uninstall every plugin",
        "Turn off exec approvals",
      ],
      answer: 1,
      explain: "Revoking the device's role token cuts it off immediately.",
    },
    {
      id: "on-miss",
      prompt: "Exec approvals Ask mode is “On miss”. When are you prompted?",
      options: [
        "Never",
        "For every command",
        "Only when the command doesn't match the allowlist",
        "Only for commands from plugins",
      ],
      answer: 2,
      explain:
        "On miss prompts only when the allowlist has no match. Always prompts for every command.",
    },
    {
      id: "gated-default",
      prompt: "What is the default state of a gated plugin permission such as gated:orders?",
      options: ["Granted", "Off until you grant it", "Granted for admins only", "Random"],
      answer: 1,
      explain: "Gated permissions are never granted automatically.",
    },
    {
      id: "gateway-auth",
      prompt: "Which two modes can gateway.auth use?",
      options: [
        "token or password",
        "OAuth or SAML",
        "PIN or fingerprint",
        "None: the gateway is always open",
      ],
      answer: 0,
      explain: "gateway.auth.mode is token or password. Every client presents it when it connects.",
    },
  ],
};
