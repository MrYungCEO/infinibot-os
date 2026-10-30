/**
 * Content Studio — the legacy RPC surface the `content-studio` plugin serves.
 *
 * The content studio (Content › Pages, Content › Intelligence, scripts,
 * viral formats, trends, socials, Instagram/ManyChat connect) is a
 * first-party plugin (extensions/content-studio). Its backend code still
 * compiles into core, but core no longer registers any of it: the plugin
 * registers every method below as `content-studio.*` and wires the legacy
 * name as an alias (manifest `contributes.rpcAliases`), so existing clients
 * (control UI, mobile, satellites) keep working while the plugin is enabled
 * and get "unknown method" when it is off.
 *
 * Scopes are the ones these methods had in core (READ_METHODS /
 * WRITE_METHODS in server-methods.ts); methods core never listed stay admin.
 * `content-studio.test.ts` keeps the plugin manifest in step with this table.
 */

export type ContentStudioScope = "read" | "write" | "admin";

/** Handler module (src/gateway/server-methods/<module>.ts) → legacy method → scope. */
export const CONTENT_STUDIO_LEGACY_METHODS = {
  "content-intel": {
    "content.intel.list": "admin",
    "content.intel.get": "admin",
    "content.intel.totals": "admin",
    "content.intel.insights": "admin",
    "content.intel.capabilities": "admin",
    "content.intel.score": "admin",
    "content.intel.scoreBatch": "admin",
    "content.intel.scoreBatchCancel": "admin",
    "content.intel.transcribeBatch": "admin",
    "content.intel.transcribeBatchCancel": "admin",
    "content.intel.stt.config": "admin",
    "content.intel.stt.setConfig": "admin",
    "content.intel.import": "admin",
    "content.intel.accounts": "admin",
    "content.intel.youtube.channels": "admin",
    "content.intel.youtube.list": "admin",
    "content.intel.youtube.import": "admin",
    "content.intel.youtube.fetch": "admin",
  },
  "viral-formats": {
    "viral.formats.taxonomy": "admin",
    "viral.formats.detectNiche": "admin",
    "viral.formats.watch": "admin",
    "viral.formats.topFormats": "admin",
    "viral.formats.benchmark": "admin",
    "viral.formats.score": "admin",
    "viral.formats.list": "admin",
    "viral.formats.stats": "admin",
  },
  "content-trends": {
    "content.trends.last30days": "read",
    "content.trends.refresh": "write",
    "content.trends.checkAlerts": "write",
    "content.trends.capabilities": "read",
  },
  socials: {
    "socials.sync": "admin",
    "socials.instagram.refreshToken": "admin",
    "socials.analytics.get": "admin",
    "socials.analytics.history": "admin",
    "socials.analytics.posts": "admin",
    "socials.analytics.daily": "admin",
    "socials.flows.list": "admin",
    "socials.flows.create": "admin",
    "socials.flows.test": "admin",
    "socials.flows.toggle": "admin",
    "socials.flows.stats": "admin",
    "socials.conversations.list": "admin",
    "socials.leads.list": "admin",
    "socials.messages.list": "admin",
    "socials.accounts.list": "admin",
    "socials.insights.analyze": "admin",
    "socials.insights.niche": "admin",
    "socials.insights.competitors": "admin",
    "socials.insights.recommendations": "admin",
    "socials.insights.engagement": "admin",
  },
  scripts: {
    "scripts.generate": "write",
    "scripts.generateAgentic": "write",
    "scripts.refine": "write",
    "scripts.parse": "read",
    "scripts.list": "read",
    "viralExamples.list": "admin",
    "viralExamples.get": "admin",
    "viralExamples.upsert": "admin",
    "viralExamples.delete": "admin",
    "viralExamples.retrieve": "admin",
    "viralExamples.search": "admin",
    "viralExamples.getStructure": "admin",
    "scripts.get": "read",
  },
  "content-pages": {
    "content.pages.list": "read",
    "content.pages.get": "read",
    "content.pages.create": "write",
    "content.pages.update": "write",
    "content.pages.delete": "write",
    "content.pages.stats": "read",
    "content.pages.stats.refresh": "admin",
    "content.pages.stats.subscribe": "admin",
    "content.pages.insights": "read",
    "content.pages.connections": "read",
    "content.pages.children.list": "read",
    "content.pages.children.create": "write",
    "content.pages.children.update": "write",
    "content.pages.children.delete": "write",
    "content.pages.features.set": "write",
    "content.pages.integrations.update": "write",
    "content.pages.link": "write",
    "content.pages.intel": "read",
    "content.pages.series.list": "read",
    "content.pages.series.upsert": "write",
    "content.pages.series.delete": "write",
    "content.pages.board": "read",
    "content.pages.stage.advance": "write",
  },
  instagram: {
    "instagram.setup.status": "admin",
    "instagram.setup.test": "admin",
    "instagram.setup.connect": "write",
    "instagram.setup.disconnect": "write",
    "instagram.setup.refresh": "write",
    "instagram.profile.get": "admin",
    "instagram.insights.get": "admin",
  },
  manychat: {
    "manychat.status": "admin",
    "manychat.connect": "admin",
    "manychat.disconnect": "admin",
    "manychat.flows.list": "admin",
    "manychat.trigger": "admin",
  },
} as const satisfies Record<string, Record<string, ContentStudioScope>>;

export type ContentStudioModule = keyof typeof CONTENT_STUDIO_LEGACY_METHODS;

export const CONTENT_STUDIO_PLUGIN_ID = "content-studio";

/**
 * Namespaced plugin method for a legacy name: `content.pages.list` →
 * `content-studio.pages.list`, `scripts.generate` → `content-studio.scripts.generate`.
 */
export function contentStudioPluginMethod(legacy: string): string {
  const rest = legacy.startsWith("content.") ? legacy.slice("content.".length) : legacy;
  return `${CONTENT_STUDIO_PLUGIN_ID}.${rest}`;
}

export type ContentStudioMethod = {
  module: ContentStudioModule;
  legacy: string;
  method: string;
  scope: ContentStudioScope;
};

/** Flat list of every legacy method with its module, plugin name and scope. */
export function listContentStudioMethods(): ContentStudioMethod[] {
  const out: ContentStudioMethod[] = [];
  for (const [module, methods] of Object.entries(CONTENT_STUDIO_LEGACY_METHODS)) {
    for (const [legacy, scope] of Object.entries(methods)) {
      out.push({
        module: module as ContentStudioModule,
        legacy,
        method: contentStudioPluginMethod(legacy),
        scope: scope as ContentStudioScope,
      });
    }
  }
  return out;
}

/**
 * Plugin-native methods (no legacy name): the drag-and-drop pipeline board,
 * per-item and Ideas content pages, and their media. Served by
 * pipeline-methods.ts; `requires` mirrors the manifest's rpc entry.
 */
export const CONTENT_STUDIO_PIPELINE_METHODS = {
  "content-studio.board.get": "read",
  "content-studio.stages.create": "write",
  "content-studio.stages.update": "write",
  "content-studio.stages.reorder": "write",
  "content-studio.stages.delete": "write",
  "content-studio.items.get": "read",
  "content-studio.items.create": "write",
  "content-studio.items.update": "write",
  "content-studio.items.move": "write",
  "content-studio.items.delete": "write",
  "content-studio.docs.getBlocks": "read",
  "content-studio.docs.saveBlocks": "write",
  "content-studio.docs.getMarkdown": "read",
  "content-studio.docs.setMarkdown": "write",
  "content-studio.docs.appendMarkdown": "write",
  "content-studio.ideas.list": "read",
  "content-studio.ideas.create": "write",
  "content-studio.ideas.update": "write",
  "content-studio.ideas.delete": "write",
  "content-studio.ideas.promote": "write",
  "content-studio.media.list": "read",
  "content-studio.media.capabilities": "read",
  "content-studio.media.reference": "write",
  "content-studio.media.importUrl": "write",
  "content-studio.media.attach": "write",
  "content-studio.media.detach": "write",
  "content-studio.media.delete": "write",
} as const satisfies Record<string, ContentStudioScope>;

/**
 * Video posting queue (posting-methods.ts): per-page Droid Swarm device +
 * account binding, schedule, caption template, the queue and its history.
 */
export const CONTENT_STUDIO_POSTING_METHODS = {
  "content-studio.posting.get": "read",
  "content-studio.posting.configure": "write",
  "content-studio.posting.devices": "read",
  "content-studio.posting.detect": "write",
  "content-studio.posting.candidates": "read",
  "content-studio.posting.enqueue": "write",
  "content-studio.posting.update": "write",
  "content-studio.posting.reorder": "write",
  "content-studio.posting.action": "write",
  "content-studio.posting.postNow": "write",
  "content-studio.posting.preview": "read",
  "content-studio.posting.aiCaption": "write",
  "content-studio.posting.history": "read",
  "content-studio.posting.tick": "admin",
  "content-studio.posting.targets": "read",
  "content-studio.posting.lookup": "read",
} as const satisfies Record<string, ContentStudioScope>;

export const CONTENT_STUDIO_NATIVE_METHODS = {
  ...CONTENT_STUDIO_PIPELINE_METHODS,
  ...CONTENT_STUDIO_POSTING_METHODS,
} as const;

export type ContentStudioPipelineMethod = keyof typeof CONTENT_STUDIO_PIPELINE_METHODS;
export type ContentStudioPostingMethod = keyof typeof CONTENT_STUDIO_POSTING_METHODS;
export type ContentStudioNativeMethod = keyof typeof CONTENT_STUDIO_NATIVE_METHODS;

export function isPostingMethod(method: string): method is ContentStudioPostingMethod {
  return Object.prototype.hasOwnProperty.call(CONTENT_STUDIO_POSTING_METHODS, method);
}

/** Native methods that reach the network (manifest `requires: ["network"]`). */
export const CONTENT_STUDIO_NETWORK_METHODS: ReadonlySet<string> = new Set([
  "content-studio.media.importUrl",
  "content-studio.posting.enqueue",
  "content-studio.posting.aiCaption",
]);

export function listContentStudioNativeMethods(): Array<{
  method: ContentStudioNativeMethod;
  scope: ContentStudioScope;
}> {
  return Object.entries(CONTENT_STUDIO_NATIVE_METHODS).map(([method, scope]) => ({
    method: method as ContentStudioNativeMethod,
    scope,
  }));
}
