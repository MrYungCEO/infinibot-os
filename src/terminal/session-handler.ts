/**
 * Terminal Session Handler
 * Manages terminal session persistence and restoration
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import type { TerminalProcess, TerminalSession, SessionDateInfo } from "./types.js";

const SESSION_DIR = join(process.cwd(), "state", "terminals");

/**
 * Ensure session directory exists
 */
function ensureSessionDir(): void {
  if (!existsSync(SESSION_DIR)) {
    mkdirSync(SESSION_DIR, { recursive: true });
  }
}

/**
 * Get session file path for a project/agent
 */
function getSessionFilePath(projectPath?: string, agentId?: string): string {
  ensureSessionDir();

  // Create a safe filename from project path and agent ID
  const safeName = projectPath ? projectPath.replace(/[^a-zA-Z0-9]/g, "_") : "default";
  const agentSuffix = agentId ? `_${agentId}` : "";

  return join(SESSION_DIR, `${safeName}${agentSuffix}.json`);
}

/**
 * Convert terminal process to session data
 */
export function terminalToSession(terminal: TerminalProcess): TerminalSession {
  return {
    id: terminal.id,
    title: terminal.title,
    cwd: terminal.cwd,
    createdAt: terminal.createdAt.toISOString(),
    lastActiveAt: new Date().toISOString(),
    projectPath: terminal.projectPath,
    agentId: terminal.agentId,
    sessionKey: terminal.sessionKey,
    displayOrder: terminal.displayOrder,
    outputBuffer: terminal.outputBuffer,
    isClaudeMode: terminal.isClaudeMode,
    claudeSessionId: terminal.claudeSessionId,
    worktreeConfig: terminal.worktreeConfig,
    // Include cliType so the UI can re-pick the right CLI badge after a
    // page reload — without it, every restored terminal renders as "shell".
    ...((terminal as TerminalProcess & { cliType?: string }).cliType
      ? { cliType: (terminal as TerminalProcess & { cliType?: string }).cliType }
      : {}),
  } as TerminalSession;
}

/**
 * Save terminal sessions to disk
 */
export function persistSessions(
  terminals: Map<string, TerminalProcess>,
  projectPath?: string,
  agentId?: string,
): void {
  ensureSessionDir();

  // Group terminals by project/agent
  const groups = new Map<string, TerminalProcess[]>();

  for (const terminal of terminals.values()) {
    const key = `${terminal.projectPath || "default"}_${terminal.agentId || ""}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(terminal);
  }

  // Save each group to its own file
  for (const [key, terminalList] of groups) {
    const firstTerminal = terminalList[0];
    const filePath = getSessionFilePath(firstTerminal.projectPath, firstTerminal.agentId);

    const sessions = terminalList.map(terminalToSession);

    try {
      writeFileSync(filePath, JSON.stringify(sessions, null, 2), "utf8");
    } catch (error) {
      console.error(`[session-handler] Error saving sessions to ${filePath}:`, error);
    }
  }
}

/**
 * Save a single terminal session asynchronously
 */
export async function persistSessionAsync(terminal: TerminalProcess): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        const filePath = getSessionFilePath(terminal.projectPath, terminal.agentId);

        // Load existing sessions
        let sessions: TerminalSession[] = [];
        if (existsSync(filePath)) {
          try {
            const data = readFileSync(filePath, "utf8");
            sessions = JSON.parse(data);
          } catch {
            sessions = [];
          }
        }

        // Update or add this terminal's session
        const sessionIndex = sessions.findIndex((s) => s.id === terminal.id);
        const newSession = terminalToSession(terminal);

        if (sessionIndex >= 0) {
          sessions[sessionIndex] = newSession;
        } else {
          sessions.push(newSession);
        }

        writeFileSync(filePath, JSON.stringify(sessions, null, 2), "utf8");
      } catch (error) {
        console.error(`[session-handler] Error saving session for terminal ${terminal.id}:`, error);
      }
      resolve();
    }, 0);
  });
}

/**
 * Save all terminal sessions asynchronously
 */
export async function persistAllSessionsAsync(
  terminals: Map<string, TerminalProcess>,
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      persistSessions(terminals);
      resolve();
    }, 0);
  });
}

/**
 * Load terminal sessions from disk
 */
export function getSavedSessions(projectPath?: string, agentId?: string): TerminalSession[] {
  const filePath = getSessionFilePath(projectPath, agentId);

  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const data = readFileSync(filePath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error(`[session-handler] Error loading sessions from ${filePath}:`, error);
    return [];
  }
}

/**
 * Clear saved sessions for a project/agent
 */
export function clearSavedSessions(projectPath?: string, agentId?: string): void {
  const filePath = getSessionFilePath(projectPath, agentId);

  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
    } catch (error) {
      console.error(`[session-handler] Error clearing sessions from ${filePath}:`, error);
    }
  }
}

/**
 * Remove a single persisted session
 */
export function removePersistedSession(terminal: TerminalProcess): void {
  const filePath = getSessionFilePath(terminal.projectPath, terminal.agentId);

  if (!existsSync(filePath)) {
    return;
  }

  try {
    const data = readFileSync(filePath, "utf8");
    let sessions: TerminalSession[] = JSON.parse(data);

    // Remove this terminal's session
    sessions = sessions.filter((s) => s.id !== terminal.id);

    // Write back the updated sessions
    if (sessions.length > 0) {
      writeFileSync(filePath, JSON.stringify(sessions, null, 2), "utf8");
    } else {
      // If no sessions left, delete the file
      unlinkSync(filePath);
    }
  } catch (error) {
    console.error(`[session-handler] Error removing session for terminal ${terminal.id}:`, error);
  }
}

/**
 * Get available session dates
 */
export function getAvailableSessionDates(projectPath?: string): SessionDateInfo[] {
  ensureSessionDir();

  try {
    const files = readdirSync(SESSION_DIR);
    const dateMap = new Map<string, { count: number; projectPaths: Set<string> }>();

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const filePath = join(SESSION_DIR, file);
      try {
        const data = readFileSync(filePath, "utf8");
        const sessions: TerminalSession[] = JSON.parse(data);

        for (const session of sessions) {
          // Extract date from createdAt (YYYY-MM-DD)
          const date = session.createdAt.split("T")[0];

          if (!dateMap.has(date)) {
            dateMap.set(date, { count: 0, projectPaths: new Set() });
          }

          const dateInfo = dateMap.get(date)!;
          dateInfo.count++;
          if (session.projectPath) {
            dateInfo.projectPaths.add(session.projectPath);
          }
        }
      } catch {
        // Skip invalid files
      }
    }

    // Convert to SessionDateInfo array with human-readable labels
    const dates: SessionDateInfo[] = [];
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

    for (const [date, info] of dateMap) {
      let label: string;
      if (date === today) {
        label = "Today";
      } else if (date === yesterday) {
        label = "Yesterday";
      } else {
        // Format as "Dec 10"
        const dateObj = new Date(date);
        label = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      }

      dates.push({
        date,
        label,
        sessionCount: info.count,
        projectCount: info.projectPaths.size,
      });
    }

    // Sort by date descending (newest first)
    dates.sort((a, b) => b.date.localeCompare(a.date));

    return dates;
  } catch (error) {
    console.error("[session-handler] Error getting session dates:", error);
    return [];
  }
}

/**
 * Get sessions for a specific date
 */
export function getSessionsForDate(
  date: string,
  projectPath?: string,
  agentId?: string,
): TerminalSession[] {
  const sessions = getSavedSessions(projectPath, agentId);
  return sessions.filter((s) => s.createdAt.startsWith(date));
}

/**
 * Scan every persisted session file and return the union of all known
 * terminal ids. Used by tmux reconciliation on startup to spot orphan
 * sessions (live in tmux but missing from any file).
 */
export function getAllPersistedSessionIds(): Set<string> {
  ensureSessionDir();
  const ids = new Set<string>();
  try {
    for (const file of readdirSync(SESSION_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = readFileSync(join(SESSION_DIR, file), "utf8");
        const sessions: TerminalSession[] = JSON.parse(data);
        for (const s of sessions) ids.add(s.id);
      } catch {
        // Skip unreadable / malformed files.
      }
    }
  } catch (error) {
    console.error("[session-handler] Error scanning persisted sessions:", error);
  }
  return ids;
}

/**
 * Append a single session record to the "default" bucket. Used to adopt
 * orphan tmux sessions discovered at startup so the user can see and
 * restore them via the normal UI list.
 */
export function adoptOrphanSession(session: TerminalSession): void {
  ensureSessionDir();
  const filePath = getSessionFilePath(undefined, undefined);
  let sessions: TerminalSession[] = [];
  if (existsSync(filePath)) {
    try {
      sessions = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      sessions = [];
    }
  }
  if (sessions.some((s) => s.id === session.id)) return;
  sessions.push(session);
  try {
    writeFileSync(filePath, JSON.stringify(sessions, null, 2), "utf8");
  } catch (error) {
    console.error("[session-handler] Error adopting orphan session:", error);
  }
}

/**
 * Update display orders for terminals
 */
export function updateDisplayOrders(
  projectPath: string | undefined,
  agentId: string | undefined,
  orders: Array<{ terminalId: string; displayOrder: number }>,
): void {
  const sessions = getSavedSessions(projectPath, agentId);

  // Update display orders
  for (const order of orders) {
    const session = sessions.find((s) => s.id === order.terminalId);
    if (session) {
      session.displayOrder = order.displayOrder;
    }
  }

  // Save updated sessions
  const filePath = getSessionFilePath(projectPath, agentId);
  try {
    writeFileSync(filePath, JSON.stringify(sessions, null, 2), "utf8");
  } catch (error) {
    console.error(`[session-handler] Error updating display orders:`, error);
  }
}
