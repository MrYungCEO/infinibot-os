/**
 * Brand Controller — Business brand identity management
 * 
 * Stores and manages brand assets, colors, typography, and style guidelines.
 * Integrates with Canvas (designer agent) for consistent visual outputs.
 */

import type { GatewayBrowserClient } from "../gateway.js";
import type { AppViewState } from "../app-view-state.js";

// ── Types ────────────────────────────────────────────────────

export interface BrandColor {
  name: string;
  hex: string;
  usage: string; // e.g., "Primary", "Background", "Accent"
}

export interface BrandTypography {
  category: "heading" | "body" | "accent";
  fontFamily: string;
  weight: string;
  fallback: string;
}

export interface BrandLogo {
  id: string;
  name: string;
  path: string;
  variant: "primary" | "icon" | "wordmark" | "monochrome" | "dark" | "light";
  format: string;
  uploadedAt: string;
}

export interface BrandVoice {
  tone: string[];           // e.g., ["professional", "friendly", "innovative"]
  personality: string;      // Brief description
  doList: string[];         // "Do" guidelines
  dontList: string[];       // "Don't" guidelines
}

export interface BrandGuidelines {
  logoUsage: string;
  colorUsage: string;
  typographyRules: string;
  imageStyle: string;
  additionalNotes: string;
}

export interface BrandProfile {
  id: string;
  businessId: string;
  
  // Core Identity
  tagline: string;
  mission: string;
  
  // Visual Identity
  colors: BrandColor[];
  typography: BrandTypography[];
  logos: BrandLogo[];
  
  // Voice & Tone
  voice: BrandVoice;
  
  // Guidelines
  guidelines: BrandGuidelines;
  
  // Designer Agent Context
  designerPromptContext: string;  // Auto-generated context for Canvas agent
  
  // Meta
  createdAt: string;
  updatedAt: string;
}

export interface BrandState {
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  
  // Current brand profile
  brand: BrandProfile | null;
  
  // UI state
  activeTab: "colors" | "typography" | "logos" | "voice" | "guidelines" | "preview";
  showColorPicker: boolean;
  editingColorIndex: number | null;
  showLogoUpload: boolean;
  showPreview: boolean;
  
  // Temp form states
  newColor: Partial<BrandColor>;
  newTypography: Partial<BrandTypography>;
}

// ── Default Values ───────────────────────────────────────────

const DEFAULT_COLORS: BrandColor[] = [
  { name: "Primary", hex: "var(--g-primary)", usage: "Main brand color, CTAs, highlights" },
  { name: "Secondary", hex: "#1a1a1a", usage: "Backgrounds, secondary elements" },
  { name: "Accent", hex: "#ffffff", usage: "Text on dark, contrast elements" },
  { name: "Success", hex: "#22c55e", usage: "Success states, positive indicators" },
  { name: "Warning", hex: "#f59e0b", usage: "Warnings, attention needed" },
  { name: "Error", hex: "#ef4444", usage: "Errors, destructive actions" },
];

const DEFAULT_TYPOGRAPHY: BrandTypography[] = [
  { category: "heading", fontFamily: "Inter", weight: "700", fallback: "system-ui, sans-serif" },
  { category: "body", fontFamily: "Inter", weight: "400", fallback: "system-ui, sans-serif" },
  { category: "accent", fontFamily: "JetBrains Mono", weight: "500", fallback: "monospace" },
];

const DEFAULT_VOICE: BrandVoice = {
  tone: ["professional", "approachable"],
  personality: "Confident and knowledgeable, but never arrogant. We speak clearly and directly.",
  doList: [
    "Use active voice",
    "Be concise and clear",
    "Show personality appropriately",
  ],
  dontList: [
    "Use jargon unnecessarily",
    "Be condescending",
    "Overpromise or exaggerate",
  ],
};

const DEFAULT_GUIDELINES: BrandGuidelines = {
  logoUsage: "Maintain clear space around the logo equal to the height of the logomark. Never stretch, rotate, or alter colors outside approved variants.",
  colorUsage: "Primary color for key actions and brand moments. Use secondary for large surfaces. Accent for text and details.",
  typographyRules: "Headings in bold weight, body in regular. Minimum size 14px for body text. Use monospace for code and technical content.",
  imageStyle: "Clean, modern photography with natural lighting. Illustrations should be simple and geometric. Avoid stock photo clichés.",
  additionalNotes: "",
};

// ── Initialization ───────────────────────────────────────────

export function createInitialBrandState(): BrandState {
  return {
    loading: false,
    saving: false,
    error: null,
    success: null,
    brand: null,
    activeTab: "colors",
    showColorPicker: false,
    editingColorIndex: null,
    showLogoUpload: false,
    showPreview: false,
    newColor: {},
    newTypography: {},
  };
}

export function createDefaultBrandProfile(businessId: string): BrandProfile {
  return {
    id: `brand-${businessId}`,
    businessId,
    tagline: "",
    mission: "",
    colors: [...DEFAULT_COLORS],
    typography: [...DEFAULT_TYPOGRAPHY],
    logos: [],
    voice: { ...DEFAULT_VOICE },
    guidelines: { ...DEFAULT_GUIDELINES },
    designerPromptContext: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ── Designer Context Generator ───────────────────────────────

export function generateDesignerContext(brand: BrandProfile, businessName: string): string {
  const colorPalette = brand.colors
    .map(c => `- ${c.name}: ${c.hex} (${c.usage})`)
    .join("\n");
  
  const fonts = brand.typography
    .map(t => `- ${t.category}: ${t.fontFamily} ${t.weight}`)
    .join("\n");
  
  const toneWords = brand.voice.tone.join(", ");
  
  return `## Brand Context: ${businessName}

### Tagline
${brand.tagline || "Not defined"}

### Mission
${brand.mission || "Not defined"}

### Color Palette
${colorPalette}

### Typography
${fonts}

### Brand Voice
Tone: ${toneWords}
${brand.voice.personality}

### Image Style Guidelines
${brand.guidelines.imageStyle}

### Design Rules
- ${brand.guidelines.logoUsage}
- ${brand.guidelines.colorUsage}
- ${brand.guidelines.typographyRules}

When generating visuals for this brand, maintain consistency with these guidelines.`;
}

// ── CRUD Operations ──────────────────────────────────────────

export async function loadBrand(
  gw: GatewayBrowserClient,
  businessId: string,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): Promise<void> {
  setState(s => ({
    ...s,
    brandState: { ...s.brandState!, loading: true, error: null },
  }));

  try {
    const result = await gw.call<{ status: string; brand?: BrandProfile }>("brand.get", { businessId });
    
    if (result.status === "ok" && result.brand) {
      setState(s => ({
        ...s,
        brandState: {
          ...s.brandState!,
          loading: false,
          brand: result.brand ?? null,
        },
      }));
    } else {
      // No brand exists yet, create default
      const defaultBrand = createDefaultBrandProfile(businessId);
      setState(s => ({
        ...s,
        brandState: {
          ...s.brandState!,
          loading: false,
          brand: defaultBrand,
        },
      }));
    }
  } catch (err) {
    // Gateway method might not exist yet, create default
    const defaultBrand = createDefaultBrandProfile(businessId);
    setState(s => ({
      ...s,
      brandState: {
        ...s.brandState!,
        loading: false,
        brand: defaultBrand,
        error: null, // Don't show error for missing method
      },
    }));
  }
}

export async function saveBrand(
  gw: GatewayBrowserClient,
  brand: BrandProfile,
  businessName: string,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): Promise<void> {
  setState(s => ({
    ...s,
    brandState: { ...s.brandState!, saving: true, error: null, success: null },
  }));

  try {
    // Generate designer context before saving
    const designerContext = generateDesignerContext(brand, businessName);
    const updatedBrand = {
      ...brand,
      designerPromptContext: designerContext,
      updatedAt: new Date().toISOString(),
    };

    const result = await gw.call<{ status: string; error?: string }>("brand.save", { brand: updatedBrand });
    
    if (result.status === "ok") {
      setState(s => ({
        ...s,
        brandState: {
          ...s.brandState!,
          saving: false,
          brand: updatedBrand,
          success: "Brand settings saved",
        },
      }));
      
      // Clear success after delay
      setTimeout(() => {
        setState(s => ({
          ...s,
          brandState: { ...s.brandState!, success: null },
        }));
      }, 3000);
    } else {
      throw new Error(result.error || "Failed to save brand");
    }
  } catch (err) {
    // Fallback: save to local storage if gateway method not available
    try {
      const designerContext = generateDesignerContext(brand, businessName);
      const updatedBrand = {
        ...brand,
        designerPromptContext: designerContext,
        updatedAt: new Date().toISOString(),
      };
      
      localStorage.setItem(`brand-${brand.businessId}`, JSON.stringify(updatedBrand));
      
      setState(s => ({
        ...s,
        brandState: {
          ...s.brandState!,
          saving: false,
          brand: updatedBrand,
          success: "Brand settings saved locally",
        },
      }));
      
      setTimeout(() => {
        setState(s => ({
          ...s,
          brandState: { ...s.brandState!, success: null },
        }));
      }, 3000);
    } catch (localErr) {
      setState(s => ({
        ...s,
        brandState: {
          ...s.brandState!,
          saving: false,
          error: `Failed to save: ${localErr}`,
        },
      }));
    }
  }
}

// ── Color Operations ─────────────────────────────────────────

export function addColor(
  color: BrandColor,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): void {
  setState(s => {
    if (!s.brandState?.brand) return s;
    return {
      ...s,
      brandState: {
        ...s.brandState,
        brand: {
          ...s.brandState.brand,
          colors: [...s.brandState.brand.colors, color],
        },
        newColor: {},
      },
    };
  });
}

export function updateColor(
  index: number,
  color: BrandColor,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): void {
  setState(s => {
    if (!s.brandState?.brand) return s;
    const colors = [...s.brandState.brand.colors];
    colors[index] = color;
    return {
      ...s,
      brandState: {
        ...s.brandState,
        brand: { ...s.brandState.brand, colors },
        editingColorIndex: null,
      },
    };
  });
}

export function removeColor(
  index: number,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): void {
  setState(s => {
    if (!s.brandState?.brand) return s;
    const colors = s.brandState.brand.colors.filter((_, i) => i !== index);
    return {
      ...s,
      brandState: {
        ...s.brandState,
        brand: { ...s.brandState.brand, colors },
      },
    };
  });
}

// ── Typography Operations ────────────────────────────────────

export function updateTypography(
  category: "heading" | "body" | "accent",
  updates: Partial<BrandTypography>,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): void {
  setState(s => {
    if (!s.brandState?.brand) return s;
    const typography = s.brandState.brand.typography.map(t =>
      t.category === category ? { ...t, ...updates } : t
    );
    return {
      ...s,
      brandState: {
        ...s.brandState,
        brand: { ...s.brandState.brand, typography },
      },
    };
  });
}

// ── Voice Operations ─────────────────────────────────────────

export function updateVoice(
  updates: Partial<BrandVoice>,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): void {
  setState(s => {
    if (!s.brandState?.brand) return s;
    return {
      ...s,
      brandState: {
        ...s.brandState,
        brand: {
          ...s.brandState.brand,
          voice: { ...s.brandState.brand.voice, ...updates },
        },
      },
    };
  });
}

// ── Guidelines Operations ────────────────────────────────────

export function updateGuidelines(
  updates: Partial<BrandGuidelines>,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): void {
  setState(s => {
    if (!s.brandState?.brand) return s;
    return {
      ...s,
      brandState: {
        ...s.brandState,
        brand: {
          ...s.brandState.brand,
          guidelines: { ...s.brandState.brand.guidelines, ...updates },
        },
      },
    };
  });
}

// ── Brand Field Updates ──────────────────────────────────────

export function updateBrandField(
  field: keyof Pick<BrandProfile, "tagline" | "mission">,
  value: string,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): void {
  setState(s => {
    if (!s.brandState?.brand) return s;
    return {
      ...s,
      brandState: {
        ...s.brandState,
        brand: { ...s.brandState.brand, [field]: value },
      },
    };
  });
}

// ── Tab Navigation ───────────────────────────────────────────

export function setBrandTab(
  tab: BrandState["activeTab"],
  setState: (fn: (s: AppViewState) => AppViewState) => void
): void {
  setState(s => ({
    ...s,
    brandState: { ...s.brandState!, activeTab: tab },
  }));
}

// ── Logo Operations ──────────────────────────────────────────

export async function uploadLogo(
  gw: GatewayBrowserClient,
  businessId: string,
  file: File,
  variant: BrandLogo["variant"],
  setState: (fn: (s: AppViewState) => AppViewState) => void
): Promise<void> {
  try {
    // Read file as base64
    const reader = new FileReader();
    const base64 = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const logo: BrandLogo = {
      id: `logo-${Date.now()}`,
      name: file.name,
      path: base64, // Store as data URL for now
      variant,
      format: file.type,
      uploadedAt: new Date().toISOString(),
    };

    setState(s => {
      if (!s.brandState?.brand) return s;
      return {
        ...s,
        brandState: {
          ...s.brandState,
          brand: {
            ...s.brandState.brand,
            logos: [...s.brandState.brand.logos, logo],
          },
          showLogoUpload: false,
        },
      };
    });
  } catch (err) {
    setState(s => ({
      ...s,
      brandState: {
        ...s.brandState!,
        error: `Failed to upload logo: ${err}`,
      },
    }));
  }
}

export function removeLogo(
  logoId: string,
  setState: (fn: (s: AppViewState) => AppViewState) => void
): void {
  setState(s => {
    if (!s.brandState?.brand) return s;
    const logos = s.brandState.brand.logos.filter(l => l.id !== logoId);
    return {
      ...s,
      brandState: {
        ...s.brandState,
        brand: { ...s.brandState.brand, logos },
      },
    };
  });
}
