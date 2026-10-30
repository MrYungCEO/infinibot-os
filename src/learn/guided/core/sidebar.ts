import type { LearnTrack } from "../types.js";

/**
 * Sidebar: favorites & hierarchy. The enhanced sidebar
 * (ui/src/ui/views/nav-sidebar-enhanced.ts, controllers/nav-sidebar.ts) and
 * the Launchpad's favorites. The sidebar is desktop-only chrome, so its steps
 * skip below 800px; every walkthrough keeps Launchpad steps that work on a
 * phone.
 *
 * Only harmless, reversible layout actions: collapse → expand a group, type
 * into (then clear) the tab search, open/close the Launchpad.
 */
const DESKTOP_ONLY = { kind: "viewport", maxWidth: 800 } as const;

export const track: LearnTrack = {
  id: "sidebar",
  title: "Sidebar: favorites & hierarchy",
  summary:
    "Pin favorite pages, collapse and reorganise groups, hide what you don't use and find any page fast.",
  overview: [
    "The sidebar is your map of InfiniBot. You can shape it around the way you work.",
    "",
    "This track covers:",
    "- **Favorites.** Star a page, or right-click it and pick **Add to favorites**. Favorites sit in their own group at the top of the sidebar and lead the Launchpad.",
    "- **Groups.** Collapse the ones you rarely open. Right-click a group header to move it, nest it inside another group or rename it. Drag pages and groups to reorder them.",
    "- **Hiding pages.** The × on a page hides it. Hidden pages wait in the **Hidden Tabs** group until you restore them.",
    "- **Plugin sections.** Every enabled plugin with pages gets its own section under its monogram.",
    "- **Finding pages.** Search tabs (⌘K) filters the sidebar. The Launchpad (⌘P) searches every page, and it's how you get around on a phone.",
    "",
    "Your layout is saved to the gateway, so it follows you to other browsers.",
  ].join("\n"),
  category: "Foundations",
  level: "beginner",
  certRequired: true,
  order: 15,
  estMinutes: 8,
  prerequisites: ["getting-started"],
  badge: { id: "sidebar", label: "Wayfinder", icon: "🗂️" },
  walkthroughs: [
    {
      id: "favorites",
      title: "Pin your favorite pages",
      summary: "Where favorites live, how to add one, and how they show up in the Launchpad.",
      estMinutes: 3,
      steps: [
        {
          id: "favorites-group",
          title: "The Favorites group",
          body: "Favorites sit at the top of the sidebar. It's empty until you pin something. Click the header to fold it away.",
          route: "/",
          target: "[data-favorites-section]",
          placement: "right",
          skipIf: DESKTOP_ONLY,
        },
        {
          id: "star",
          title: "Star a page",
          body: "Hover any page and click the **star**, or right-click it and choose **Add to favorites**. Right-click a favorite to move it up or down the list.",
          target: 'a.nav-item[data-tab-pill="projects"]',
          placement: "right",
          skipIf: DESKTOP_ONLY,
        },
        {
          id: "open-launchpad",
          title: "Favorites in the Launchpad",
          body: "Favorites also lead the Launchpad. Click **Launchpad** (⌘P / Ctrl+P).",
          route: "/",
          target: ".nav-launchpad-btn",
          action: { kind: "click" },
        },
        {
          id: "card-star",
          title: "Star from the Launchpad",
          body: "Hover a card and click its star, or right-click the card. It's the same favorites list as the sidebar, so a page pinned here shows up there too.",
          target: ["learn:launchpad-card-projects", "[data-launchpad-grid]"],
        },
        {
          id: "close",
          title: "Close the Launchpad",
          body: "Press **Esc**, click the close button, or click outside the panel.",
          target: [".lp-searchbar__close", ".lp-overlay"],
          action: { kind: "click" },
        },
      ],
    },
    {
      id: "organise-groups",
      title: "Collapse and organise groups",
      summary: "Fold groups away, reorder and nest them, and hide pages you don't use.",
      estMinutes: 3,
      steps: [
        {
          id: "collapse",
          title: "Collapse a group",
          body: "Click the chevron next to **Work** to fold the group away.",
          route: "/",
          target: 'button.nav-category-toggle[aria-label="Collapse Work"]',
          action: { kind: "click" },
          placement: "right",
          skipIf: DESKTOP_ONLY,
        },
        {
          id: "expand",
          title: "Open it again",
          body: "The group remembers it's collapsed, even after a reload. Click the chevron again to bring **Work** back.",
          target: 'button.nav-category-toggle[aria-label="Expand Work"]',
          action: { kind: "click" },
          placement: "right",
          skipIf: DESKTOP_ONLY,
        },
        {
          id: "section-menu",
          title: "Group actions",
          body: "Right-click a group header (or press Shift+F10 on it) to move it up or down, nest it inside another group, or rename it. You can also drag groups and pages to reorder them.",
          target: [
            '.nav-category-header[aria-label="Work section actions"]',
            ".nav-category-header[aria-haspopup]",
          ],
          placement: "right",
          skipIf: DESKTOP_ONLY,
        },
        {
          id: "hide",
          title: "Hide a page",
          body: "The **×** on a page hides it. Hidden pages collect in a **Hidden Tabs** group at the bottom of the sidebar, each with a button to show it again.",
          target: 'a.nav-item[data-tab-pill="research"]',
          placement: "right",
          skipIf: DESKTOP_ONLY,
          practice: {
            mode: "explain",
            note: "This tour doesn't hide anything. Hiding only changes your sidebar, and the page stays reachable from the Launchpad.",
          },
        },
        {
          id: "mobile",
          title: "On a phone or narrow window",
          body: "The sidebar folds away on small screens. The **Launchpad** reaches every page, hidden ones included, and your favorites come first.",
          target: ".nav-launchpad-btn",
        },
      ],
    },
    {
      id: "find-pages",
      title: "Search tabs and plugin sections",
      summary:
        "Filter the sidebar as you type, spot plugin sections, and search every page from the Launchpad.",
      estMinutes: 2,
      steps: [
        {
          id: "search",
          title: "Search tabs",
          body: "Press **⌘K** (Ctrl+K) or click the search box, then type **mobile**. Every group filters as you type.",
          route: "/",
          target: ".nav-search__input",
          action: { kind: "input", match: "mob", sample: "mobile" },
          placement: "right",
          skipIf: DESKTOP_ONLY,
        },
        {
          id: "result",
          title: "The match",
          body: "Collapsed groups open while you search, so a match is never hidden. Click it to go there, or keep reading.",
          target: ['a.nav-item[data-tab-pill="mobile"]', ".nav-categories"],
          placement: "right",
          skipIf: DESKTOP_ONLY,
        },
        {
          id: "clear",
          title: "Clear the search",
          body: "Click **×** in the search box, or press Esc.",
          target: ".nav-search__clear",
          action: { kind: "click" },
          skipIf: DESKTOP_ONLY,
        },
        {
          id: "plugin-sections",
          title: "Plugin sections",
          body: "Each enabled plugin with pages gets its own section under its monogram. Right-click the header to hide the section or jump to **Manage plugin**.",
          target: ["[data-plugin-section]", ".nav-categories"],
          placement: "right",
          skipIf: DESKTOP_ONLY,
        },
        {
          id: "launchpad",
          title: "Search every page",
          body: "The Launchpad searches every page by title, route and group, including hidden pages and plugin pages. Open it.",
          target: ".nav-launchpad-btn",
          action: { kind: "click" },
        },
        {
          id: "launchpad-search",
          title: "Type a page name",
          body: "Type **mobile**.",
          target: ".lp-searchbar__input",
          action: { kind: "input", match: "mob", sample: "mobile" },
        },
        {
          id: "launchpad-result",
          title: "Jump there",
          body: "Click the card, or press Enter, to open the page.",
          target: ["learn:launchpad-card-mobile", "[data-launchpad-grid]"],
          action: { kind: "click" },
        },
        {
          id: "arrived",
          title: "You're there",
          body: "That's the Mobile page. The same Launchpad works on your phone.",
          check: { kind: "route", path: "/mobile" },
          checkHint: "Waiting for the Mobile page to open…",
          target: "main.content",
          placement: "center",
        },
      ],
    },
  ],
  quiz: [
    {
      id: "add-favorite",
      prompt: "How do you add a page to Favorites?",
      options: [
        "Drag it onto the command bar",
        "Click its star, or right-click it and choose Add to favorites",
        "Rename it to start with ★",
        "Favorites are chosen automatically",
      ],
      answer: 1,
      explain:
        "The star appears when you hover a page. Right-click works in both the sidebar and the Launchpad.",
    },
    {
      id: "hidden",
      prompt: "You hid a page with its ×. Where do you get it back?",
      options: [
        "It's gone until you reinstall",
        "The Hidden Tabs group at the bottom of the sidebar",
        "Settings › Pages",
        "Only by resetting the whole layout",
      ],
      answer: 1,
      explain:
        "Hidden pages wait in Hidden Tabs with a button to show each one again. The Launchpad still reaches them too.",
    },
    {
      id: "mobile-nav",
      prompt: "The sidebar is folded away on a phone. What's the fastest way to any page?",
      options: ["The Launchpad", "Reload the app", "Log out and back in", "There isn't one"],
      answer: 0,
      explain:
        "The Launchpad searches every page by title, route and group, and lists your favorites first.",
    },
    {
      id: "group-menu",
      prompt: "How do you move or rename a sidebar group?",
      options: [
        "Edit a config file",
        "Right-click its header (or press Shift+F10 on it)",
        "Groups can't be changed",
        "Double-click the page area",
      ],
      answer: 1,
      explain:
        "The group menu moves a group up or down, nests it inside another group and renames it. You can also drag it.",
    },
  ],
};
