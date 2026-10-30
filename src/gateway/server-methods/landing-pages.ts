/**
 * Landing Pages Gateway Handlers
 * RPC methods for community landing page management
 *
 * Methods:
 * - community.pages.list — List landing pages
 * - community.pages.create — Create a new page
 * - community.pages.get — Get page by ID
 * - community.pages.update — Update page details
 * - community.pages.delete — Delete a page
 * - community.pages.publish — Publish a page
 * - community.pages.unpublish — Unpublish a page
 * - community.pages.preview — Get preview HTML
 * - community.pages.edit.start — Start edit session
 * - community.pages.edit.get — Get current edit session
 * - community.pages.edit.update — Update draft in session
 * - community.pages.edit.save — Save edit session
 * - community.pages.edit.end — End edit session
 * - community.pages.component.add — Add component
 * - community.pages.component.update — Update component
 * - community.pages.component.remove — Remove component
 * - community.pages.component.reorder — Reorder components
 * - community.pages.versions.list — List page versions
 * - community.pages.versions.restore — Restore a version
 * - community.pages.templates.list — List templates
 * - community.pages.templates.get — Get template
 * - community.pages.templates.clone — Clone from template
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getLandingPagesStore,
  type LandingPage,
  type PageComponent,
  type PageSettings,
  type PageStatus,
  type PageSourceType,
} from "../../community/landing-pages.js";
import {
  bindPageToNetlifySite,
  clearNetlifyToken,
  deployPage,
  getDeployStatus,
  getNetlifyStatus,
  getSiteState,
  listNetlifySites,
  setCustomDomain,
  setNetlifyToken,
} from "../../landing-pages/netlify.js";
import {
  captureSubmission,
  getBusinessLeadsIndex,
  listBusinesses,
  listBusinessSubmissions,
} from "../../landing-pages/lead-router.js";
import { getBusinessBranding, projectBrandingToPageSettings } from "../../business/branding.js";
import { getBusinessKpi, getPageKpi, ingestEventBatch } from "../../landing-pages/analytics.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("landing-pages-gateway");

// ═══════════════════════════════════════════════════════════════
// ERROR HELPER
// ═══════════════════════════════════════════════════════════════

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    if ("message" in e && typeof (e as any).message === "string") {
      return (e as any).message;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return "[complex error object]";
    }
  }
  return String(e);
}

// ═══════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════

export const landingPagesHandlers: GatewayRequestHandlers = {
  // ═══════════════════════════════════════════════════════════════
  // PAGE CRUD
  // ═══════════════════════════════════════════════════════════════

  "community.pages.list": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const communityId = params.communityId as string | undefined;
      const status = params.status as PageStatus | undefined;

      const pages = store.listPages(communityId, status);

      respond(true, {
        pages,
        count: pages.length,
      });
    } catch (e) {
      log.error("Failed to list pages", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.create": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();

      const communityId = params.communityId as string;
      const name = params.name as string;

      if (!communityId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "communityId is required" });
        return;
      }

      if (!name) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "name is required" });
        return;
      }

      const page = store.createPage({
        communityId,
        name,
        slug: params.slug as string | undefined,
        sourceType: params.sourceType as PageSourceType | undefined,
        linkedUrl: params.linkedUrl as string | undefined,
        templateId: params.templateId as string | undefined,
        createdBy: params.createdBy as string | undefined,
      });

      // Auto-apply business branding if the communityId resolves to a business profile.
      // Skip when applyBranding === false (template clone path).
      const applyBranding = params.applyBranding !== false;
      if (applyBranding) {
        const biz = getBusinessBranding(communityId);
        if (biz) {
          const projection = projectBrandingToPageSettings(biz);
          // Merge into the page's settings without clobbering anything the template set.
          const newSettings = {
            ...page.settings,
            title: page.settings.title || projection.title,
            description: page.settings.description || projection.description,
            ogImage: page.settings.ogImage || projection.ogImage,
            favicon: page.settings.favicon || projection.favicon,
            colors: { ...projection.colors, ...page.settings.colors },
            fonts: { ...projection.fonts, ...page.settings.fonts },
          } as typeof page.settings;
          store.updatePage(page.id, { settings: newSettings });
          // Re-fetch the page so we return the merged version.
          const merged = store.getPage(page.id) ?? page;
          log.info("Created landing page (with business branding)", {
            pageId: page.id,
            name,
            communityId,
            businessName: biz.name,
          });
          respond(true, { page: merged, brandingApplied: true, businessName: biz.name });
          return;
        }
      }
      log.info("Created landing page", { pageId: page.id, name, communityId });
      respond(true, { page, brandingApplied: false });
    } catch (e) {
      log.error("Failed to create page", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.get": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = (params.pageId as string) || (params.id as string);
      const slug = params.slug as string;
      const communityId = params.communityId as string;

      let page: LandingPage | undefined;

      if (pageId) {
        page = store.getPage(pageId);
      } else if (slug && communityId) {
        page = store.getPageBySlug(communityId, slug);
      } else {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId or (slug + communityId) required",
        });
        return;
      }

      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }

      respond(true, { page });
    } catch (e) {
      log.error("Failed to get page", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.update": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = (params.pageId as string) || (params.id as string);

      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }

      const updates: Partial<
        Pick<LandingPage, "name" | "slug" | "status" | "components" | "settings" | "linkedUrl">
      > = {};

      if (params.name) updates.name = params.name as string;
      if (params.slug) updates.slug = params.slug as string;
      if (params.status) updates.status = params.status as PageStatus;
      if (params.components) updates.components = params.components as PageComponent[];
      if (params.settings) updates.settings = params.settings as PageSettings;
      if (params.linkedUrl !== undefined) updates.linkedUrl = params.linkedUrl as string;

      const page = store.updatePage(pageId, updates);

      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }

      log.info("Updated landing page", { pageId });
      respond(true, { page });
    } catch (e) {
      log.error("Failed to update page", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.delete": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = (params.pageId as string) || (params.id as string);

      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }

      const deleted = store.deletePage(pageId);

      if (!deleted) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }

      log.info("Deleted landing page", { pageId });
      respond(true, { deleted: true });
    } catch (e) {
      log.error("Failed to delete page", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // PUBLISH / UNPUBLISH
  // ═══════════════════════════════════════════════════════════════

  "community.pages.publish": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = (params.pageId as string) || (params.id as string);

      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }

      const page = store.publishPage(pageId);

      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }

      log.info("Published landing page", { pageId, slug: page.slug });
      respond(true, { page });
    } catch (e) {
      log.error("Failed to publish page", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.unpublish": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = (params.pageId as string) || (params.id as string);

      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }

      const page = store.unpublishPage(pageId);

      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }

      log.info("Unpublished landing page", { pageId });
      respond(true, { page });
    } catch (e) {
      log.error("Failed to unpublish page", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // PREVIEW
  // ═══════════════════════════════════════════════════════════════

  "community.pages.preview": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = (params.pageId as string) || (params.id as string);
      const draft = (params.draft as boolean) ?? false;

      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }

      const html = store.generatePreviewHtml(pageId, draft);

      if (!html) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }

      respond(true, { html });
    } catch (e) {
      log.error("Failed to generate preview", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // EDIT SESSIONS
  // ═══════════════════════════════════════════════════════════════

  "community.pages.edit.start": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = (params.pageId as string) || (params.id as string);
      const userId = params.userId as string | undefined;

      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }

      const session = store.startEditSession(pageId, userId);

      if (!session) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }

      const page = store.getPage(pageId);

      log.info("Started edit session", { pageId, sessionId: session.id });
      respond(true, { session, page });
    } catch (e) {
      log.error("Failed to start edit session", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.edit.get": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = (params.pageId as string) || (params.id as string);

      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }

      const session = store.getEditSession(pageId);

      if (!session) {
        respond(false, undefined, { code: "NOT_FOUND", message: "No active edit session" });
        return;
      }

      respond(true, { session });
    } catch (e) {
      log.error("Failed to get edit session", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.edit.update": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = (params.pageId as string) || (params.id as string);

      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }

      const updates: { components?: PageComponent[]; settings?: PageSettings } = {};

      if (params.components) updates.components = params.components as PageComponent[];
      if (params.settings) updates.settings = params.settings as PageSettings;

      const session = store.updateEditSession(pageId, updates);

      if (!session) {
        respond(false, undefined, { code: "NOT_FOUND", message: "No active edit session" });
        return;
      }

      respond(true, { session });
    } catch (e) {
      log.error("Failed to update edit session", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.edit.save": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = (params.pageId as string) || (params.id as string);
      const note = params.note as string | undefined;

      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }

      const page = store.saveEditSession(pageId, note);

      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "No active edit session" });
        return;
      }

      const session = store.getEditSession(pageId);

      log.info("Saved edit session", { pageId, version: page.currentVersion });
      respond(true, { page, session });
    } catch (e) {
      log.error("Failed to save edit session", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.edit.end": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = (params.pageId as string) || (params.id as string);

      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }

      const ended = store.endEditSession(pageId);

      log.info("Ended edit session", { pageId });
      respond(true, { ended });
    } catch (e) {
      log.error("Failed to end edit session", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.edit.list": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const sessions = store.listEditSessions();

      respond(true, { sessions, count: sessions.length });
    } catch (e) {
      log.error("Failed to list edit sessions", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // COMPONENT OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  "community.pages.component.add": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = (params.pageId as string) || (params.id as string);
      const component = params.component as Omit<PageComponent, "id" | "order">;
      const position = params.position as number | undefined;

      if (!pageId || !component) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId and component are required",
        });
        return;
      }

      const page = store.addComponent(pageId, component, position);

      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }

      log.info("Added component to page", { pageId, type: component.type });
      respond(true, { page });
    } catch (e) {
      log.error("Failed to add component", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.component.update": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = params.pageId as string;
      const componentId = params.componentId as string;
      const updates = params.updates as Partial<PageComponent>;

      if (!pageId || !componentId || !updates) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId, componentId, and updates are required",
        });
        return;
      }

      const page = store.updateComponent(pageId, componentId, updates);

      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }

      log.info("Updated component", { pageId, componentId });
      respond(true, { page });
    } catch (e) {
      log.error("Failed to update component", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.component.remove": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = params.pageId as string;
      const componentId = params.componentId as string;

      if (!pageId || !componentId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId and componentId are required",
        });
        return;
      }

      const page = store.removeComponent(pageId, componentId);

      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }

      log.info("Removed component from page", { pageId, componentId });
      respond(true, { page });
    } catch (e) {
      log.error("Failed to remove component", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.component.reorder": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = params.pageId as string;
      const componentIds = params.componentIds as string[];

      if (!pageId || !componentIds || !Array.isArray(componentIds)) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId and componentIds array are required",
        });
        return;
      }

      const page = store.reorderComponents(pageId, componentIds);

      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }

      log.info("Reordered components", { pageId });
      respond(true, { page });
    } catch (e) {
      log.error("Failed to reorder components", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // VERSION HISTORY
  // ═══════════════════════════════════════════════════════════════

  "community.pages.versions.list": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = (params.pageId as string) || (params.id as string);

      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId is required" });
        return;
      }

      const vers = store.getVersions(pageId);

      respond(true, { versions: vers, count: vers.length });
    } catch (e) {
      log.error("Failed to list versions", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.versions.restore": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const pageId = params.pageId as string;
      const versionId = params.versionId as string;

      if (!pageId || !versionId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "pageId and versionId are required",
        });
        return;
      }

      const page = store.restoreVersion(pageId, versionId);

      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page or version not found" });
        return;
      }

      log.info("Restored page version", { pageId, versionId });
      respond(true, { page });
    } catch (e) {
      log.error("Failed to restore version", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATES
  // ═══════════════════════════════════════════════════════════════

  "community.pages.templates.list": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const templates = store.getTemplates();

      respond(true, { templates, count: templates.length });
    } catch (e) {
      log.error("Failed to list templates", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.templates.get": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const templateId = (params.templateId as string) || (params.id as string);

      if (!templateId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "templateId is required" });
        return;
      }

      const template = store.getTemplate(templateId);

      if (!template) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Template not found" });
        return;
      }

      respond(true, { template });
    } catch (e) {
      log.error("Failed to get template", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "community.pages.templates.clone": async ({ params, respond }) => {
    try {
      const store = getLandingPagesStore();
      const templateId = params.templateId as string;
      const communityId = params.communityId as string;
      const name = params.name as string;

      if (!templateId || !communityId || !name) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "templateId, communityId, and name are required",
        });
        return;
      }

      const page = store.cloneFromTemplate(templateId, {
        communityId,
        name,
        slug: params.slug as string | undefined,
        createdBy: params.createdBy as string | undefined,
      });

      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Template not found" });
        return;
      }

      log.info("Created page from template", { pageId: page.id, templateId });
      respond(true, { page });
    } catch (e) {
      log.error("Failed to clone template", { error: extractErrorMessage(e) });
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // NETLIFY HOSTING
  // ═══════════════════════════════════════════════════════════════

  "pages.netlify.status": async ({ respond }) => {
    try {
      respond(true, await getNetlifyStatus());
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "pages.netlify.connect": async ({ params, respond }) => {
    try {
      const token = params.token as string;
      if (!token) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "token required" });
        return;
      }
      const r = await setNetlifyToken(token);
      respond(true, r);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "pages.netlify.disconnect": async ({ respond }) => {
    try {
      await clearNetlifyToken();
      respond(true, { connected: false });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "pages.netlify.sites.list": async ({ respond }) => {
    try {
      respond(true, { sites: await listNetlifySites() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "pages.netlify.bind": async ({ params, respond }) => {
    try {
      const pageId = (params.pageId || params.id) as string;
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId required" });
        return;
      }
      const s = await bindPageToNetlifySite(pageId, {
        siteId: params.siteId as string | undefined,
        siteName: params.siteName as string | undefined,
      });
      respond(true, s);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "pages.netlify.bindStatus": async ({ params, respond }) => {
    try {
      const pageId = (params.pageId || params.id) as string;
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId required" });
        return;
      }
      respond(true, await getSiteState(pageId));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "pages.deploy": async ({ params, respond }) => {
    try {
      const pageId = (params.pageId || params.id) as string;
      const gatewayUrl = (params.gatewayUrl as string) || "";
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId required" });
        return;
      }
      if (!gatewayUrl) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "gatewayUrl required" });
        return;
      }
      const result = await deployPage({
        pageId,
        gatewayUrl,
        autoCreate: params.autoCreate !== false,
      });
      respond(result.ok, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "pages.deploy.status": async ({ params, respond }) => {
    try {
      const pageId = (params.pageId || params.id) as string;
      const deployId = params.deployId as string;
      if (!pageId || !deployId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId+deployId required" });
        return;
      }
      respond(true, await getDeployStatus(pageId, deployId));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "pages.netlify.setDomain": async ({ params, respond }) => {
    try {
      const pageId = (params.pageId || params.id) as string;
      const domain = params.domain as string;
      if (!pageId || !domain) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId+domain required" });
        return;
      }
      respond(true, await setCustomDomain(pageId, domain));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // BUSINESS BRANDING APPLICATION
  // ═══════════════════════════════════════════════════════════════

  /** Re-apply the owning business's branding to an existing page. Returns the updated page. */
  "pages.applyBusinessBranding": async ({ params, respond }) => {
    try {
      const pageId = (params.pageId || params.id) as string;
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId required" });
        return;
      }
      const store = getLandingPagesStore();
      const page = store.getPage(pageId);
      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "page not found" });
        return;
      }
      const businessId = (params.businessId as string) || page.communityId;
      const biz = getBusinessBranding(businessId);
      if (!biz) {
        respond(true, { page, brandingApplied: false, reason: "no business found" });
        return;
      }
      const projection = projectBrandingToPageSettings(biz);
      const newSettings = {
        ...page.settings,
        // When user explicitly applies branding, *do* clobber colors/fonts/title.
        title: projection.title || page.settings.title,
        description: projection.description || page.settings.description,
        ogImage: projection.ogImage || page.settings.ogImage,
        favicon: projection.favicon || page.settings.favicon,
        colors: { ...page.settings.colors, ...projection.colors },
        fonts: { ...page.settings.fonts, ...projection.fonts },
      };
      store.updatePage(page.id, { settings: newSettings as typeof page.settings });
      const merged = store.getPage(page.id) ?? page;
      respond(true, { page: merged, brandingApplied: true, businessName: biz.name });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // FORMS / LEADS (per-business CRM scoping)
  // ═══════════════════════════════════════════════════════════════

  "pages.forms.submit": async ({ params, respond }) => {
    try {
      const pageId = params.pageId as string;
      const formId = params.formId as string;
      const data = (params.data || {}) as Record<string, unknown>;
      const store = getLandingPagesStore();
      const page = pageId ? store.getPage(pageId) : undefined;
      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "page not found" });
        return;
      }
      const sub = await captureSubmission({
        businessId: page.communityId,
        pageId: page.id,
        pageSlug: page.slug,
        formId,
        data,
        source: typeof params.source === "string" ? (params.source as string) : "rpc",
      });
      respond(true, { submissionId: sub.id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "pages.leads.list": async ({ params, respond }) => {
    try {
      const businessId = (params.businessId || params.communityId) as string;
      if (!businessId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "businessId required" });
        return;
      }
      const items = await listBusinessSubmissions(businessId, {
        limit: typeof params.limit === "number" ? (params.limit as number) : 100,
        pageId: params.pageId as string | undefined,
      });
      respond(true, { submissions: items });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "pages.leads.summary": async ({ params, respond }) => {
    try {
      const businessId = (params.businessId || params.communityId) as string;
      if (!businessId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "businessId required" });
        return;
      }
      respond(true, await getBusinessLeadsIndex(businessId));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "pages.businesses.list": async ({ respond }) => {
    try {
      respond(true, { businesses: await listBusinesses() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // KPI / ANALYTICS
  // ═══════════════════════════════════════════════════════════════

  "pages.track.batch": async ({ params, respond }) => {
    try {
      await ingestEventBatch(params as unknown as Parameters<typeof ingestEventBatch>[0]);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "pages.kpi.business": async ({ params, respond }) => {
    try {
      const businessId = (params.businessId || params.communityId) as string;
      if (!businessId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "businessId required" });
        return;
      }
      respond(true, await getBusinessKpi(businessId));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "pages.kpi.page": async ({ params, respond }) => {
    try {
      const businessId = (params.businessId || params.communityId) as string;
      const pageId = params.pageId as string;
      if (!businessId || !pageId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "businessId+pageId required",
        });
        return;
      }
      respond(true, { kpi: await getPageKpi(businessId, pageId) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // AI CODE CONTROL
  // ═══════════════════════════════════════════════════════════════

  "pages.editWithAI": async ({ params, respond, context }) => {
    try {
      const pageId = (params.pageId || params.id) as string;
      const prompt = params.prompt as string;
      if (!pageId || !prompt) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId+prompt required" });
        return;
      }
      const store = getLandingPagesStore();
      const page = store.getPage(pageId);
      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "page not found" });
        return;
      }
      // Build a structured task: edit the page schema in-place via a sub-agent.
      // We hand the agent the current schema and let it return a JSON patch.
      const taskMessage = `You are editing a moltbot landing-page schema.

Current page schema (JSON):
\`\`\`json
${JSON.stringify({ name: page.name, slug: page.slug, components: page.components, settings: page.settings }, null, 2)}
\`\`\`

User request:
${prompt}

Return ONLY a JSON object with the keys you want to update: { "components"?: PageComponent[], "settings"?: Partial<PageSettings>, "summary": string }.
Do not wrap in markdown. Do not include any other text. The system will diff your output against the current schema and apply.`;
      // Use cron.wake to dispatch a one-shot agent turn into the main session — same plumbing
      // the rest of the app uses for autonomous wakes. Result lands in the chat / activity view.
      const wakeResult = context.cron.wake({ mode: "now", text: taskMessage });
      respond(true, { dispatched: true, runRef: wakeResult });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // RENDER (used by hosted preview / static export)
  // ═══════════════════════════════════════════════════════════════

  "pages.render.preview": async ({ params, respond }) => {
    try {
      const pageId = (params.pageId || params.id) as string;
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId required" });
        return;
      }
      const store = getLandingPagesStore();
      const page = store.getPage(pageId);
      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "page not found" });
        return;
      }
      const { renderPageToDirectory } = await import("../../landing-pages/renderer.js");
      const os = await import("node:os");
      const path = await import("node:path");
      const fs = await import("node:fs/promises");
      const outDir = path.join(os.tmpdir(), `lp-preview-${page.id}-${Date.now()}`);
      await renderPageToDirectory({
        page,
        outDir,
        gatewayUrl: (params.gatewayUrl as string) || "",
      });
      const html = await fs.readFile(path.join(outDir, "index.html"), "utf-8");
      const css = await fs.readFile(path.join(outDir, "styles.css"), "utf-8");
      try {
        await fs.rm(outDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      respond(true, { html, css });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },
};
