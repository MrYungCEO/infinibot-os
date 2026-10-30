/**
 * Image Studio Types — Context-aware image generation system
 */

// ═══════════════════════════════════════════════════════════════════════════════
// ASSET TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ImageAsset {
  id: string;
  name: string;
  description?: string;
  
  // File info
  filePath: string;
  thumbnailPath?: string;
  mimeType: string;
  fileSize: number;
  
  // Image metadata
  width: number;
  height: number;
  
  // Categorization
  type: AssetType;
  tags: string[];
  
  // Context terms this asset is associated with
  contextTerms: string[];
  
  // Usage tracking
  usageCount: number;
  lastUsedAt?: number;
  
  // Timestamps
  createdAt: number;
  updatedAt: number;
}

export type AssetType = 
  | 'face'           // Face reference for person consistency
  | 'person'         // Full body reference
  | 'object'         // Object reference (car, item, etc.)
  | 'style'          // Style reference
  | 'background'     // Background/scene reference
  | 'logo'           // Logo/brand asset
  | 'texture'        // Texture/pattern
  | 'other';

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT TERMS
// ═══════════════════════════════════════════════════════════════════════════════

export interface ContextTerm {
  id: string;
  term: string;              // e.g., "me", "my car", "home office"
  aliases: string[];         // Alternative terms that map to the same context
  description?: string;
  
  // Associated assets
  assetIds: string[];
  primaryAssetId?: string;   // Main reference image
  
  // Generation hints
  promptInjection?: string;  // Additional prompt text when this term is used
  negativePrompt?: string;   // Negative prompt additions
  
  // Settings
  autoInject: boolean;       // Auto-inject when term detected
  priority: number;          // Higher = processed first when multiple matches
  
  // Timestamps
  createdAt: number;
  updatedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERATION HISTORY
// ═══════════════════════════════════════════════════════════════════════════════

export interface GenerationRecord {
  id: string;
  
  // Input
  originalPrompt: string;
  processedPrompt: string;    // After context injection
  negativePrompt?: string;
  
  // Context used
  contextTermsUsed: string[];
  assetsUsed: string[];
  
  // Output
  outputPath: string;
  thumbnailPath?: string;
  
  // Model info
  model: string;
  modelVersion?: string;
  
  // Settings
  resolution: string;
  settings: Record<string, unknown>;
  
  // Result
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  
  // Metrics
  generationTimeMs?: number;
  cost?: number;
  
  // Timestamps
  createdAt: number;
  completedAt?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLE PRESETS
// ═══════════════════════════════════════════════════════════════════════════════

export interface StylePreset {
  id: string;
  name: string;
  description?: string;
  
  // Prompt modifications
  promptPrefix?: string;
  promptSuffix?: string;
  negativePrompt?: string;
  
  // Reference assets
  styleReferenceIds: string[];
  
  // Model preferences
  preferredModel?: string;
  modelSettings?: Record<string, unknown>;
  
  // Timestamps
  createdAt: number;
  updatedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MCP OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export interface ImageStudioState {
  assets: ImageAsset[];
  contextTerms: ContextTerm[];
  stylePresets: StylePreset[];
  generationHistory: GenerationRecord[];
  
  // Settings
  settings: {
    defaultModel: string;
    defaultResolution: string;
    autoSaveGenerated: boolean;
    historyLimit: number;
  };
}

// MCP Tool Parameters
export interface AddAssetParams {
  name: string;
  filePath: string;
  type: AssetType;
  description?: string;
  tags?: string[];
  contextTerms?: string[];
}

export interface CreateContextTermParams {
  term: string;
  aliases?: string[];
  description?: string;
  assetIds?: string[];
  primaryAssetId?: string;
  promptInjection?: string;
  autoInject?: boolean;
}

export interface GenerateWithContextParams {
  prompt: string;
  model?: string;
  resolution?: string;
  stylePreset?: string;
  additionalAssets?: string[];
  negativePrompt?: string;
}

export interface SearchAssetsParams {
  query?: string;
  type?: AssetType;
  tags?: string[];
  contextTerm?: string;
  limit?: number;
}
