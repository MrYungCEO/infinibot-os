/**
 * Tool → capability domain. Used to group an agent's tool list and to build
 * the agents × domains capability matrix. Name-based so new tools land in a
 * sensible domain without a code change (unknowns fall into "Other").
 */

export const CAPABILITY_DOMAINS = [
  "Knowledge & memory",
  "Files & code",
  "Runtime",
  "Web & research",
  "Browser & UI",
  "Desktop control",
  "Agents & sessions",
  "Messaging",
  "Automation",
  "Business & CRM",
  "Content & media",
  "Voice",
  "Infra & federation",
  "Other",
] as const;

export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number];

const EXACT: Record<string, CapabilityDomain> = {
  memory_search: "Knowledge & memory",
  memory_get: "Knowledge & memory",
  notes: "Knowledge & memory",
  kanban: "Knowledge & memory",
  databases: "Knowledge & memory",
  vault: "Knowledge & memory",
  report: "Knowledge & memory",
  object_relations: "Knowledge & memory",
  read: "Files & code",
  write: "Files & code",
  edit: "Files & code",
  apply_patch: "Files & code",
  github_project_sync: "Files & code",
  exec: "Runtime",
  process: "Runtime",
  infinibot_terminal: "Runtime",
  web_search: "Web & research",
  web_fetch: "Web & research",
  web_read: "Web & research",
  web_image_search: "Web & research",
  youtube_transcript: "Web & research",
  github_read: "Web & research",
  rss_read: "Web & research",
  research: "Web & research",
  viral_watch: "Web & research",
  browser: "Browser & UI",
  ui_control: "Browser & UI",
  canvas: "Browser & UI",
  overlay_notify: "Browser & UI",
  proactive: "Browser & UI",
  screen_analyze: "Desktop control",
  message: "Messaging",
  gmail: "Messaging",
  cron: "Automation",
  workflows: "Automation",
  loops: "Automation",
  reminder: "Automation",
  autonomous_task: "Automation",
  gateway: "Infra & federation",
  nodes: "Infra & federation",
  mcp: "Infra & federation",
  services: "Infra & federation",
  ssh_devices: "Infra & federation",
  tailscale_control: "Infra & federation",
  mesh: "Infra & federation",
  tts: "Voice",
  image: "Content & media",
  vision: "Content & media",
  script: "Content & media",
  content_intel: "Content & media",
  video_editor: "Content & media",
  characters: "Content & media",
};

const PATTERNS: Array<[RegExp, CapabilityDomain]> = [
  [/^(memory|knowledge|notes?|kb)_/, "Knowledge & memory"],
  [/^(fs|file|files|git|code)_/, "Files & code"],
  [
    /^(sessions?|subagents?|agents?)_|_coder$|^report_checkpoint$|^subagent_progress$/,
    "Agents & sessions",
  ],
  [/^(hyprland|desktop|windows|mouse|keyboard)_/, "Desktop control"],
  [/^(telegram|whatsapp|discord|slack|signal|imessage|email|sms)_?/, "Messaging"],
  [/^(voice|talk|tts|stt)_?/, "Voice"],
  [/^(web|search|scrape|crawl)_/, "Web & research"],
  [/^(browser|ui|canvas)_/, "Browser & UI"],
  [/^(cron|workflow|loop|schedule|autonom)/, "Automation"],
  [
    /^(client|business|funnel|budget|lead|crm|invoice|calendar|goal|focus|discipline|workload|issues?|kpi|campaign)/,
    "Business & CRM",
  ],
  [/^(image|video|content|media|storyboard|design|brand|viral|script)/, "Content & media"],
  [/^(federation|node|mcp|tailscale|ssh|service|gateway|mesh)/, "Infra & federation"],
];

export function domainForTool(name: string): CapabilityDomain {
  const n = name.trim().toLowerCase();
  if (EXACT[n]) return EXACT[n];
  for (const [re, domain] of PATTERNS) if (re.test(n)) return domain;
  return "Other";
}

/**
 * Core runtime tools composed by the agent runner (pi-tools) that are NOT part
 * of the gateway tool registry returned by createInfiniBotTools. Listed so an
 * agent's allowlist of e.g. "exec" still shows up with a description.
 */
export const CORE_TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "Read files from the agent workspace / host filesystem.",
  write: "Create or overwrite files.",
  edit: "Edit files in place (string replacement).",
  apply_patch: "Apply a multi-file unified patch.",
  exec: "Run shell commands on the host (subject to exec approvals).",
  process: "Manage long-running background processes started by exec.",
};
