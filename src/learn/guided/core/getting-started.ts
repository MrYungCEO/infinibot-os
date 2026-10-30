import type { LearnTrack } from "../types.js";

/**
 * Getting started — the first track every user sees (Day-1 mission).
 * Reference example for authors: routes, targets with fallbacks, user
 * actions, a route check, viewport-aware skips, and a quiz.
 */
export const track: LearnTrack = {
  id: "getting-started",
  title: "Getting started",
  summary:
    "Find your way around InfiniBot: the command bar, the sidebar, the Launchpad and where help lives.",
  overview: [
    "InfiniBot is a control terminal for a team of AI agents. Everything runs through one gateway on your machine (or your cloud workspace), and every page in the sidebar is a view onto it.",
    "",
    "This track covers:",
    "- **The layout.** The command bar across the top, the sidebar of pages on the left, and the page itself in the middle.",
    "- **The Launchpad** (⌘P / Ctrl+P). Jump to any page by typing its name.",
    "- **Getting help.** The graduation cap opens your Day-1 missions. The **Learn this** chip starts the tour for the page you're on.",
  ].join("\n"),
  category: "Foundations",
  level: "beginner",
  certRequired: true,
  order: 10,
  routes: ["/", "/dashboard"],
  signals: ["dashboard"],
  badge: { id: "getting-started", label: "Oriented", icon: "🧭" },
  walkthroughs: [
    {
      id: "tour-the-app",
      title: "Tour the app",
      summary: "The command bar, the sidebar and the page area, in one minute.",
      estMinutes: 2,
      steps: [
        {
          id: "welcome",
          title: "Welcome to InfiniBot",
          body: "This short tour points at the real controls. Use **Next** (or →) to move on, **Back** (←) to go back and **Esc** to leave any time.",
        },
        {
          id: "command-bar",
          title: "The command bar",
          body: "Across the top: gateway health, the clock, **Live** mode, quick **Chat**, notifications and restart. Plugins can add their own controls here too.",
          route: "/",
          target: ".topbar",
          placement: "bottom",
        },
        {
          id: "launchpad",
          title: "The Launchpad",
          body: "The fastest way anywhere. Click it or press **⌘P** / **Ctrl+P** and type a page name.",
          target: ".nav-launchpad-btn",
        },
        {
          id: "sidebar",
          title: "Your sidebar",
          body: "Pages are grouped: Home, Chat & Voice, Work, Agents and more. Every enabled plugin gets its own section with its monogram. You can collapse groups and pin favourites.",
          target: "aside.nav",
          placement: "right",
          skipIf: { kind: "viewport", maxWidth: 800 },
        },
        {
          id: "page-area",
          title: "The page area",
          body: "The page you pick opens here. Your first home page is the **Getting started** checklist. Once you're done with it, this becomes your dashboard.",
          target: "main.content",
          placement: "center",
        },
        {
          id: "help",
          title: "Help is one click away",
          body: "The graduation cap opens your **Day 1 missions**. On any page with a guided tour, a **Learn this** chip appears next to it.",
          target: ["learn:learn-topbar", ".cb-more__btn"],
        },
      ],
    },
    {
      id: "find-any-page",
      title: "Find any page with the Launchpad",
      summary: "Open the Launchpad, search for a page and jump to it.",
      estMinutes: 2,
      steps: [
        {
          id: "open-launchpad",
          title: "Open the Launchpad",
          body: "Click **Launchpad**. The keyboard shortcut is ⌘P, or Ctrl+P on Windows and Linux.",
          route: "/",
          target: ".nav-launchpad-btn",
          action: { kind: "click" },
        },
        {
          id: "search",
          title: "Search for a page",
          body: "Type **projects**. The Launchpad matches page titles, routes and groups.",
          target: ".lp-searchbar__input",
          action: { kind: "input", match: "proj", sample: "projects" },
        },
        {
          id: "pick",
          title: "Jump to it",
          body: "Click the **Projects** card, or press Enter.",
          target: "learn:launchpad-card-projects",
          action: { kind: "click" },
        },
        {
          id: "arrived",
          title: "You're there",
          body: "Projects opened. The Launchpad also shows your favourites and recent pages. Right-click a card to pin it.",
          check: { kind: "route", path: "/projects" },
          checkHint: "Waiting for the Projects page to open…",
          target: "main.content",
          placement: "center",
        },
      ],
    },
    {
      id: "getting-help",
      title: "Getting help: Learn this + the Learn page",
      summary: "Start the right tour from any page and search the whole curriculum.",
      estMinutes: 3,
      prerequisites: ["tour-the-app"],
      steps: [
        {
          id: "learn-this",
          title: "Learn this page",
          body: "When a page has a guided tour, a **Learn this** chip appears in the command bar. Click it to start the tour for the page you're on.",
          route: "/projects",
          target: ["learn:learn-this", "learn:learn-topbar", ".cb-more__btn"],
        },
        {
          id: "open-learn",
          title: "The Learn page",
          body: "Every track lives here: core features first, then one track for each enabled plugin. Progress is saved to your account, so it follows you to other browsers and the mobile app.",
          route: "/learn",
          target: "learn:learn-page",
          placement: "center",
        },
        {
          id: "search-learn",
          title: "Search the curriculum",
          body: "Type **goals** to find the tracks about goals and verified completion.",
          target: "learn:learn-search",
          action: { kind: "input", match: "goal", sample: "goals" },
        },
        {
          id: "filters",
          title: "Filter by type or progress",
          body: "Switch between core and plugin tracks, or show only what's in progress or done. The **Certification** tab shows your path to Apprentice, Practitioner and Master.",
          target: "learn:learn-filters",
        },
      ],
    },
  ],
  quiz: [
    {
      id: "launchpad-shortcut",
      prompt: "What's the quickest way to jump to any page?",
      options: ["Reload the app", "The Launchpad (⌘P / Ctrl+P)", "Settings › Pages", "Ask in chat"],
      answer: 1,
      explain: "The Launchpad searches every page by title, route and group.",
    },
    {
      id: "plugin-sections",
      prompt: "Where do an enabled plugin's pages appear?",
      options: [
        "Only in Settings",
        "In their own sidebar section with the plugin's monogram",
        "Nowhere until you restart",
        "Under Home",
      ],
      answer: 1,
      explain: "Each enabled plugin with pages gets its own sidebar section.",
    },
    {
      id: "exit-tour",
      prompt: "How do you leave a guided tour at any time?",
      options: ["Press Esc", "Reload twice", "Log out", "You can't until it ends"],
      answer: 0,
      explain: "Esc always exits. You can also minimise the tour and resume it later.",
    },
  ],
};
