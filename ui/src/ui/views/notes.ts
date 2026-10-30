/**
 * Notes tab → Documents workspace (+ the Ideas section, documents/ideas.ts).
 *
 * The flat notes list grew into a full Documents workspace (nested folders,
 * rich markdown editor, uploads, Notion import). Existing notes are migrated
 * into it on first open and stay two-way synced, so `/notes/:slug` deep links,
 * the mobile Notes screen and every notes.* caller keep working.
 */

import { withAppBase } from "../app-base";
import { html } from "lit";
import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient } from "../gateway";
import { pushEntityUrl } from "../app-settings";
import { slugify } from "../lib/slugs";
import { resolveSubView } from "../navigation";
import "./documents/shell";
import "./work-glass/remaining.css";

type DeepLinkHost = { deepLink?: { kind: string; slug: string; pending: boolean } | null };

export function renderNotes(state: AppViewState, client: GatewayBrowserClient) {
  // A pasted /notes/:slug (or /documents/:slug) URL opens that document once.
  const host = state as unknown as DeepLinkHost;
  let pendingSlug: string | null = null;
  if (host.deepLink?.pending && host.deepLink.kind === "note") {
    pendingSlug = host.deepLink.slug;
    host.deepLink = { ...host.deepLink, pending: false };
  }
  const onOpened = (e: CustomEvent<{ id: string | null; title?: string }>) => {
    const urlHost = state as unknown as Parameters<typeof pushEntityUrl>[0];
    if (!e.detail.id) {
      const notesPath = withAppBase("/notes");
      if (typeof window !== "undefined" && window.location.pathname !== notesPath) {
        window.history.pushState({}, "", notesPath);
      }
      return;
    }
    pushEntityUrl(urlHost, "note", slugify(e.detail.title ?? "", e.detail.id), "notes");
  };
  // Documents | Ideas (documents/shell.ts); the workspace inside is unchanged.
  const section = resolveSubView("notes", state.hostView?.notes)?.id === "ideas" ? "ideas" : "documents";
  return html`<ib-documents-shell
    style="height: 100%; min-height: 520px;"
    .client=${client}
    .pendingSlug=${pendingSlug}
    .section=${section}
    @section-change=${(e: CustomEvent<string>) => state.setHostView(e.detail)}
    @doc-opened=${onOpened}
  ></ib-documents-shell>`;
}
