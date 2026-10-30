import type { LearnTrack } from "../types.js";

/**
 * Workspace — the per-project studio (/workspace): a workspace agent chat
 * beside a live preview of the running app, element selection for visual
 * edits, Git checkpoints, and the workbench/terminal drawers.
 */
export const track: LearnTrack = {
  id: "workspace",
  title: "Workspace: live preview & visual edit",
  summary:
    "Bind a local project folder, run its live preview, and change it by pointing at elements and describing the edit.",
  overview: [
    "**Workspace** (Agents › Workspace, `/workspace`) is a studio for one project at a time. On the left is a **workspace agent** chat, and on the right a **live preview** of the running app. Everything is scoped to one local folder.",
    "",
    "A *workspace* is a local directory bound to a project. Once you add one, InfiniBot detects the framework, starts its dev server for the preview, and lets the agent edit files in that folder only. Before every agent turn it takes a **Git checkpoint**, so any change can be diffed or reverted.",
    "",
    "This track covers:",
    "- **Workspaces.** Picking, searching and adding one.",
    "- **The live preview.** Dev server status, device widths, routes and the actions menu.",
    "- **Visual edit.** Select an element in the preview, describe the change, review the checkpoint.",
    "",
    "Some steps need a workspace with a running app. If you haven't added one yet, the tour explains those parts instead.",
  ].join("\n"),
  category: "Work",
  level: "intermediate",
  certRequired: true,
  order: 70,
  routes: ["/workspace"],
  signals: ["workspace"],
  prerequisites: ["projects"],
  badge: { id: "workspace", label: "Studio builder", icon: "🛠️" },
  walkthroughs: [
    {
      id: "pick-workspace",
      title: "Pick or add a workspace",
      summary: "The workspace bar, the picker and what adding a workspace does.",
      estMinutes: 3,
      steps: [
        {
          id: "header",
          title: "The workspace bar",
          body: "Everything on this page belongs to the workspace picked on the left of this bar. The rest of the bar controls the preview: server status, device width, route, reload and more actions.",
          route: "/workspace",
          target: "learn:workspace-header",
          placement: "bottom",
        },
        {
          id: "open-picker",
          title: "Open the picker",
          body: "Click the workspace name to list your workspaces.",
          target: "learn:workspace-picker",
          action: { kind: "click" },
        },
        {
          id: "search",
          title: "Find a workspace",
          body: "Type **site**. Recently used workspaces are listed first. The rest follow under **All**.",
          target: "learn:workspace-picker-search",
          action: { kind: "input", sample: "site" },
        },
        {
          id: "add",
          title: "Adding a workspace",
          body: "**+ Add workspace** asks for a project type (web, app, document, PDF or presentation) and a local folder, with your recent folders one click away. It registers the folder; your files aren't changed.",
          target: ["learn:workspace-picker-add", "learn:workspace-picker"],
        },
        {
          id: "scope",
          title: "What a workspace gives you",
          body: "The folder's files become editable here, the workspace agent works only inside that folder, and kanban tasks for the matching project show up alongside it.",
          target: ["learn:workspace-empty", "learn:workspace-chat", "learn:workspace-header"],
          placement: "center",
        },
      ],
    },
    {
      id: "live-preview",
      title: "Run the live preview",
      summary: "Dev server status, device widths, routes and the actions menu.",
      estMinutes: 3,
      steps: [
        {
          id: "server",
          title: "The dev server",
          body: "This pill shows the preview server: **Start**, then **Ready** or **Error**. Clicking **Start** detects the framework, installs dependencies if they're missing, and runs the dev server for the preview.",
          route: "/workspace",
          target: "learn:workspace-server",
          placement: "bottom",
          practice: {
            mode: "explain",
            note: "The tour doesn't start a server. Starting one runs your project's dev command on this machine.",
          },
        },
        {
          id: "device-mobile",
          title: "Preview at phone width",
          body: "Click the **phone** icon. The preview frame narrows to a phone width, and the tablet and desktop icons switch it back.",
          target: "learn:workspace-device-mobile",
          action: { kind: "click" },
          skipIf: { kind: "viewport", maxWidth: 600 },
        },
        {
          id: "device-desktop",
          title: "Back to desktop",
          body: "Click the **monitor** icon to return to full width.",
          target: "learn:workspace-device-desktop",
          action: { kind: "click" },
          skipIf: { kind: "viewport", maxWidth: 600 },
        },
        {
          id: "route",
          title: "Jump to a route",
          body: "Type a path such as **/pricing** and press Enter to open it in the preview. The **⟲** button next to it reloads the preview.",
          target: "learn:workspace-route",
          action: { kind: "input", sample: "/" },
          skipIf: { kind: "viewport", maxWidth: 900 },
        },
        {
          id: "mobile-segment",
          title: "Chat or Preview",
          body: "On a phone, the chat and the preview share the screen. Switch between them here.",
          target: "learn:workspace-mobile-segment",
          skipIf: { kind: "viewport", minWidth: 601 },
        },
        {
          id: "open-more",
          title: "More actions",
          body: "Click **…**.",
          target: "learn:workspace-more",
          action: { kind: "click" },
        },
        {
          id: "more-menu",
          title: "What's in the menu",
          body: "**Versions** lists Git checkpoints. **Files, code, diff & components** opens the workbench, and **Terminal & logs** shows the raw dev server. You can also restart or stop the server, turn on auto-start, run **Visual verify** screenshots, split the preview, and switch the project mode.",
          target: ["learn:workspace-more-menu", "learn:workspace-more"],
          placement: "left",
        },
        {
          id: "close-more",
          title: "Close the menu",
          body: "Click **…** again to close it.",
          target: "learn:workspace-more",
          action: { kind: "click" },
        },
      ],
    },
    {
      id: "visual-edit",
      title: "Visual edit: point, describe, review",
      summary:
        "Select an element in the preview, have the agent change it, and review the checkpoint.",
      estMinutes: 4,
      prerequisites: ["pick-workspace"],
      steps: [
        {
          id: "select",
          title: "Select mode",
          body: "With a workspace running, the preview header has a **Select** button. Turn it on, then click any element in the preview to pick it. Press **Esc** to leave select mode.",
          route: "/workspace",
          target: [
            "learn:workspace-select",
            "learn:workspace-preview",
            "learn:workspace-empty",
            "learn:workspace-header",
          ],
        },
        {
          id: "selection-actions",
          title: "What you can do with it",
          body: "A bar appears on the selected element. **Edit with AI** attaches it to the chat, **Copy selector** copies its CSS selector, and **Open in code** jumps to the workbench.",
        },
        {
          id: "describe",
          title: "Describe the change",
          body: "The chat shows the selected element as context. Write what you want (“make this button gold and larger”) and press **⌘/Ctrl+Enter**. The agent edits files in the workspace and the preview picks up the change.",
          target: ["learn:workspace-chat", "learn:workspace-empty", "learn:workspace-header"],
          practice: {
            mode: "explain",
            note: "The tour doesn't send a request. Sending one starts an agent run that edits files in your project folder.",
          },
        },
        {
          id: "checkpoint",
          title: "Every turn is a checkpoint",
          body: "A Git checkpoint is created before every agent turn. The latest ones appear in the chat with **View diff** and **Revert**, and the full list is under **… › Versions**.",
          target: ["learn:workspace-more", "learn:workspace-header"],
        },
        {
          id: "palette",
          title: "Keyboard first",
          body: "Press **⌘K / Ctrl+K** in the workspace for quick commands: select an element, open files, open the terminal, reload the preview, or show versions.",
          target: "learn:workspace-header",
          placement: "bottom",
        },
      ],
    },
  ],
  quiz: [
    {
      id: "what-is",
      prompt: "What is a workspace?",
      options: [
        "A cloud VM",
        "A local directory bound to a project",
        "A Notion page",
        "A chat session",
      ],
      answer: 1,
      explain:
        "A workspace registers a local folder. The preview, the agent and the file tools all work inside it.",
    },
    {
      id: "select",
      prompt: "How do you point the agent at a specific part of the page?",
      options: [
        "Describe its pixel coordinates",
        "Turn on Select, click the element in the preview, then Edit with AI",
        "Paste the page's HTML into chat",
        "It can't be done",
      ],
      answer: 1,
      explain:
        "Select mode picks an element in the live preview and attaches it to the chat as context.",
    },
    {
      id: "undo",
      prompt: "The agent made a change you don't like. What's the fastest way back?",
      options: [
        "Delete the workspace",
        "Revert the Git checkpoint taken before that turn",
        "Restart the gateway",
        "Edit every file by hand",
      ],
      answer: 1,
      explain:
        "A checkpoint is created before every agent turn. View its diff or Revert it from the chat or Versions.",
    },
  ],
};
