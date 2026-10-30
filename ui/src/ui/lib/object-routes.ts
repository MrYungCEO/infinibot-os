/**
 * Where each linkable workspace object lives in the app — one mapping shared
 * by the My Network "Linked" section, its graph satellites and the People
 * chip rows on object pages.
 *
 * Objects with a detail route (projects, tasks, notes, documents, clients)
 * open directly; reports open in the Research workspace (`?open=`); the rest
 * open their page. Opportunities need app state (the focus view is not in the
 * URL), so callers pass `onOpportunity` when they can open the focus.
 */

import { navigateToDeepLink } from "../deep-link-route";
import { slugify } from "./slugs";

export const OBJECT_TYPE_LABEL: Record<string, string> = {
  project: "Project",
  task: "Task",
  note: "Note",
  document: "Document",
  file: "File",
  idea: "Idea",
  goal: "Goal",
  report: "Report",
  client: "Client",
  opportunity: "Opportunity",
  event: "Event",
  product: "Product",
  decision: "Decision",
  risk: "Risk",
  commitment: "Commitment",
  issue: "Issue",
  lead: "Lead",
};

export const OBJECT_TYPE_PLURAL: Record<string, string> = {
  project: "Projects",
  task: "Tasks",
  note: "Notes",
  document: "Documents",
  file: "Files",
  idea: "Ideas",
  goal: "Goals",
  report: "Reports",
  client: "Clients",
  opportunity: "Opportunities",
  event: "Events",
  product: "Products",
  decision: "Decisions",
  risk: "Risks",
  commitment: "Commitments",
  issue: "Issues",
  lead: "Leads",
};

/** App route for an object (without base path). */
export function routeForObject(type: string, id: string, label = ""): string {
  const slug = encodeURIComponent(slugify(label || type, id));
  switch (type) {
    case "project":
      return `/projects/${slug}`;
    case "task":
      return `/tasks/${slug}`;
    case "note":
      return `/notes/${slug}`;
    case "document":
      return `/documents/${slug}`;
    case "client":
      return `/clients/${slug}`;
    case "idea":
      return `/notes?view=ideas`;
    case "report":
      return `/research?open=${encodeURIComponent(id)}`;
    case "file":
      return `/files`;
    case "goal":
      return `/autonomy`;
    case "event":
      return `/schedule`;
    case "opportunity":
      return `/opportunities`;
    case "product":
      return `/products`;
    case "decision":
      return `/decisions`;
    case "risk":
      return `/risks`;
    case "commitment":
      return `/commitments`;
    case "issue":
      return `/issues`;
    case "lead":
      return `/leads`;
    default:
      return `/dashboard`;
  }
}

/** Navigate the SPA to an object. Returns false when navigation was not possible. */
export function openObject(
  type: string,
  id: string,
  label = "",
  opts: { basePath?: string; onOpportunity?: (id: string) => void } = {},
): boolean {
  if (type === "opportunity") opts.onOpportunity?.(id);
  return navigateToDeepLink(routeForObject(type, id, label), opts.basePath ?? "");
}
