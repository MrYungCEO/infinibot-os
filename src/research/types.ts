/**
 * Research document types — for deep dives, study materials, papers, and reference documents.
 */

export interface ResearchMeta {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  author?: string;
  category?: string;
  status: "draft" | "active" | "review" | "archived";
  topic?: string;
  sources?: string[];
  createdAt: number;
  updatedAt: number;
  notionPageId?: string;
  notionSyncedAt?: number;
}

export interface Research extends ResearchMeta {
  body: string;
}

export interface ResearchListItem extends ResearchMeta {
  preview: string;
  bodyLength: number;
}

export interface ResearchCreateParams {
  id?: string;
  name: string;
  body: string;
  description?: string;
  tags?: string[];
  author?: string;
  category?: string;
  status?: "draft" | "active" | "review" | "archived";
  topic?: string;
  sources?: string[];
}

export interface ResearchUpdateParams {
  id: string;
  name?: string;
  body?: string;
  description?: string;
  tags?: string[];
  category?: string;
  status?: "draft" | "active" | "review" | "archived";
  topic?: string;
  sources?: string[];
}

export interface ResearchSearchParams {
  query?: string;
  tags?: string[];
  category?: string;
  status?: "draft" | "active" | "review" | "archived";
  topic?: string;
  limit?: number;
}
