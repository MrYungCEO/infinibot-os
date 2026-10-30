/**
 * Characters Controller — Global character library management
 * For consistent image generation with saved character references.
 */

import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import { gatewayHttpUrl } from "../gateway-endpoint";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface CharacterImage {
  id: string;
  characterId: string;
  path: string;
  label: string;
  isPrimary: boolean;
  addedAt: string;
}

export interface Character {
  id: string;
  name: string;
  slug: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  images: CharacterImage[];
}

export interface CharacterSummary {
  id: string;
  name: string;
  slug: string;
  tags: string[];
  imageCount: number;
  primaryImage: string | null;
  createdAt: string;
}

export interface CharactersState {
  characters: CharacterSummary[];
  selectedCharacter: Character | null;
  loading: boolean;
  error: string | null;
  // Dialog states
  showCreateDialog: boolean;
  showEditDialog: boolean;
  showImageUploadDialog: boolean;
  showPreviewModal: boolean;
  previewImageUrl: string | null;
  previewCharacterName: string | null;
  // Form state
  createForm: {
    name: string;
    description: string;
    tags: string;
    imagePath: string;
    imageData?: string; // base64
    filename?: string;
  };
  editForm: {
    name: string;
    description: string;
    tags: string;
  };
  imageUploadForm: {
    imagePath: string;
    label: string;
    imageData?: string; // base64
    filename?: string;
  };
  // Filters
  searchQuery: string;
  filterTag: string | null;
}

// ═══════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════

const DEFAULT_STATE: CharactersState = {
  characters: [],
  selectedCharacter: null,
  loading: false,
  error: null,
  showCreateDialog: false,
  showEditDialog: false,
  showImageUploadDialog: false,
  showPreviewModal: false,
  previewImageUrl: null,
  previewCharacterName: null,
  createForm: { name: "", description: "", tags: "", imagePath: "", imageData: undefined, filename: undefined },
  editForm: { name: "", description: "", tags: "" },
  imageUploadForm: { imagePath: "", label: "reference", imageData: undefined, filename: undefined },
  searchQuery: "",
  filterTag: null,
};

export function getCharactersState(state: AppViewState): CharactersState {
  if (!(state as any)._charactersState) {
    (state as any)._charactersState = { ...DEFAULT_STATE };
  }
  return (state as any)._charactersState;
}

function updateState(state: AppViewState, updates: Partial<CharactersState>): void {
  const current = getCharactersState(state);
  (state as any)._charactersState = { ...current, ...updates };
}

// ═══════════════════════════════════════════════════════════════
// API CALLS
// ═══════════════════════════════════════════════════════════════

export async function loadCharacters(
  state: AppViewState,
  client: GatewayBrowserClient,
  tag?: string
): Promise<void> {
  updateState(state, { loading: true, error: null });
  
  try {
    const result = await client.call("characters.list", { tag });
    updateState(state, { 
      characters: result.characters || [],
      loading: false 
    });
  } catch (e) {
    updateState(state, { 
      loading: false, 
      error: e instanceof Error ? e.message : String(e) 
    });
  }
}

export async function loadCharacter(
  state: AppViewState,
  client: GatewayBrowserClient,
  idOrSlug: string
): Promise<void> {
  try {
    const result = await client.call("characters.get", { slug: idOrSlug });
    updateState(state, { selectedCharacter: result.character || null });
  } catch (e) {
    console.error("Failed to load character:", e);
  }
}

export async function createCharacter(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<boolean> {
  const { createForm } = getCharactersState(state);
  
  if (!createForm.name) {
    updateState(state, { error: "Name is required" });
    return false;
  }
  
  if (!createForm.imagePath && !createForm.imageData) {
    updateState(state, { error: "Please select an image or enter a file path" });
    return false;
  }
  
  try {
    const tags = createForm.tags
      .split(",")
      .map(t => t.trim())
      .filter(Boolean);
    
    const params: Record<string, any> = {
      name: createForm.name,
      description: createForm.description,
      tags,
    };
    
    // Prefer base64 data if available
    if (createForm.imageData) {
      params.imageData = createForm.imageData;
      params.filename = createForm.filename || "upload.png";
    } else {
      params.imagePath = createForm.imagePath;
    }
    
    const result = await client.call("characters.create", params);
    
    if (result.character) {
      await loadCharacters(state, client);
      closeCreateDialog(state);
      return true;
    } else {
      updateState(state, { error: "Failed to create character" });
      return false;
    }
  } catch (e) {
    updateState(state, { error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export async function updateCharacter(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<boolean> {
  const { selectedCharacter, editForm } = getCharactersState(state);
  if (!selectedCharacter) return false;
  
  try {
    const tags = editForm.tags
      .split(",")
      .map(t => t.trim())
      .filter(Boolean);
    
    const result = await client.call("characters.update", {
      slug: selectedCharacter.slug,
      name: editForm.name || undefined,
      description: editForm.description,
      tags,
    });
    
    if (result.character) {
      await loadCharacter(state, client, selectedCharacter.slug);
      await loadCharacters(state, client);
      closeEditDialog(state);
      return true;
    }
    return false;
  } catch (e) {
    updateState(state, { error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export async function deleteCharacter(
  state: AppViewState,
  client: GatewayBrowserClient,
  slug: string
): Promise<boolean> {
  if (!confirm(`Delete character "${slug}"? This will remove all reference images.`)) {
    return false;
  }
  
  try {
    await client.call("characters.delete", { slug });
    updateState(state, { selectedCharacter: null });
    await loadCharacters(state, client);
    return true;
  } catch (e) {
    updateState(state, { error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export async function addImage(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<boolean> {
  const { selectedCharacter, imageUploadForm } = getCharactersState(state);
  if (!selectedCharacter) return false;
  
  // Need either a path or base64 data
  if (!imageUploadForm.imagePath && !imageUploadForm.imageData) {
    updateState(state, { error: "Please select an image or enter a file path" });
    return false;
  }
  
  try {
    const params: Record<string, string> = {
      slug: selectedCharacter.slug,
      label: imageUploadForm.label || "reference",
    };
    
    // Prefer base64 data if available (browser upload)
    if (imageUploadForm.imageData) {
      params.imageData = imageUploadForm.imageData;
      params.filename = imageUploadForm.filename || "upload.png";
    } else {
      params.imagePath = imageUploadForm.imagePath;
    }
    
    const result = await client.call("characters.addImage", params);
    
    if (result.image) {
      await loadCharacter(state, client, selectedCharacter.slug);
      await loadCharacters(state, client);
      closeImageUploadDialog(state);
      return true;
    }
    return false;
  } catch (e) {
    updateState(state, { error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export async function deleteImage(
  state: AppViewState,
  client: GatewayBrowserClient,
  imageId: string
): Promise<boolean> {
  const { selectedCharacter } = getCharactersState(state);
  if (!selectedCharacter) return false;
  
  if (!confirm("Delete this reference image?")) return false;
  
  try {
    await client.call("characters.deleteImage", { imageId });
    await loadCharacter(state, client, selectedCharacter.slug);
    await loadCharacters(state, client);
    return true;
  } catch (e) {
    updateState(state, { error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export async function setPrimaryImage(
  state: AppViewState,
  client: GatewayBrowserClient,
  imageId: string
): Promise<boolean> {
  const { selectedCharacter } = getCharactersState(state);
  if (!selectedCharacter) return false;
  
  try {
    await client.call("characters.setPrimary", { 
      slug: selectedCharacter.slug, 
      imageId 
    });
    await loadCharacter(state, client, selectedCharacter.slug);
    return true;
  } catch (e) {
    updateState(state, { error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export async function searchCharacters(
  state: AppViewState,
  client: GatewayBrowserClient,
  query: string
): Promise<void> {
  if (!query.trim()) {
    await loadCharacters(state, client);
    return;
  }
  
  try {
    const result = await client.call("characters.search", { query });
    updateState(state, { 
      characters: result.characters || [],
      searchQuery: query 
    });
  } catch (e) {
    console.error("Search failed:", e);
  }
}

// ═══════════════════════════════════════════════════════════════
// UI ACTIONS
// ═══════════════════════════════════════════════════════════════

export function selectCharacter(
  state: AppViewState,
  client: GatewayBrowserClient,
  slug: string
): void {
  loadCharacter(state, client, slug);
}

export function clearSelection(state: AppViewState): void {
  updateState(state, { selectedCharacter: null });
}

// Dialog management
export function openCreateDialog(state: AppViewState): void {
  updateState(state, { 
    showCreateDialog: true,
    createForm: { 
      name: "", 
      description: "", 
      tags: "", 
      imagePath: "",
      imageData: undefined,
      filename: undefined
    }
  });
}

export function closeCreateDialog(state: AppViewState): void {
  updateState(state, { showCreateDialog: false });
}

export function openEditDialog(state: AppViewState): void {
  const { selectedCharacter } = getCharactersState(state);
  if (!selectedCharacter) return;
  
  updateState(state, { 
    showEditDialog: true,
    editForm: {
      name: selectedCharacter.name,
      description: selectedCharacter.description,
      tags: selectedCharacter.tags.join(", "),
    }
  });
}

export function closeEditDialog(state: AppViewState): void {
  updateState(state, { showEditDialog: false });
}

export function openImageUploadDialog(state: AppViewState): void {
  updateState(state, { 
    showImageUploadDialog: true,
    imageUploadForm: { 
      imagePath: "", 
      label: "reference",
      imageData: undefined,
      filename: undefined 
    }
  });
}

// Preview modal management
export function openPreviewModal(state: AppViewState, imageUrl: string, characterName: string): void {
  updateState(state, { 
    showPreviewModal: true,
    previewImageUrl: imageUrl,
    previewCharacterName: characterName
  });
}

export function closePreviewModal(state: AppViewState): void {
  updateState(state, { 
    showPreviewModal: false,
    previewImageUrl: null,
    previewCharacterName: null
  });
}

export function closeImageUploadDialog(state: AppViewState): void {
  updateState(state, { showImageUploadDialog: false });
}

// Form updates
export function updateCreateForm(
  state: AppViewState,
  updates: Partial<CharactersState["createForm"]>
): void {
  const current = getCharactersState(state);
  updateState(state, {
    createForm: { ...current.createForm, ...updates }
  });
}

export function updateEditForm(
  state: AppViewState,
  updates: Partial<CharactersState["editForm"]>
): void {
  const current = getCharactersState(state);
  updateState(state, {
    editForm: { ...current.editForm, ...updates }
  });
}

export function updateImageUploadForm(
  state: AppViewState,
  updates: Partial<CharactersState["imageUploadForm"]>
): void {
  const current = getCharactersState(state);
  updateState(state, {
    imageUploadForm: { ...current.imageUploadForm, ...updates }
  });
}

export function setFilterTag(state: AppViewState, tag: string | null): void {
  updateState(state, { filterTag: tag });
}

export function clearError(state: AppViewState): void {
  updateState(state, { error: null });
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

export function getUniqueTags(state: AppViewState): string[] {
  const { characters } = getCharactersState(state);
  const tagSet = new Set<string>();
  
  for (const char of characters) {
    for (const tag of char.tags) {
      tagSet.add(tag);
    }
  }
  
  return Array.from(tagSet).sort();
}

export function getFilteredCharacters(state: AppViewState): CharacterSummary[] {
  const { characters, filterTag, searchQuery } = getCharactersState(state);
  
  let result = characters;
  
  if (filterTag) {
    result = result.filter(c => c.tags.includes(filterTag));
  }
  
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    result = result.filter(c => 
      c.name.toLowerCase().includes(q) ||
      c.tags.some(t => t.toLowerCase().includes(q))
    );
  }
  
  return result;
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Get the image URL for display (converts local paths to HTTP URLs)
 */
export function getImageUrl(path: string | null, slug?: string): string {
  if (!path) return "";
  
  // If already an HTTP URL, use as-is
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  if (path.startsWith("/media/")) return gatewayHttpUrl(path);
  
  // Convert local file path to HTTP URL via /media/ endpoint
  // e.g., "C:\\Users\\you\\.infinibot\\characters\\sf-bear\\reference_001.jpg"
  //    -> "/media/characters/sf-bear/reference_001.jpg"
  if (path.startsWith("C:") || path.startsWith("/") || path.includes("\\")) {
    // Extract slug and filename from the path
    const parts = path.replace(/\\/g, "/").split("/");
    const filename = parts.pop() || "";
    const charSlug = slug || parts.pop() || "";
    
    if (charSlug && filename) {
      return gatewayHttpUrl(`/media/characters/${charSlug}/${filename}`);
    }
  }
  
  return path;
}
