/**
 * AI IDE Controller — Manages state for the AI IDE panel
 * Extracts tool executions from messages and tracks file operations
 */

import type {
  ToolExecution,
  FileOperation,
  CodeDiff,
  DiffHunk,
  DiffLine,
} from "../components/ai-ide-panel";

export interface AIIDEControllerState {
  executions: ToolExecution[];
  files: FileOperation[];
  streaming: boolean;
  collapsed: boolean;
  enabled: boolean;
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read: "Read File",
  Read: "Read File",
  write: "Write File",
  Write: "Write File",
  edit: "Edit File",
  Edit: "Edit File",
  exec: "Execute Command",
  browser: "Browser Control",
  web_search: "Web Search",
  web_fetch: "Fetch URL",
  kanban: "Kanban Board",
  cron: "Schedule Task",
  message: "Send Message",
  notes: "Notes",
  research: "Research",
  workflows: "Workflows",
  memory_search: "Search Memory",
  memory_get: "Get Memory",
  vision: "Vision Analysis",
  tts: "Text to Speech",
  image: "Analyze Image",
  sessions_spawn: "Spawn Agent",
  sessions_send: "Send to Session",
  sessions_list: "List Sessions",
  sessions_history: "Session History",
  session_status: "Session Status",
  process: "Manage Process",
  nodes: "Node Control",
  canvas: "Canvas",
  gateway: "Gateway",
  budget: "Budget Check",
  agents_list: "List Agents",
  whatsapp_login: "WhatsApp Login",
};

const TOOL_ICONS: Record<string, string> = {
  read: "📄",
  Read: "📄",
  write: "✏️",
  Write: "✏️",
  edit: "🔧",
  Edit: "🔧",
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
  sessions_list: "📋",
  sessions_history: "📜",
  session_status: "📊",
  process: "⚙️",
  nodes: "📡",
  canvas: "🎨",
  gateway: "🔌",
  budget: "💰",
  agents_list: "👥",
  whatsapp_login: "📱",
};

/**
 * Extract tool executions from chat messages
 */
export function extractToolExecutions(messages: unknown[]): ToolExecution[] {
  const executions: ToolExecution[] = [];
  const executionMap = new Map<string, ToolExecution>();

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const content = m.content;
    const timestamp = (m.timestamp as number) || Date.now();

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        const type = String(b.type || "").toLowerCase();

        // Tool calls
        if (
          type === "tool_use" ||
          type === "tooluse" ||
          type === "tool_call" ||
          type === "toolcall"
        ) {
          const id = (b.id as string) || (b.tool_call_id as string) || `exec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          const name = (b.name as string) || "unknown";
          const args = parseArgs(b.input ?? b.arguments ?? b.args);
          const filePath = extractFilePath(name, args);

          const exec: ToolExecution = {
            id,
            name,
            displayName: TOOL_DISPLAY_NAMES[name] || formatToolName(name),
            icon: TOOL_ICONS[name] || "🔧",
            status: "running",
            startedAt: timestamp,
            args,
            filePath,
            language: filePath ? detectLanguage(filePath) : undefined,
            code: extractCode(name, args),
          };

          executionMap.set(id, exec);
          executions.push(exec);
        }

        // Tool results
        if (type === "tool_result" || type === "toolresult") {
          const toolUseId = (b.tool_use_id as string) || (b.toolCallId as string) || (b.tool_call_id as string);
          const exec = toolUseId ? executionMap.get(toolUseId) : undefined;

          if (exec) {
            exec.status = b.is_error ? "error" : "complete";
            exec.completedAt = timestamp;
            exec.duration = timestamp - exec.startedAt;
            exec.result = extractResultText(b.content);
            if (b.is_error) {
              exec.error = exec.result;
            }
          }
        }
      }
    }

    // Handle standalone tool result messages
    const role = String(m.role || "").toLowerCase();
    if (role === "toolresult" || role === "tool_result" || role === "tool") {
      const toolCallId = (m.toolCallId as string) || (m.tool_call_id as string);
      const exec = toolCallId ? executionMap.get(toolCallId) : undefined;

      if (exec) {
        exec.status = "complete";
        exec.completedAt = timestamp;
        exec.duration = timestamp - exec.startedAt;
        exec.result = extractResultText(m.content);
      }
    }
  }

  return executions;
}

/**
 * Extract file operations from tool executions
 */
export function extractFileOperations(executions: ToolExecution[]): FileOperation[] {
  const files: FileOperation[] = [];
  const seenPaths = new Set<string>();

  for (const exec of executions) {
    if (!exec.filePath) continue;

    const operation = inferFileOperation(exec.name);
    if (!operation) continue;

    // Deduplicate by path + operation (keep most recent)
    const key = `${exec.filePath}:${operation}`;
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);

    files.push({
      path: exec.filePath,
      operation,
      timestamp: exec.startedAt,
    });
  }

  return files.sort((a, b) => b.timestamp - a.timestamp);
}

function inferFileOperation(toolName: string): FileOperation["operation"] | null {
  const name = toolName.toLowerCase();
  if (name === "write") return "create";
  if (name === "edit") return "modify";
  if (name === "read") return "read";
  return null;
}

function parseArgs(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not JSON
    }
  }
  return undefined;
}

function extractFilePath(toolName: string, args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  const pathKeys = ["path", "file_path", "filePath", "file"];
  for (const key of pathKeys) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return undefined;
}

function extractCode(toolName: string, args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  const name = toolName.toLowerCase();
  
  // For write operations, the content is the code
  if (name === "write") {
    const content = args.content;
    if (typeof content === "string") return content;
  }
  
  // For edit operations, extract newText
  if (name === "edit") {
    const newText = args.newText || args.new_string || args.newString;
    if (typeof newText === "string") return newText;
  }

  return undefined;
}

function extractResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        texts.push(item);
      } else if (item && typeof item === "object") {
        const block = item as Record<string, unknown>;
        if (typeof block.text === "string") {
          texts.push(block.text);
        }
      }
    }
    return texts.join("\n") || undefined;
  }
  return undefined;
}

function formatToolName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function detectLanguage(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const ext = filePath.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
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
    cs: "csharp",
    php: "php",
    html: "html",
    css: "css",
    scss: "scss",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    sql: "sql",
    sh: "bash",
    ps1: "powershell",
    xml: "xml",
  };
  return ext ? langMap[ext] : undefined;
}

/**
 * Parse streaming tool call from partial message
 */
export function parseStreamingToolCall(stream: string): Partial<ToolExecution> | null {
  // Look for tool call patterns in the stream
  // This handles the case where we're in the middle of a tool call

  // Pattern: <tool_call> or function_call blocks
  const toolCallMatch = stream.match(/<tool_call[^>]*>([\s\S]*?)(?:<\/tool_call>|$)/i);
  if (toolCallMatch) {
    const inner = toolCallMatch[1];
    const nameMatch = inner.match(/name["\s:]+["']?(\w+)/i);
    const name = nameMatch?.[1];
    if (name) {
      return {
        name,
        displayName: TOOL_DISPLAY_NAMES[name] || formatToolName(name),
        icon: TOOL_ICONS[name] || "🔧",
        status: "running",
        startedAt: Date.now(),
      };
    }
  }

  return null;
}

/**
 * Create the initial AI IDE state
 */
export function createAIIDEState(): AIIDEControllerState {
  return {
    executions: [],
    files: [],
    streaming: false,
    collapsed: loadCollapsedPreference(),
    enabled: loadEnabledPreference(),
  };
}

/**
 * Update AI IDE state from messages
 */
export function updateAIIDEState(
  state: AIIDEControllerState,
  messages: unknown[],
  streaming: boolean,
): AIIDEControllerState {
  const executions = extractToolExecutions(messages);
  const files = extractFileOperations(executions);

  return {
    ...state,
    executions,
    files,
    streaming,
  };
}

// Persistence helpers
const COLLAPSED_KEY = "infinibot.ai-ide.collapsed";
const ENABLED_KEY = "infinibot.ai-ide.enabled";

function loadCollapsedPreference(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveCollapsedPreference(collapsed: boolean) {
  try {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  } catch {
    // Ignore
  }
}

function loadEnabledPreference(): boolean {
  try {
    const value = localStorage.getItem(ENABLED_KEY);
    // Default to enabled
    return value === null ? true : value === "true";
  } catch {
    return true;
  }
}

export function saveEnabledPreference(enabled: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, String(enabled));
  } catch {
    // Ignore
  }
}
