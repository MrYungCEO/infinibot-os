/**
 * Chat panel refs — detection lives in src/shared/chat-panels/panel-ref.ts so
 * the gateway (group chats harvest member-run panels) and every UI surface use
 * the same parser. Re-exported here for the existing UI import paths.
 */
export * from "../../../../src/shared/chat-panels/panel-ref.js";
