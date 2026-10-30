import type { LearnTrack } from "../types.js";

/**
 * Plugins & marketplace: the Plugins page (Setup › Plugins,
 * ui/src/ui/views/plugins/**): browse, search and filter the store, read a
 * plugin's detail page (What it adds, Permissions, Settings, Appearance,
 * Health & Logs, Data, Versions) and what turning a plugin on gives you.
 *
 * Never toggles a plugin or a permission: turning a plugin on/off restarts
 * the gateway, and permission switches change what a plugin may do.
 */
export const track: LearnTrack = {
  id: "plugins-marketplace",
  title: "Plugins & marketplace",
  summary:
    "Browse the plugin store, read what a plugin adds and asks for, and see what turning one on gives you.",
  overview: [
    "Plugins add apps, channels and integrations to InfiniBot. They all run on your gateway, and you decide what each one may do.",
    "",
    "The **Plugins** page (Home › Plugins) is the store and the control panel in one:",
    "- **Free and paid.** Free plugins are included. A paid plugin shows its price and **Buy**: it's a one-time purchase that unlocks it on this page, and **Purchases** restores what you bought on another install.",
    "- **Browse.** Search by name, channel or tag. Filter by All, Installed, Enabled or Available, by category, and by trust tier (first-party, verified, community).",
    "- **Detail page.** Every plugin has sections for **What it adds** (its pages, tools, RPCs, MCP servers and Learn tracks, each switchable), **Permissions**, **Settings**, **Appearance**, **Health & Logs**, **Data** and **Versions**.",
    "- **Permissions.** Risky abilities are *gated*: they stay **Off by default** until you grant them. Permission changes apply at once, with no restart.",
    "- **Turning a plugin on** restarts the gateway to load its code. Once it's on, it gets its own sidebar section, its own Learn track and a **Take the tour** button.",
    "",
    "This track never switches a plugin or a permission for you. It shows you where the switches are and what they do.",
  ].join("\n"),
  category: "Plugins",
  level: "beginner",
  certRequired: true,
  order: 90,
  estMinutes: 11,
  routes: ["/plugins"],
  signals: ["plugins"],
  badge: { id: "plugins-marketplace", label: "Plugin Curator", icon: "🧩" },
  walkthroughs: [
    {
      id: "browse-plugins",
      title: "Browse the plugin store",
      summary: "Filter the store, search for a plugin and open its page.",
      estMinutes: 3,
      steps: [
        {
          id: "store",
          title: "The Plugins page",
          body: "This is where plugins live. The counters show how many are **installed**, how many are **on**, and how many more are **available** to add.",
          route: "/plugins",
          target: "learn:plugins-hero",
          placement: "bottom",
        },
        {
          id: "filters",
          title: "Filter what you see",
          body: "**All**, **Installed**, **Enabled** or **Available**. Click **Installed** to see what's already on this gateway.",
          target: "learn:plugins-filters",
          action: { kind: "click", target: '[data-filter="installed"]' },
        },
        {
          id: "categories",
          title: "Categories and trust",
          body: "Narrow the list to Apps, Channels, Integrations or Developer tools. The trust chips separate **first-party** plugins (made by InfiniBot) from verified and community publishers.",
          target: ["learn:plugins-categories", "learn:plugins-toolbar"],
        },
        {
          id: "search",
          title: "Search the store",
          body: "Search matches names, channels and tags. Type **infinitrade**.",
          target: "learn:plugins-search",
          action: { kind: "input", match: "infini", sample: "infinitrade" },
        },
        {
          id: "open",
          title: "Open a plugin",
          body: "Click the **Infinitrade** card to open its page. Opening a page changes nothing. It's the plugin's store listing and control panel.",
          target: ['[data-open-detail="infinitrade"]', "[data-open-detail]"],
          action: { kind: "click" },
        },
        {
          id: "detail",
          title: "The plugin's page",
          body: "Its name, publisher, version and status. The rest of this page is organised into sections, which the next walkthrough covers.",
          target: ["learn:plugin-detail-hero", "learn:plugin-detail-nav"],
          check: { kind: "element", target: "learn:plugin-detail-nav" },
          checkHint: "Waiting for the plugin page to open…",
          placement: "bottom",
        },
      ],
    },
    {
      id: "plugin-page",
      title: "Read a plugin's page",
      summary: "What it adds, the permissions it asks for, and how to check its health.",
      estMinutes: 4,
      prerequisites: ["browse-plugins"],
      steps: [
        {
          id: "sections",
          title: "One page, nine sections",
          body: "Overview, What it adds, Permissions, Settings, Appearance, Health & Logs, Data, Versions and Uninstall. Click a section to jump to it.",
          route: "/plugins?plugin=infinitrade",
          target: "learn:plugin-detail-nav",
          placement: "bottom",
          waitMs: 12000,
        },
        {
          id: "open-contributions",
          title: "What it adds",
          body: "Click **What it adds**.",
          target: "learn:plugin-tab-contributions",
          action: { kind: "click" },
        },
        {
          id: "contributions",
          title: "Switch pieces on or off",
          body: "Every page, tool, RPC, MCP server and Learn track the plugin brings is listed here. **Live** switches apply at once. **Saved** ones are stored and take effect later.",
          target: "learn:plugin-section-contributions",
          placement: "top",
        },
        {
          id: "open-permissions",
          title: "Permissions",
          body: "Click **Permissions**.",
          target: "learn:plugin-tab-permissions",
          action: { kind: "click" },
        },
        {
          id: "permissions",
          title: "What it may do",
          body: "Each permission shows its risk and whether it's granted. **Gated** permissions, like Infinitrade's `gated:orders` for placing orders, stay **Off by default** until you grant them yourself.",
          target: [
            '[data-permission="gated:orders"]',
            "learn:plugin-detail-permissions",
            "learn:plugin-section-permissions",
          ],
          placement: "top",
          practice: {
            mode: "explain",
            note: "This tour never flips a permission. Granting or revoking applies immediately with no restart, and revoking turns off every part of the plugin that depends on it.",
          },
        },
        {
          id: "open-health",
          title: "Health & Logs",
          body: "Click **Health & Logs**. On a narrow screen, scroll the section bar sideways or just scroll down.",
          target: ["learn:plugin-tab-health", "learn:plugin-section-health"],
          action: { kind: "click" },
        },
        {
          id: "health",
          title: "Is it working?",
          body: "Health, its HTTP routes, background services and recent log lines. **Restart plugin services** is live. A **Full reload** restarts the gateway.",
          target: "learn:plugin-section-health",
          placement: "top",
        },
        {
          id: "data-versions",
          title: "Data and versions",
          body: "**Data** shows the plugin's storage folder, with export, import and clear. **Versions** shows where it came from and offers update or roll back when available.",
          target: ["learn:plugin-tab-data", "learn:plugin-detail-nav"],
        },
      ],
    },
    {
      id: "turn-plugins-on",
      title: "What turning a plugin on gives you",
      summary:
        "The on/off switch, the guided tour, the sidebar section and the Learn track a plugin brings.",
      estMinutes: 3,
      prerequisites: ["browse-plugins"],
      steps: [
        {
          id: "switch",
          title: "The on/off switch",
          body: "Turning a plugin on or off **restarts the gateway** to load or unload its code. That takes a few seconds, and InfiniBot asks you to confirm first. A paid plugin you haven't bought shows **Buy** instead of the switch.",
          route: "/plugins?plugin=infinitrade",
          target: ["learn:plugin-detail-onoff", "learn:plugin-detail-hero"],
          waitMs: 12000,
          practice: {
            mode: "explain",
            note: "This tour never switches a plugin, because that restarts the gateway for everyone connected to it.",
          },
        },
        {
          id: "take-the-tour",
          title: "Take the tour",
          body: "An enabled plugin that ships a guided track shows **Take the tour** on its card and its page. It starts that plugin's walkthrough right here.",
          target: [
            "learn:plugin-tour-infinitrade",
            "[data-plugin-tour]",
            "learn:plugin-detail-hero",
          ],
        },
        {
          id: "sidebar-section",
          title: "Its own sidebar section",
          body: "Each enabled plugin with pages gets its own sidebar section under its monogram. Right-click the header to reorder it, hide it or jump back to **Manage plugin**.",
          target: ["[data-plugin-section]", "aside.nav"],
          placement: "right",
          skipIf: { kind: "viewport", maxWidth: 800 },
        },
        {
          id: "learn-track",
          title: "Its own Learn track",
          body: "Plugin tracks appear on the Learn page only while the plugin is on. Turn a plugin off and its tracks, missions and badges leave the catalog.",
          route: "/learn",
          target: ["learn:learn-filters", "learn:learn-page"],
        },
        {
          id: "manage",
          title: "Back to Plugins",
          body: "Open **Plugins** to manage what's installed. You can also switch off one plugin track under **What it adds** without a restart.",
          target: "main.content",
          placement: "center",
          action: { kind: "navigate", path: "/plugins" },
        },
      ],
    },
  ],
  quiz: [
    {
      id: "enable-restart",
      prompt: "What happens when you turn a plugin on or off?",
      options: [
        "Nothing until you log out",
        "The gateway restarts to load or unload the plugin's code",
        "Only the current browser tab reloads",
        "The plugin is deleted from disk",
      ],
      answer: 1,
      explain:
        "Enabling or disabling loads or unloads plugin code, so the gateway restarts. It takes a few seconds.",
    },
    {
      id: "gated",
      prompt: "A plugin permission shows “Off by default”. What does that mean?",
      options: [
        "The plugin is broken",
        "It's a gated permission that stays off until you grant it yourself",
        "It will turn on after the next restart",
        "Only community plugins have it",
      ],
      answer: 1,
      explain:
        "Gated permissions, like Infinitrade's gated:orders, are never granted automatically. You grant them on the Permissions section.",
    },
    {
      id: "permission-apply",
      prompt: "When does a permission change take effect?",
      options: [
        "Immediately, with no restart",
        "After a gateway restart",
        "The next day",
        "After reinstalling the plugin",
      ],
      answer: 0,
      explain:
        "Permissions apply immediately. Revoking one turns off every part of the plugin that depends on it.",
    },
    {
      id: "plugin-tracks",
      prompt: "When does a plugin's Learn track appear on the Learn page?",
      options: [
        "Always, even when the plugin is uninstalled",
        "Only while the plugin is enabled and loaded",
        "Only on the mobile app",
        "Only after you finish every core track",
      ],
      answer: 1,
      explain: "Plugin tracks, missions and badges are listed only while the plugin is on.",
    },
  ],
};
