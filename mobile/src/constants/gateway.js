// Gateway WebSocket protocol constants
export const PROTOCOL_VERSION = 3;

// No hardcoded LAN default — the gateway IP is machine-specific and the old
// hardcoded LAN default pointed at the wrong host AND the wrong port
// (the gateway serves WebSocket on 18789, not 47913). Leave this empty so the
// AuthScreen forces the user to enter their gateway URL on first run.
export const DEFAULT_GATEWAY_URL = '';

// Canonical WebSocket port the gateway listens on. Used for URL placeholders
// and the "Detect on LAN" probe candidates.
export const GATEWAY_WS_PORT = 18789;

// Default session key (fallback only - use getDeviceSessionKey() for device-specific sessions)
// DEPRECATED: Use getDeviceSessionKey() from storage.js for proper session isolation
export const SESSION_KEY = 'webchat';

// Client identity
export const CLIENT_INFO = {
  id: 'webchat',
  version: '1.0.0',
  platform: 'mobile',
  mode: 'webchat',
};

// Frame types
export const FRAME = {
  REQ: 'req',
  RES: 'res',
  EVENT: 'event',
};

// Methods
export const METHOD = {
  CONNECT: 'connect',
  CHAT_SEND: 'chat.send',
  CHAT_HISTORY: 'chat.history',
  CHAT_ABORT: 'chat.abort',
  // Sessions
  SESSIONS_LIST: 'sessions.list',
  SESSIONS_HISTORY: 'sessions.history',
  SESSIONS_PATCH: 'sessions.patch',
  SESSIONS_DELETE: 'sessions.delete',
  // Kanban
  KANBAN_PROJECTS_LIST: 'kanban.projects.list',
  KANBAN_TASKS_LIST: 'kanban.tasks.list',
  KANBAN_TASKS_CREATE: 'kanban.tasks.create',
  KANBAN_TASKS_UPDATE: 'kanban.tasks.update',
  // Notion
  NOTION_QUERY: 'notion.query',
  NOTION_DB_QUERY: 'notion.databases.query',
  NOTION_CREATE: 'notion.create',
  NOTION_UPDATE: 'notion.update',
  // Notes
  NOTES_LIST: 'notes.list',
  NOTES_GET: 'notes.get',
  NOTES_CREATE: 'notes.create',
  NOTES_UPDATE: 'notes.update',
  NOTES_DELETE: 'notes.delete',
  // Agents
  AGENTS_LIST: 'agents.management.list',
  // Config
  CONFIG_GET: 'config.get',
  CONFIG_PATCH: 'config.patch',
  // Cron
  CRON_LIST: 'cron.list',
  CRON_ADD: 'cron.add',
  CRON_UPDATE: 'cron.update',
  CRON_REMOVE: 'cron.remove',
  // Terminal (PTY) — mirrors the web terminals page contract
  TERMINAL_LIST: 'terminal.list',
  TERMINAL_CREATE: 'terminal.create',
  TERMINAL_DESTROY: 'terminal.destroy',
  TERMINAL_WRITE: 'terminal.write',
  TERMINAL_RESIZE: 'terminal.resize',
  TERMINAL_IS_ALIVE: 'terminal.isAlive',
  TERMINAL_GET_BUFFER: 'terminal.getBuffer',
  TERMINAL_AGENT_INVOKE: 'terminal.agent.invoke',
  TERMINAL_ASSISTANT_STREAM_START: 'terminal.assistantStream.start',
  TERMINAL_ASSISTANT_STREAM_STOP: 'terminal.assistantStream.stop',
};

// Events
export const EVENT = {
  CONNECT_CHALLENGE: 'connect.challenge',
  CHAT: 'chat',
  TICK: 'tick',
  SHUTDOWN: 'shutdown',
  TERMINAL_OUTPUT: 'terminal.output',
  TERMINAL_EXIT: 'terminal.exit',
  ASSISTANT_TEXT_DELTA: 'assistant.text.delta',
};

// Chat states
export const CHAT_STATE = {
  DELTA: 'delta',
  FINAL: 'final',
  ABORTED: 'aborted',
  ERROR: 'error',
};
