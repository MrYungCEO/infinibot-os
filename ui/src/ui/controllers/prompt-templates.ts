import type { GatewayBrowserClient } from "../gateway";

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  body: string;
  tags: string[];
  category?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PromptTemplatesState {
  templates: PromptTemplate[];
  loading: boolean;
  error: string | null;
  selected: PromptTemplate | null;
  editing: boolean;
  saving: boolean;
  dirty: boolean;
  searchQuery: string;
  filterTag: string;
  filterCategory: string;
  editorName: string;
  editorDescription: string;
  editorBody: string;
  editorTags: string;
  editorCategory: string;
  isCreating: boolean;
  successMessage: string | null;
}

export function createPromptTemplatesState(): PromptTemplatesState {
  return {
    templates: [],
    loading: false,
    error: null,
    selected: null,
    editing: false,
    saving: false,
    dirty: false,
    searchQuery: "",
    filterTag: "",
    filterCategory: "",
    editorName: "",
    editorDescription: "",
    editorBody: "",
    editorTags: "",
    editorCategory: "",
    isCreating: false,
    successMessage: null,
  };
}

export async function loadTemplates(
  gw: GatewayBrowserClient,
  filter?: { category?: string; tag?: string },
): Promise<PromptTemplate[]> {
  const res = (await gw.request("promptTemplates.list", filter ?? {})) as {
    templates: PromptTemplate[];
  };
  return res?.templates ?? [];
}

export async function getTemplate(
  gw: GatewayBrowserClient,
  id: string,
): Promise<PromptTemplate | null> {
  try {
    return (await gw.request("promptTemplates.get", { id })) as PromptTemplate;
  } catch {
    return null;
  }
}

export async function createTemplate(
  gw: GatewayBrowserClient,
  input: { name: string; description?: string; body: string; tags?: string[]; category?: string },
): Promise<PromptTemplate> {
  return (await gw.request("promptTemplates.create", input)) as PromptTemplate;
}

export async function updateTemplate(
  gw: GatewayBrowserClient,
  id: string,
  patch: Partial<{ name: string; description: string; body: string; tags: string[]; category: string }>,
): Promise<PromptTemplate> {
  return (await gw.request("promptTemplates.update", { id, ...patch })) as PromptTemplate;
}

export async function deleteTemplate(gw: GatewayBrowserClient, id: string): Promise<void> {
  await gw.request("promptTemplates.delete", { id });
}

export async function searchTemplates(
  gw: GatewayBrowserClient,
  query: string,
): Promise<PromptTemplate[]> {
  const res = (await gw.request("promptTemplates.search", { query })) as {
    templates: PromptTemplate[];
  };
  return res?.templates ?? [];
}
