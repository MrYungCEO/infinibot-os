/**
 * Ideas — a lightweight capture type that sits before tasks, projects and
 * documents: "something worth keeping that isn't work yet". An idea is
 * captured fast (voice from the phone's InfiniBot face, the web Documents ›
 * Ideas tab, or an agent), explored, parked, and finally PROMOTED into a
 * board task, a board project or a Documents page. Promotion keeps the idea
 * (status "promoted") and links it to what it became, so the history and the
 * relations graph both show where the work came from.
 */

export const IDEA_STATUSES = ["new", "exploring", "parked", "promoted"] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export const IDEA_SOURCES = ["voice", "web", "agent", "mobile"] as const;
export type IdeaSource = (typeof IDEA_SOURCES)[number];

/** What an idea can be promoted into. */
export const IDEA_PROMOTE_TARGETS = ["task", "project", "document"] as const;
export type IdeaPromoteTarget = (typeof IDEA_PROMOTE_TARGETS)[number];

export interface Idea {
  id: string;
  title: string;
  body: string;
  tags: string[];
  source: IdeaSource;
  status: IdeaStatus;
  /** Board project ids this idea is about (or was promoted into). */
  projectIds: string[];
  /** Board task ids this idea is about (or was promoted into). */
  taskIds: string[];
  /** Note / Documents ids this idea is about (or was promoted into). */
  docIds: string[];
  /** CRM client ids (agency clients) this idea is for. Absent on older ideas. */
  clientIds?: string[];
  /** Date to revisit it: "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" (owner's wall clock). */
  reviewOn?: string;
  /** Set once promoted: what it became. */
  promotedTo?: { kind: IdeaPromoteTarget; id: string; at: string };
  /** Who captured it (agent id, "owner", …). */
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IdeaCreateParams {
  title: string;
  body?: string;
  tags?: string[];
  source?: IdeaSource;
  status?: IdeaStatus;
  projectIds?: string[];
  taskIds?: string[];
  docIds?: string[];
  clientIds?: string[];
  reviewOn?: string;
  createdBy?: string;
  /** Idempotency key: a second create with the same key returns the first idea. */
  clientRequestId?: string;
}

export type IdeaPatch = Partial<
  Pick<
    Idea,
    | "title"
    | "body"
    | "tags"
    | "status"
    | "projectIds"
    | "taskIds"
    | "docIds"
    | "clientIds"
    | "promotedTo"
  >
> & {
  /** null clears it. */
  reviewOn?: string | null;
};

export interface IdeaListParams {
  /** Case-insensitive match on title, body and tags. */
  query?: string;
  status?: IdeaStatus | IdeaStatus[];
  tag?: string;
  /** Only ideas for this CRM client. */
  clientId?: string;
  /** Only ideas updated after this ISO time / unix ms. */
  since?: string | number;
  limit?: number;
}
