/**
 * AI IDE Panel — Real-time visualization of agent work
 * Shows tool executions, code generation, and file operations
 * in a sleek, IDE-like interface with animated typing effect
 * 
 * Features:
 * - Animated character-by-character code streaming
 * - Real-time stats (tokens/sec, lines, elapsed time)
 * - Syntax highlighting during streaming
 * - Progress bar with generation status
 */

import { LitElement, html, css, nothing, PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../icons";

// ============================================================
// Types
// ============================================================

export interface ToolExecution {
  id: string;
  name: string;
  displayName: string;
  icon: string;
  status: "pending" | "running" | "complete" | "error";
  startedAt: number;
  completedAt?: number;
  duration?: number;
  args?: Record<string, unknown>;
  result?: string;
  error?: string;
  // For code-related tools
  filePath?: string;
  language?: string;
  code?: string;
  diff?: CodeDiff;
}

export interface CodeDiff {
  filePath: string;
  language: string;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
  lineNumber?: number;
}

export interface FileOperation {
  path: string;
  operation: "create" | "modify" | "delete" | "read";
  timestamp: number;
}

export interface AIIDEState {
  executions: ToolExecution[];
  files: FileOperation[];
  activeExecution?: string;
  expandedExecutions: Set<string>;
  viewMode: "activity" | "code" | "files";
  collapsed: boolean;
}

// ============================================================
// Tool Icon/Name Mapping
// ============================================================

const TOOL_ICONS: Record<string, string> = {
  read: "📄",
  write: "✏️",
  edit: "🔧",
  exec: "⚡",
  browser: "🌐",
  web_search: "🔍",
  web_fetch: "📥",
  kanban: "📋",
  cron: "⏰",
  message: "💬",
  notes: "📝",
  research: "🔬",
  workflows: "🔄",
  memory_search: "🧠",
  memory_get: "💭",
  vision: "👁️",
  tts: "🔊",
  image: "🖼️",
  sessions_spawn: "🚀",
  sessions_send: "📨",
  process: "⚙️",
  nodes: "📡",
  canvas: "🎨",
  gateway: "🔌",
  budget: "💰",
};

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read: "Read File",
  write: "Write File",
  edit: "Edit File",
  exec: "Execute",
  browser: "Browser",
  web_search: "Search Web",
  web_fetch: "Fetch URL",
  kanban: "Kanban",
  cron: "Schedule",
  message: "Message",
  notes: "Notes",
  research: "Research",
  workflows: "Workflows",
  memory_search: "Memory Search",
  memory_get: "Memory Get",
  vision: "Vision",
  tts: "Text to Speech",
  image: "Analyze Image",
  sessions_spawn: "Spawn Agent",
  sessions_send: "Send Message",
  process: "Process",
  nodes: "Nodes",
  canvas: "Canvas",
  gateway: "Gateway",
  budget: "Budget",
};

// Language detection from file extension
const LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  bat: "batch",
  xml: "xml",
  toml: "toml",
  ini: "ini",
  env: "env",
  dockerfile: "dockerfile",
  vue: "vue",
  svelte: "svelte",
};

function detectLanguage(filePath?: string): string {
  if (!filePath) return "plaintext";
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const filename = filePath.split(/[/\\]/).pop()?.toLowerCase() || "";
  if (filename === "dockerfile") return "dockerfile";
  if (filename.startsWith(".env")) return "env";
  return LANG_MAP[ext] || "plaintext";
}

function getToolIcon(name: string): string {
  return TOOL_ICONS[name.toLowerCase()] || "🔧";
}

function getToolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name.toLowerCase()] || name;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function formatElapsed(startedAt: number): string {
  return formatDuration(Date.now() - startedAt);
}

function shortenPath(path: string, maxLen: number = 40): string {
  if (path.length <= maxLen) return path;
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.length <= 2) return "..." + path.slice(-maxLen + 3);
  const filename = parts.pop()!;
  const dir = parts.pop()!;
  return `.../${dir}/${filename}`;
}

// ============================================================
// AI IDE Panel Component
// ============================================================

@customElement("ai-ide-panel")
export class AIIDEPanel extends LitElement {
  @property({ type: Array }) executions: ToolExecution[] = [];
  @property({ type: Array }) files: FileOperation[] = [];
  @property({ type: Boolean }) streaming = false;
  @property({ type: Boolean }) collapsed = false;
  @property({ type: String }) activeTab: "activity" | "code" | "files" | "streaming" = "activity";
  
  // Streaming code animation
  @property({ type: String }) streamingCode = "";
  @property({ type: String }) streamingFilePath = "";
  @property({ type: Number }) streamingStartTime = 0;

  @state() private expandedIds = new Set<string>();
  @state() private selectedExecution: string | null = null;
  @state() private elapsedTime = 0;
  @state() private codeScrollPosition = 0;
  
  // Animated typing state
  @state() private displayedCode = "";
  @state() private typingIndex = 0;
  @state() private streamStats = { chars: 0, lines: 0, tokensPerSec: 0 };
  @state() private cursorPosition = { line: 1, col: 1 };

  private elapsedInterval: number | null = null;
  private typingInterval: number | null = null;
  private lastStreamingCode = "";

  static styles = css`
    :host {
      display: block;
      font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
    }

    /* ===== Main Container ===== */
    .ai-ide {
      background: var(--c-bg-ide, #0d1117);
      border: 1px solid var(--c-border-ide, #30363d);
      border-radius: 12px;
      overflow: hidden;
      transition: all 0.3s ease;
    }

    .ai-ide.collapsed {
      max-height: 48px;
    }

    .ai-ide.streaming {
      border-color: var(--c-accent, #f0b429);
      box-shadow: 0 0 20px rgba(240, 180, 41, 0.15);
    }

    /* ===== Header ===== */
    .ide-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: var(--c-bg-header, #161b22);
      border-bottom: 1px solid var(--c-border-ide, #30363d);
      cursor: pointer;
      user-select: none;
    }

    .ide-header:hover {
      background: var(--c-bg-header-hover, #1c2128);
    }

    .ide-header__left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .ide-header__status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--c-muted, #6e7681);
    }

    .status-dot.active {
      background: var(--c-accent, #f0b429);
      box-shadow: 0 0 8px var(--c-accent, #f0b429);
      animation: pulse 1.5s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .ide-header__stats {
      display: flex;
      gap: 12px;
      font-size: 11px;
      color: var(--c-muted, #8b949e);
    }

    .ide-header__stat {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .ide-header__actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .ide-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--c-muted, #8b949e);
      cursor: pointer;
      transition: all 0.15s;
    }

    .ide-btn:hover {
      background: var(--c-bg-hover, #21262d);
      color: var(--c-text, #c9d1d9);
    }

    .ide-btn svg {
      width: 14px;
      height: 14px;
    }

    /* ===== Tabs ===== */
    .ide-tabs {
      display: flex;
      gap: 2px;
      padding: 6px 14px;
      background: var(--c-bg-tabs, #0d1117);
      border-bottom: 1px solid var(--c-border-ide, #30363d);
    }

    .ide-tab {
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      color: var(--c-muted, #8b949e);
      background: transparent;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .ide-tab:hover {
      color: var(--c-text, #c9d1d9);
      background: var(--c-bg-hover, #21262d);
    }

    .ide-tab.active {
      color: var(--c-text, #c9d1d9);
      background: var(--c-bg-active, #21262d);
    }

    .ide-tab__badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      font-size: 10px;
      font-weight: 600;
      background: var(--c-accent-dim, rgba(240, 180, 41, 0.2));
      color: var(--c-accent, #f0b429);
      border-radius: 9px;
    }

    /* ===== Content Area ===== */
    .ide-content {
      max-height: 400px;
      overflow-y: auto;
      overflow-x: hidden;
    }

    .ide-content::-webkit-scrollbar {
      width: 8px;
    }

    .ide-content::-webkit-scrollbar-track {
      background: transparent;
    }

    .ide-content::-webkit-scrollbar-thumb {
      background: var(--c-border-ide, #30363d);
      border-radius: 4px;
    }

    .ide-content::-webkit-scrollbar-thumb:hover {
      background: var(--c-muted, #6e7681);
    }

    /* ===== Activity View ===== */
    .activity-list {
      padding: 8px;
    }

    .activity-item {
      display: flex;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 8px;
      margin-bottom: 4px;
      background: var(--c-bg-item, #161b22);
      border: 1px solid transparent;
      transition: all 0.15s;
      cursor: pointer;
    }

    .activity-item:hover {
      background: var(--c-bg-item-hover, #1c2128);
      border-color: var(--c-border-ide, #30363d);
    }

    .activity-item.running {
      border-color: var(--c-accent, #f0b429);
      background: rgba(240, 180, 41, 0.05);
    }

    .activity-item.error {
      border-color: var(--c-error, #f85149);
      background: rgba(248, 81, 73, 0.05);
    }

    .activity-item__icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      font-size: 16px;
      background: var(--c-bg-icon, #21262d);
      border-radius: 8px;
      flex-shrink: 0;
    }

    .activity-item.running .activity-item__icon {
      animation: icon-pulse 1s ease-in-out infinite;
    }

    @keyframes icon-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.1); }
    }

    .activity-item__content {
      flex: 1;
      min-width: 0;
    }

    .activity-item__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
    }

    .activity-item__name {
      font-size: 13px;
      font-weight: 600;
      color: var(--c-text, #c9d1d9);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .activity-item__status {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--c-muted, #8b949e);
      white-space: nowrap;
    }

    .activity-item__status.running {
      color: var(--c-accent, #f0b429);
    }

    .activity-item__status.complete {
      color: var(--c-success, #3fb950);
    }

    .activity-item__status.error {
      color: var(--c-error, #f85149);
    }

    .activity-item__detail {
      font-size: 12px;
      color: var(--c-muted, #8b949e);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .activity-item__detail code {
      font-family: var(--font-mono, 'SF Mono', Consolas, monospace);
      font-size: 11px;
      background: var(--c-bg-code, #21262d);
      padding: 2px 6px;
      border-radius: 4px;
    }

    /* ===== Expanded Activity Detail ===== */
    .activity-detail {
      margin-top: 10px;
      padding: 10px;
      background: var(--c-bg-detail, #0d1117);
      border-radius: 6px;
      border: 1px solid var(--c-border-ide, #30363d);
    }

    .activity-detail__section {
      margin-bottom: 10px;
    }

    .activity-detail__section:last-child {
      margin-bottom: 0;
    }

    .activity-detail__label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--c-muted, #6e7681);
      margin-bottom: 6px;
    }

    .activity-detail__code {
      font-family: var(--font-mono, 'SF Mono', Consolas, monospace);
      font-size: 11px;
      line-height: 1.5;
      color: var(--c-text-code, #e6edf3);
      background: var(--c-bg-code, #161b22);
      padding: 10px;
      border-radius: 4px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow-y: auto;
    }

    /* ===== Code View ===== */
    .code-panel {
      display: flex;
      flex-direction: column;
    }

    .code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 14px;
      background: var(--c-bg-code-header, #161b22);
      border-bottom: 1px solid var(--c-border-ide, #30363d);
    }

    .code-header__path {
      font-family: var(--font-mono, 'SF Mono', Consolas, monospace);
      font-size: 12px;
      color: var(--c-text, #c9d1d9);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .code-header__lang {
      font-size: 10px;
      padding: 2px 6px;
      background: var(--c-bg-lang, #21262d);
      border-radius: 4px;
      color: var(--c-muted, #8b949e);
      text-transform: uppercase;
    }

    .code-viewer {
      font-family: var(--font-mono, 'SF Mono', Consolas, monospace);
      font-size: 12px;
      line-height: 1.6;
      background: var(--c-bg-code, #0d1117);
      padding: 12px 0;
      overflow-x: auto;
    }

    .code-line {
      display: flex;
      padding: 0 14px;
      min-height: 20px;
    }

    .code-line:hover {
      background: var(--c-bg-line-hover, rgba(255, 255, 255, 0.04));
    }

    .code-line.added {
      background: rgba(63, 185, 80, 0.15);
    }

    .code-line.removed {
      background: rgba(248, 81, 73, 0.15);
    }

    .code-line__number {
      width: 40px;
      color: var(--c-line-number, #6e7681);
      text-align: right;
      padding-right: 12px;
      user-select: none;
      flex-shrink: 0;
    }

    .code-line__marker {
      width: 14px;
      color: var(--c-muted, #6e7681);
      text-align: center;
      flex-shrink: 0;
    }

    .code-line.added .code-line__marker {
      color: var(--c-success, #3fb950);
    }

    .code-line.removed .code-line__marker {
      color: var(--c-error, #f85149);
    }

    .code-line__content {
      flex: 1;
      white-space: pre;
      color: var(--c-text-code, #e6edf3);
    }

    /* ===== Files View ===== */
    .files-tree {
      padding: 8px;
    }

    .file-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 6px;
      margin-bottom: 2px;
      cursor: pointer;
      transition: background 0.15s;
    }

    .file-item:hover {
      background: var(--c-bg-hover, #21262d);
    }

    .file-item__icon {
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
    }

    .file-item__icon.create { color: var(--c-success, #3fb950); }
    .file-item__icon.modify { color: var(--c-accent, #f0b429); }
    .file-item__icon.delete { color: var(--c-error, #f85149); }
    .file-item__icon.read { color: var(--c-info, #58a6ff); }

    .file-item__path {
      flex: 1;
      font-family: var(--font-mono, 'SF Mono', Consolas, monospace);
      font-size: 12px;
      color: var(--c-text, #c9d1d9);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .file-item__time {
      font-size: 11px;
      color: var(--c-muted, #6e7681);
    }

    /* ===== Empty State ===== */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      color: var(--c-muted, #8b949e);
    }

    .empty-state__icon {
      font-size: 32px;
      margin-bottom: 12px;
      opacity: 0.5;
    }

    .empty-state__text {
      font-size: 13px;
      text-align: center;
    }

    /* ===== Spinner ===== */
    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid var(--c-muted, #6e7681);
      border-top-color: var(--c-accent, #f0b429);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* ===== Mobile Styles ===== */
    @media (max-width: 768px) {
      .ide-header__stats {
        display: none;
      }

      .ide-tabs {
        padding: 4px 8px;
        overflow-x: auto;
      }

      .ide-tab {
        padding: 5px 10px;
        font-size: 11px;
      }

      .activity-item {
        padding: 8px 10px;
        gap: 10px;
      }

      .activity-item__icon {
        width: 28px;
        height: 28px;
        font-size: 14px;
      }

      .activity-item__name {
        font-size: 12px;
      }

      .activity-detail__code {
        font-size: 10px;
        padding: 8px;
      }

      .code-viewer {
        font-size: 11px;
      }

      .code-line__number {
        width: 30px;
        padding-right: 8px;
      }
    }

    /* ===== Syntax Highlighting (basic) ===== */
    .token-keyword { color: #ff7b72; }
    .token-string { color: #a5d6ff; }
    .token-comment { color: #8b949e; font-style: italic; }
    .token-number { color: #79c0ff; }
    .token-function { color: #d2a8ff; }
    .token-operator { color: #ff7b72; }
    .token-punctuation { color: #c9d1d9; }

    /* ===== Streaming Code View ===== */
    .streaming-code-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .streaming-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: var(--c-bg-header, #161b22);
      border-bottom: 1px solid var(--c-border-ide, #30363d);
    }

    .streaming-header__left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .streaming-header__file {
      font-family: var(--font-mono, 'SF Mono', Consolas, monospace);
      font-size: 12px;
      color: var(--c-text, #c9d1d9);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .streaming-header__lang {
      font-size: 10px;
      padding: 2px 8px;
      background: linear-gradient(135deg, var(--c-accent, #f0b429), #ff6b6b);
      border-radius: 4px;
      color: white;
      font-weight: 600;
      text-transform: uppercase;
    }

    .streaming-stats {
      display: flex;
      gap: 16px;
      font-size: 11px;
      font-family: var(--font-mono, 'SF Mono', Consolas, monospace);
    }

    .streaming-stat {
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--c-muted, #8b949e);
    }

    .streaming-stat__value {
      color: var(--c-accent, #f0b429);
      font-weight: 600;
    }

    .streaming-progress {
      height: 3px;
      background: var(--c-bg-code, #0d1117);
      overflow: hidden;
    }

    .streaming-progress__fill {
      height: 100%;
      background: linear-gradient(90deg, var(--c-accent, #f0b429), #ff6b6b, var(--c-accent, #f0b429));
      background-size: 200% 100%;
      animation: progressGlow 1.5s ease-in-out infinite;
      transition: width 0.1s ease;
    }

    @keyframes progressGlow {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    .streaming-editor {
      display: flex;
      flex: 1;
      overflow: hidden;
      background: var(--c-bg-code, #0d1117);
    }

    .streaming-line-numbers {
      padding: 12px 0;
      min-width: 50px;
      text-align: right;
      color: var(--c-line-number, #6e7681);
      font-family: var(--font-mono, 'SF Mono', Consolas, monospace);
      font-size: 12px;
      line-height: 1.6;
      background: rgba(0, 0, 0, 0.2);
      border-right: 1px solid var(--c-border-ide, #30363d);
      user-select: none;
    }

    .streaming-line-numbers__line {
      padding-right: 12px;
      height: 19.2px;
    }

    .streaming-code-content {
      flex: 1;
      padding: 12px 16px;
      font-family: var(--font-mono, 'SF Mono', Consolas, monospace);
      font-size: 12px;
      line-height: 1.6;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-all;
      position: relative;
    }

    .streaming-cursor {
      display: inline-block;
      width: 2px;
      height: 16px;
      background: var(--c-accent, #f0b429);
      margin-left: 1px;
      vertical-align: text-bottom;
      animation: cursorBlink 1s infinite;
      box-shadow: 0 0 8px var(--c-accent, #f0b429), 0 0 16px rgba(240, 180, 41, 0.4);
    }

    @keyframes cursorBlink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0; }
    }

    .streaming-code-line {
      display: block;
      min-height: 19.2px;
    }

    .streaming-code-line.current {
      background: rgba(240, 180, 41, 0.08);
      border-radius: 2px;
      margin: 0 -8px;
      padding: 0 8px;
    }

    /* Status bar at bottom */
    .streaming-status-bar {
      display: flex;
      justify-content: space-between;
      padding: 6px 14px;
      background: var(--c-accent, #f0b429);
      font-size: 11px;
      color: #0d1117;
      font-weight: 500;
    }

    .streaming-status-bar__left,
    .streaming-status-bar__right {
      display: flex;
      gap: 16px;
    }

    .streaming-status-bar__item {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .streaming-status-bar__dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #0d1117;
      animation: statusPulse 1s infinite;
    }

    @keyframes statusPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.2); }
    }

    /* Thinking indicator */
    .thinking-overlay {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px;
      gap: 16px;
    }

    .thinking-dots {
      display: flex;
      gap: 6px;
    }

    .thinking-dots span {
      width: 10px;
      height: 10px;
      background: var(--c-accent, #f0b429);
      border-radius: 50%;
      animation: thinkingBounce 1.4s ease-in-out infinite;
    }

    .thinking-dots span:nth-child(1) { animation-delay: 0s; }
    .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
    .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes thinkingBounce {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; }
      40% { transform: scale(1); opacity: 1; }
    }

    .thinking-text {
      color: var(--c-muted, #8b949e);
      font-size: 13px;
      font-style: italic;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.startElapsedTimer();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopElapsedTimer();
    this.stopTypingAnimation();
  }

  updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    
    // Handle streaming code changes
    if (changedProperties.has("streamingCode") && this.streamingCode !== this.lastStreamingCode) {
      this.handleStreamingCodeChange();
    }
  }

  private handleStreamingCodeChange() {
    const newCode = this.streamingCode;
    const oldLength = this.lastStreamingCode.length;
    const newLength = newCode.length;
    
    if (newLength > oldLength) {
      // New code added - animate typing
      this.lastStreamingCode = newCode;
      this.animateNewCode(oldLength, newLength);
    } else if (newLength === 0) {
      // Reset
      this.displayedCode = "";
      this.typingIndex = 0;
      this.lastStreamingCode = "";
      this.streamStats = { chars: 0, lines: 0, tokensPerSec: 0 };
      this.cursorPosition = { line: 1, col: 1 };
    }
  }

  private animateNewCode(fromIndex: number, toIndex: number) {
    // For real-time streaming, show immediately (no delay)
    // but still update stats
    this.displayedCode = this.streamingCode.slice(0, toIndex);
    this.typingIndex = toIndex;
    
    // Update stats
    const elapsed = this.streamingStartTime > 0 
      ? (Date.now() - this.streamingStartTime) / 1000 
      : 1;
    const lines = this.displayedCode.split("\n").length;
    const chars = this.displayedCode.length;
    
    this.streamStats = {
      chars,
      lines,
      tokensPerSec: Math.round(chars / elapsed / 4), // ~4 chars per token
    };
    
    // Update cursor position
    const codeLines = this.displayedCode.split("\n");
    this.cursorPosition = {
      line: codeLines.length,
      col: (codeLines[codeLines.length - 1]?.length || 0) + 1,
    };
    
    // Auto-scroll to bottom
    this.scrollToBottom();
  }

  private scrollToBottom() {
    requestAnimationFrame(() => {
      const content = this.shadowRoot?.querySelector(".streaming-code-content");
      if (content) {
        content.scrollTop = content.scrollHeight;
      }
    });
  }

  private stopTypingAnimation() {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  private startElapsedTimer() {
    this.stopElapsedTimer();
    this.elapsedInterval = window.setInterval(() => {
      this.elapsedTime = Date.now();
    }, 100);
  }

  private stopElapsedTimer() {
    if (this.elapsedInterval) {
      clearInterval(this.elapsedInterval);
      this.elapsedInterval = null;
    }
  }

  private toggleCollapsed() {
    this.collapsed = !this.collapsed;
    this.dispatchEvent(new CustomEvent("toggle-collapsed", { detail: { collapsed: this.collapsed } }));
  }

  private setActiveTab(tab: "activity" | "code" | "files" | "streaming") {
    this.activeTab = tab;
  }

  private toggleExpanded(id: string) {
    if (this.expandedIds.has(id)) {
      this.expandedIds.delete(id);
    } else {
      this.expandedIds.add(id);
    }
    this.requestUpdate();
  }

  private get runningCount(): number {
    return this.executions.filter((e) => e.status === "running").length;
  }

  private get completedCount(): number {
    return this.executions.filter((e) => e.status === "complete").length;
  }

  private get errorCount(): number {
    return this.executions.filter((e) => e.status === "error").length;
  }

  private get latestCodeExecution(): ToolExecution | undefined {
    return [...this.executions]
      .reverse()
      .find((e) => e.filePath || e.code || e.diff);
  }

  render() {
    const isActive = this.streaming || this.runningCount > 0;
    const hasExecutions = this.executions.length > 0;
    const hasFiles = this.files.length > 0;
    const hasStreamingCode = this.streamingCode.length > 0;

    if (!hasExecutions && !hasFiles && !this.streaming && !hasStreamingCode) {
      return nothing;
    }

    // Auto-switch to streaming tab when streaming code starts
    const effectiveTab = hasStreamingCode && this.streaming ? "streaming" : this.activeTab;

    return html`
      <div class="ai-ide ${this.collapsed ? "collapsed" : ""} ${isActive ? "streaming" : ""}">
        ${this.renderHeader(isActive)}
        ${!this.collapsed ? html`
          ${this.renderTabs(hasStreamingCode)}
          <div class="ide-content">
            ${effectiveTab === "activity" ? this.renderActivityView() : nothing}
            ${effectiveTab === "code" ? this.renderCodeView() : nothing}
            ${effectiveTab === "streaming" ? this.renderStreamingCodeView() : nothing}
            ${effectiveTab === "files" ? this.renderFilesView() : nothing}
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderHeader(isActive: boolean) {
    return html`
      <div class="ide-header" @click=${this.toggleCollapsed}>
        <div class="ide-header__left">
          <div class="ide-header__status">
            <span class="status-dot ${isActive ? "active" : ""}"></span>
            <span>${isActive ? "Working" : "Idle"}</span>
          </div>
          <div class="ide-header__stats">
            ${this.runningCount > 0 ? html`
              <span class="ide-header__stat">
                <span class="spinner"></span>
                ${this.runningCount} running
              </span>
            ` : nothing}
            ${this.completedCount > 0 ? html`
              <span class="ide-header__stat">✓ ${this.completedCount}</span>
            ` : nothing}
            ${this.errorCount > 0 ? html`
              <span class="ide-header__stat" style="color: var(--c-error)">✗ ${this.errorCount}</span>
            ` : nothing}
          </div>
        </div>
        <div class="ide-header__actions">
          <button class="ide-btn" title="${this.collapsed ? "Expand" : "Collapse"}">
            ${this.collapsed ? "▼" : "▲"}
          </button>
        </div>
      </div>
    `;
  }

  private renderTabs(hasStreamingCode: boolean = false) {
    const codeExec = this.latestCodeExecution;
    const isStreamingActive = hasStreamingCode && this.streaming;
    return html`
      <div class="ide-tabs">
        ${isStreamingActive ? html`
          <button 
            class="ide-tab active"
            style="background: linear-gradient(135deg, rgba(240, 180, 41, 0.2), rgba(255, 107, 107, 0.2)); border: 1px solid var(--c-accent);"
          >
            <span style="animation: pulse 1s infinite;">🔥</span> Generating
            <span class="ide-tab__badge" style="background: var(--c-accent); color: #0d1117;">${this.streamStats.lines}</span>
          </button>
        ` : html`
          <button 
            class="ide-tab ${this.activeTab === "activity" ? "active" : ""}"
            @click=${() => this.setActiveTab("activity")}
          >
            ⚡ Activity
            ${this.executions.length > 0 ? html`
              <span class="ide-tab__badge">${this.executions.length}</span>
            ` : nothing}
          </button>
        `}
        ${codeExec && !isStreamingActive ? html`
          <button 
            class="ide-tab ${this.activeTab === "code" ? "active" : ""}"
            @click=${() => this.setActiveTab("code")}
          >
            📝 Code
          </button>
        ` : nothing}
        ${this.files.length > 0 ? html`
          <button 
            class="ide-tab ${this.activeTab === "files" ? "active" : ""}"
            @click=${() => this.setActiveTab("files")}
          >
            📁 Files
            <span class="ide-tab__badge">${this.files.length}</span>
          </button>
        ` : nothing}
      </div>
    `;
  }

  private renderActivityView() {
    if (this.executions.length === 0) {
      return html`
        <div class="empty-state">
          <div class="empty-state__icon">⚡</div>
          <div class="empty-state__text">No activity yet</div>
        </div>
      `;
    }

    return html`
      <div class="activity-list">
        ${repeat(
          [...this.executions].reverse(),
          (exec) => exec.id,
          (exec) => this.renderActivityItem(exec)
        )}
      </div>
    `;
  }

  private renderActivityItem(exec: ToolExecution) {
    const isExpanded = this.expandedIds.has(exec.id);
    const elapsed = exec.completedAt
      ? formatDuration(exec.completedAt - exec.startedAt)
      : formatElapsed(exec.startedAt);
    const detail = exec.filePath
      ? shortenPath(exec.filePath)
      : exec.args
        ? this.formatArgsPreview(exec.args)
        : null;

    return html`
      <div 
        class="activity-item ${exec.status}"
        @click=${() => this.toggleExpanded(exec.id)}
      >
        <div class="activity-item__icon">
          ${exec.status === "running" ? html`<span class="spinner"></span>` : getToolIcon(exec.name)}
        </div>
        <div class="activity-item__content">
          <div class="activity-item__header">
            <span class="activity-item__name">${exec.displayName || getToolDisplayName(exec.name)}</span>
            <span class="activity-item__status ${exec.status}">
              ${exec.status === "running" ? elapsed : nothing}
              ${exec.status === "complete" ? html`✓ ${elapsed}` : nothing}
              ${exec.status === "error" ? html`✗ Failed` : nothing}
              ${exec.status === "pending" ? "Pending" : nothing}
            </span>
          </div>
          ${detail ? html`
            <div class="activity-item__detail">
              <code>${detail}</code>
            </div>
          ` : nothing}
          ${isExpanded ? this.renderActivityDetail(exec) : nothing}
        </div>
      </div>
    `;
  }

  private renderActivityDetail(exec: ToolExecution) {
    return html`
      <div class="activity-detail">
        ${exec.args ? html`
          <div class="activity-detail__section">
            <div class="activity-detail__label">Parameters</div>
            <div class="activity-detail__code">${JSON.stringify(exec.args, null, 2)}</div>
          </div>
        ` : nothing}
        ${exec.result ? html`
          <div class="activity-detail__section">
            <div class="activity-detail__label">Result</div>
            <div class="activity-detail__code">${exec.result.slice(0, 1000)}${exec.result.length > 1000 ? "..." : ""}</div>
          </div>
        ` : nothing}
        ${exec.error ? html`
          <div class="activity-detail__section">
            <div class="activity-detail__label">Error</div>
            <div class="activity-detail__code" style="color: var(--c-error)">${exec.error}</div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private formatArgsPreview(args: Record<string, unknown>): string {
    const keys = Object.keys(args);
    if (keys.length === 0) return "";
    const first = keys[0];
    const value = args[first];
    if (typeof value === "string") {
      return value.length > 50 ? value.slice(0, 47) + "..." : value;
    }
    return `${first}: ${JSON.stringify(value).slice(0, 40)}`;
  }

  private renderCodeView() {
    const exec = this.latestCodeExecution;
    if (!exec) {
      return html`
        <div class="empty-state">
          <div class="empty-state__icon">📝</div>
          <div class="empty-state__text">No code changes yet</div>
        </div>
      `;
    }

    const lang = exec.language || detectLanguage(exec.filePath);
    const code = exec.code || "";
    const lines = code.split("\n");

    return html`
      <div class="code-panel">
        <div class="code-header">
          <div class="code-header__path">
            📄 ${exec.filePath ? shortenPath(exec.filePath, 60) : "Untitled"}
          </div>
          <span class="code-header__lang">${lang}</span>
        </div>
        <div class="code-viewer">
          ${exec.diff ? this.renderDiff(exec.diff) : this.renderCodeLines(lines)}
        </div>
      </div>
    `;
  }

  private renderCodeLines(lines: string[]) {
    return lines.map((line, i) => html`
      <div class="code-line">
        <span class="code-line__number">${i + 1}</span>
        <span class="code-line__content">${line || " "}</span>
      </div>
    `);
  }

  private renderDiff(diff: CodeDiff) {
    const allLines: Array<{ type: string; content: string; num?: number }> = [];
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        allLines.push({
          type: line.type,
          content: line.content,
          num: line.lineNumber,
        });
      }
    }

    return allLines.map((line) => html`
      <div class="code-line ${line.type === "add" ? "added" : line.type === "remove" ? "removed" : ""}">
        <span class="code-line__number">${line.num || ""}</span>
        <span class="code-line__marker">
          ${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
        </span>
        <span class="code-line__content">${line.content || " "}</span>
      </div>
    `);
  }

  private renderFilesView() {
    if (this.files.length === 0) {
      return html`
        <div class="empty-state">
          <div class="empty-state__icon">📁</div>
          <div class="empty-state__text">No file operations</div>
        </div>
      `;
    }

    const opIcons: Record<string, string> = {
      create: "➕",
      modify: "✏️",
      delete: "🗑️",
      read: "👁️",
    };

    return html`
      <div class="files-tree">
        ${repeat(
          [...this.files].reverse(),
          (f, i) => `${f.path}-${i}`,
          (f) => html`
            <div class="file-item">
              <span class="file-item__icon ${f.operation}">${opIcons[f.operation] || "📄"}</span>
              <span class="file-item__path">${shortenPath(f.path, 50)}</span>
              <span class="file-item__time">${formatElapsed(f.timestamp)}</span>
            </div>
          `
        )}
      </div>
    `;
  }

  // ================================================================
  // Streaming Code View — Animated IDE-style code generation
  // ================================================================

  private renderStreamingCodeView() {
    const lang = detectLanguage(this.streamingFilePath);
    const elapsed = this.streamingStartTime > 0 
      ? ((Date.now() - this.streamingStartTime) / 1000).toFixed(1)
      : "0.0";
    
    // If we're streaming but no code yet, show thinking indicator
    if (this.streaming && this.displayedCode.length === 0) {
      return html`
        <div class="streaming-code-panel">
          <div class="streaming-header">
            <div class="streaming-header__left">
              <div class="streaming-header__file">
                <span>🔥</span>
                <span>Initializing...</span>
              </div>
            </div>
          </div>
          <div class="thinking-overlay">
            <div class="thinking-dots">
              <span></span><span></span><span></span>
            </div>
            <div class="thinking-text">AI is thinking...</div>
          </div>
        </div>
      `;
    }

    const codeLines = this.displayedCode.split("\n");
    const highlightedLines = codeLines.map((line, idx) => 
      this.highlightSyntax(line, idx === codeLines.length - 1)
    );

    return html`
      <div class="streaming-code-panel">
        <!-- Header with file info and stats -->
        <div class="streaming-header">
          <div class="streaming-header__left">
            <div class="streaming-header__file">
              <span>📄</span>
              <span>${this.streamingFilePath ? shortenPath(this.streamingFilePath, 40) : "Generating..."}</span>
            </div>
            <span class="streaming-header__lang">${lang}</span>
          </div>
          <div class="streaming-stats">
            <div class="streaming-stat">
              <span class="streaming-stat__value">${this.streamStats.tokensPerSec}</span>
              <span>tok/s</span>
            </div>
            <div class="streaming-stat">
              <span class="streaming-stat__value">${this.streamStats.lines}</span>
              <span>lines</span>
            </div>
            <div class="streaming-stat">
              <span class="streaming-stat__value">${elapsed}s</span>
              <span>elapsed</span>
            </div>
          </div>
        </div>

        <!-- Progress bar -->
        <div class="streaming-progress">
          <div class="streaming-progress__fill" style="width: 100%;"></div>
        </div>

        <!-- Code editor area -->
        <div class="streaming-editor">
          <div class="streaming-line-numbers">
            ${codeLines.map((_, i) => html`
              <div class="streaming-line-numbers__line">${i + 1}</div>
            `)}
          </div>
          <div class="streaming-code-content">
            ${highlightedLines.map((lineHtml, idx) => html`
              <span class="streaming-code-line ${idx === codeLines.length - 1 ? 'current' : ''}">
                ${unsafeHTML(lineHtml)}${idx === codeLines.length - 1 && this.streaming ? html`<span class="streaming-cursor"></span>` : nothing}
              </span>
            `)}
          </div>
        </div>

        <!-- Status bar -->
        <div class="streaming-status-bar">
          <div class="streaming-status-bar__left">
            <span class="streaming-status-bar__item">
              <span class="streaming-status-bar__dot"></span>
              <span>${this.streaming ? "Generating" : "Complete"}</span>
            </span>
            <span class="streaming-status-bar__item">
              Ln ${this.cursorPosition.line}, Col ${this.cursorPosition.col}
            </span>
          </div>
          <div class="streaming-status-bar__right">
            <span class="streaming-status-bar__item">${lang.toUpperCase()}</span>
            <span class="streaming-status-bar__item">${this.streamStats.chars} chars</span>
          </div>
        </div>
      </div>
    `;
  }

  // Basic syntax highlighting for streaming code
  private highlightSyntax(line: string, isCurrent: boolean): string {
    // Keywords
    const keywords = ['import', 'export', 'from', 'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'extends', 'implements', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'new', 'this', 'async', 'await', 'try', 'catch', 'throw', 'default', 'typeof', 'instanceof', 'true', 'false', 'null', 'undefined', 'void', 'private', 'public', 'protected', 'static', 'readonly', 'enum', 'namespace', 'module', 'declare', 'abstract', 'as', 'is', 'in', 'of', 'with', 'yield', 'delete', 'super', 'debugger', 'finally', 'get', 'set'];

    let escaped = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Strings (single/double quotes)
    escaped = escaped.replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, '<span class="token-string">$&</span>');
    
    // Comments
    escaped = escaped.replace(/(\/\/.*$)/g, '<span class="token-comment">$1</span>');
    
    // Numbers
    escaped = escaped.replace(/\b(\d+\.?\d*)\b/g, '<span class="token-number">$1</span>');
    
    // Functions (word followed by parenthesis)
    escaped = escaped.replace(/\b([a-zA-Z_]\w*)\s*(?=\()/g, '<span class="token-function">$1</span>');
    
    // Keywords
    for (const kw of keywords) {
      const regex = new RegExp(`\\b(${kw})\\b`, 'g');
      escaped = escaped.replace(regex, '<span class="token-keyword">$1</span>');
    }

    return escaped || ' '; // Ensure empty lines have content
  }
}

// Export helper to create executions from tool calls
export function createToolExecution(
  name: string,
  args?: Record<string, unknown>,
): ToolExecution {
  return {
    id: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name,
    displayName: getToolDisplayName(name),
    icon: getToolIcon(name),
    status: "running",
    startedAt: Date.now(),
    args,
    filePath: extractFilePath(name, args),
    language: detectLanguage(extractFilePath(name, args)),
  };
}

function extractFilePath(name: string, args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  const pathKeys = ["path", "file_path", "filePath", "file"];
  for (const key of pathKeys) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return undefined;
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-ide-panel": AIIDEPanel;
  }
}
