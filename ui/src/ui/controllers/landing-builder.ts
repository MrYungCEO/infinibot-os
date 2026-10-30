/**
 * Landing Page Builder Controller
 * State management and gateway operations for landing page editing
 */

import type { GatewayBrowserClient } from "../gateway";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type PageStatus = 'draft' | 'published' | 'archived';
export type PageSourceType = 'built' | 'linked' | 'imported';
export type ComponentType = 
  | 'hero' | 'features' | 'testimonials' | 'pricing' | 'cta' 
  | 'form' | 'faq' | 'gallery' | 'video' | 'text' | 'stats' 
  | 'team' | 'footer' | 'custom';
export type ComponentVariant = 'default' | 'centered' | 'split' | 'minimal' | 'bold';

export interface ComponentBase {
  id: string;
  type: ComponentType;
  variant: ComponentVariant;
  order: number;
  visible: boolean;
  customCss?: string;
  customClasses?: string;
}

export interface HeroComponent extends ComponentBase {
  type: 'hero';
  headline: string;
  subheadline?: string;
  backgroundImage?: string;
  backgroundColor?: string;
  ctaText?: string;
  ctaUrl?: string;
  ctaSecondaryText?: string;
  ctaSecondaryUrl?: string;
  alignment: 'left' | 'center' | 'right';
  overlay?: boolean;
  overlayOpacity?: number;
}

export interface FeatureItem {
  id: string;
  icon?: string;
  title: string;
  description: string;
  link?: string;
}

export interface FeaturesComponent extends ComponentBase {
  type: 'features';
  title?: string;
  subtitle?: string;
  items: FeatureItem[];
  columns: 2 | 3 | 4;
  iconStyle: 'emoji' | 'icon' | 'image' | 'none';
}

export interface TestimonialItem {
  id: string;
  quote: string;
  author: string;
  role?: string;
  company?: string;
  avatar?: string;
  rating?: number;
}

export interface TestimonialsComponent extends ComponentBase {
  type: 'testimonials';
  title?: string;
  subtitle?: string;
  items: TestimonialItem[];
  style: 'cards' | 'carousel' | 'grid' | 'quotes';
}

export interface PricingTier {
  id: string;
  name: string;
  price: string;
  period?: string;
  description?: string;
  features: string[];
  ctaText: string;
  ctaUrl: string;
  highlighted?: boolean;
  badge?: string;
}

export interface PricingComponent extends ComponentBase {
  type: 'pricing';
  title?: string;
  subtitle?: string;
  tiers: PricingTier[];
}

export interface CtaComponent extends ComponentBase {
  type: 'cta';
  headline: string;
  subheadline?: string;
  buttonText: string;
  buttonUrl: string;
  buttonStyle: 'primary' | 'secondary' | 'outline' | 'gradient';
  backgroundColor?: string;
  backgroundImage?: string;
}

export interface FormField {
  id: string;
  name: string;
  label: string;
  type: 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'checkbox';
  placeholder?: string;
  required: boolean;
  options?: string[];
}

export interface FormComponent extends ComponentBase {
  type: 'form';
  title?: string;
  subtitle?: string;
  fields: FormField[];
  submitText: string;
  successMessage: string;
  webhookUrl?: string;
  redirectUrl?: string;
}

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
}

export interface FaqComponent extends ComponentBase {
  type: 'faq';
  title?: string;
  subtitle?: string;
  items: FaqItem[];
  style: 'accordion' | 'list' | 'grid';
}

export interface StatItem {
  id: string;
  value: string;
  label: string;
  prefix?: string;
  suffix?: string;
}

export interface StatsComponent extends ComponentBase {
  type: 'stats';
  title?: string;
  items: StatItem[];
  style: 'horizontal' | 'grid' | 'cards';
}

export interface TextComponent extends ComponentBase {
  type: 'text';
  content: string;
  format: 'markdown' | 'html';
}

export interface VideoComponent extends ComponentBase {
  type: 'video';
  title?: string;
  videoUrl: string;
  provider: 'youtube' | 'vimeo' | 'wistia' | 'loom' | 'custom';
  autoplay?: boolean;
  thumbnail?: string;
}

export interface FooterColumn {
  title: string;
  links: { label: string; url: string }[];
}

export interface FooterComponent extends ComponentBase {
  type: 'footer';
  logo?: string;
  tagline?: string;
  columns: FooterColumn[];
  copyright?: string;
  socialLinks?: {
    twitter?: string;
    instagram?: string;
    discord?: string;
    youtube?: string;
    linkedin?: string;
  };
}

export interface CustomComponent extends ComponentBase {
  type: 'custom';
  html: string;
  css?: string;
  js?: string;
}

export type PageComponent = 
  | HeroComponent
  | FeaturesComponent
  | TestimonialsComponent
  | PricingComponent
  | CtaComponent
  | FormComponent
  | FaqComponent
  | StatsComponent
  | TextComponent
  | VideoComponent
  | FooterComponent
  | CustomComponent;

export interface PageSettings {
  title: string;
  description?: string;
  keywords?: string[];
  favicon?: string;
  ogImage?: string;
  customHead?: string;
  customCss?: string;
  customJs?: string;
  analytics?: {
    googleAnalytics?: string;
    facebookPixel?: string;
    customScript?: string;
  };
  fonts?: {
    heading?: string;
    body?: string;
  };
  colors?: {
    primary?: string;
    secondary?: string;
    accent?: string;
    background?: string;
    text?: string;
  };
}

export interface LandingPage {
  id: string;
  communityId: string;
  name: string;
  slug: string;
  status: PageStatus;
  sourceType: PageSourceType;
  linkedUrl?: string;
  components: PageComponent[];
  settings: PageSettings;
  currentVersion: number;
  publishedVersion?: number;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface EditSession {
  id: string;
  pageId: string;
  communityId: string;
  userId?: string;
  startedAt: string;
  lastActivityAt: string;
  draftComponents: PageComponent[];
  draftSettings: PageSettings;
  hasUnsavedChanges: boolean;
}

export interface PageVersion {
  id: string;
  pageId: string;
  version: number;
  components: PageComponent[];
  settings: PageSettings;
  createdAt: string;
  createdBy?: string;
  note?: string;
}

export interface PageTemplate {
  id: string;
  name: string;
  description: string;
  category: 'landing' | 'sales' | 'course' | 'community' | 'event' | 'product';
  thumbnail?: string;
  components: PageComponent[];
  settings: Partial<PageSettings>;
  tags: string[];
}

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

export interface LandingBuilderState {
  // Pages
  pages: LandingPage[];
  currentPage: LandingPage | null;
  
  // Edit session
  editSession: EditSession | null;
  selectedComponentId: string | null;
  previewMode: 'desktop' | 'tablet' | 'mobile';
  
  // UI state
  activeTab: 'pages' | 'editor' | 'settings' | 'versions';
  editorPanel: 'components' | 'properties' | 'settings' | 'code';
  previewHtml: string;
  
  // Templates
  templates: PageTemplate[];
  
  // Versions
  versions: PageVersion[];
  
  // Loading states
  loading: boolean;
  saving: boolean;
  publishing: boolean;
  error: string | null;
  
  // Filters
  communityId: string | null;
  statusFilter: PageStatus | 'all';
}

export function createLandingBuilderState(): LandingBuilderState {
  return {
    pages: [],
    currentPage: null,
    editSession: null,
    selectedComponentId: null,
    previewMode: 'desktop',
    activeTab: 'pages',
    editorPanel: 'components',
    previewHtml: '',
    templates: [],
    versions: [],
    loading: false,
    saving: false,
    publishing: false,
    error: null,
    communityId: null,
    statusFilter: 'all',
  };
}

// Singleton state
let state: LandingBuilderState = createLandingBuilderState();
let pollInterval: ReturnType<typeof setInterval> | null = null;
let listeners: Set<() => void> = new Set();

export function getLandingBuilderState(): LandingBuilderState {
  return state;
}

function notifyListeners(): void {
  listeners.forEach(fn => fn());
}

export function subscribeLandingBuilder(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ═══════════════════════════════════════════════════════════════
// GATEWAY OPERATIONS
// ═══════════════════════════════════════════════════════════════

export async function loadPages(gw: GatewayBrowserClient, communityId?: string): Promise<void> {
  state = { ...state, loading: true, error: null };
  notifyListeners();

  try {
    const result = await gw.request('community.pages.list', { 
      communityId: communityId || state.communityId,
      status: state.statusFilter === 'all' ? undefined : state.statusFilter,
    });

    if (result.ok && result.data) {
      state = { 
        ...state, 
        pages: (result.data as any).pages || [], 
        loading: false,
        communityId: communityId || state.communityId,
      };
    } else {
      state = { ...state, loading: false, error: (result as any).error?.message || 'Failed to load pages' };
    }
  } catch (e) {
    state = { ...state, loading: false, error: (e as Error).message };
  }

  notifyListeners();
}

export async function loadPage(gw: GatewayBrowserClient, pageId: string): Promise<void> {
  state = { ...state, loading: true, error: null };
  notifyListeners();

  try {
    const result = await gw.request('community.pages.get', { pageId });

    if (result.ok && result.data) {
      state = { 
        ...state, 
        currentPage: (result.data as any).page || null, 
        loading: false,
      };
    } else {
      state = { ...state, loading: false, error: (result as any).error?.message || 'Failed to load page' };
    }
  } catch (e) {
    state = { ...state, loading: false, error: (e as Error).message };
  }

  notifyListeners();
}

export async function createPage(
  gw: GatewayBrowserClient, 
  data: { communityId: string; name: string; slug?: string; templateId?: string }
): Promise<LandingPage | null> {
  state = { ...state, loading: true, error: null };
  notifyListeners();

  try {
    const result = await gw.request('community.pages.create', data);

    if (result.ok && result.data) {
      const page = (result.data as any).page as LandingPage;
      state = { 
        ...state, 
        pages: [page, ...state.pages],
        currentPage: page,
        loading: false,
      };
      notifyListeners();
      return page;
    } else {
      state = { ...state, loading: false, error: (result as any).error?.message || 'Failed to create page' };
      notifyListeners();
      return null;
    }
  } catch (e) {
    state = { ...state, loading: false, error: (e as Error).message };
    notifyListeners();
    return null;
  }
}

export async function deletePage(gw: GatewayBrowserClient, pageId: string): Promise<boolean> {
  try {
    const result = await gw.request('community.pages.delete', { pageId });

    if (result.ok) {
      state = { 
        ...state, 
        pages: state.pages.filter(p => p.id !== pageId),
        currentPage: state.currentPage?.id === pageId ? null : state.currentPage,
        editSession: state.editSession?.pageId === pageId ? null : state.editSession,
      };
      notifyListeners();
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

export async function publishPage(gw: GatewayBrowserClient, pageId: string): Promise<boolean> {
  state = { ...state, publishing: true };
  notifyListeners();

  try {
    const result = await gw.request('community.pages.publish', { pageId });

    if (result.ok && result.data) {
      const page = (result.data as any).page as LandingPage;
      state = { 
        ...state, 
        pages: state.pages.map(p => p.id === pageId ? page : p),
        currentPage: state.currentPage?.id === pageId ? page : state.currentPage,
        publishing: false,
      };
      notifyListeners();
      return true;
    }
    state = { ...state, publishing: false };
    notifyListeners();
    return false;
  } catch (e) {
    state = { ...state, publishing: false };
    notifyListeners();
    return false;
  }
}

export async function unpublishPage(gw: GatewayBrowserClient, pageId: string): Promise<boolean> {
  try {
    const result = await gw.request('community.pages.unpublish', { pageId });

    if (result.ok && result.data) {
      const page = (result.data as any).page as LandingPage;
      state = { 
        ...state, 
        pages: state.pages.map(p => p.id === pageId ? page : p),
        currentPage: state.currentPage?.id === pageId ? page : state.currentPage,
      };
      notifyListeners();
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// EDIT SESSION OPERATIONS
// ═══════════════════════════════════════════════════════════════

export async function startEditSession(gw: GatewayBrowserClient, pageId: string): Promise<EditSession | null> {
  state = { ...state, loading: true, error: null };
  notifyListeners();

  try {
    const result = await gw.request('community.pages.edit.start', { pageId });

    if (result.ok && result.data) {
      const session = (result.data as any).session as EditSession;
      const page = (result.data as any).page as LandingPage;
      state = { 
        ...state, 
        editSession: session,
        currentPage: page,
        activeTab: 'editor',
        loading: false,
      };
      
      // Load initial preview
      await refreshPreview(gw, pageId, true);
      notifyListeners();
      return session;
    }
    state = { ...state, loading: false, error: (result as any).error?.message || 'Failed to start edit session' };
    notifyListeners();
    return null;
  } catch (e) {
    state = { ...state, loading: false, error: (e as Error).message };
    notifyListeners();
    return null;
  }
}

export async function updateEditSession(
  gw: GatewayBrowserClient, 
  pageId: string, 
  updates: { components?: PageComponent[]; settings?: PageSettings }
): Promise<void> {
  try {
    const result = await gw.request('community.pages.edit.update', { pageId, ...updates });

    if (result.ok && result.data) {
      const session = (result.data as any).session as EditSession;
      state = { ...state, editSession: session };
      
      // Refresh preview
      await refreshPreview(gw, pageId, true);
      notifyListeners();
    }
  } catch (e) {
    console.error('Failed to update edit session:', e);
  }
}

export async function saveEditSession(gw: GatewayBrowserClient, pageId: string, note?: string): Promise<boolean> {
  state = { ...state, saving: true };
  notifyListeners();

  try {
    const result = await gw.request('community.pages.edit.save', { pageId, note });

    if (result.ok && result.data) {
      const page = (result.data as any).page as LandingPage;
      const session = (result.data as any).session as EditSession;
      state = { 
        ...state, 
        currentPage: page,
        editSession: session,
        pages: state.pages.map(p => p.id === pageId ? page : p),
        saving: false,
      };
      notifyListeners();
      return true;
    }
    state = { ...state, saving: false };
    notifyListeners();
    return false;
  } catch (e) {
    state = { ...state, saving: false };
    notifyListeners();
    return false;
  }
}

export async function endEditSession(gw: GatewayBrowserClient, pageId: string): Promise<void> {
  try {
    await gw.request('community.pages.edit.end', { pageId });
    state = { 
      ...state, 
      editSession: null,
      selectedComponentId: null,
      previewHtml: '',
      activeTab: 'pages',
    };
    notifyListeners();
  } catch (e) {
    console.error('Failed to end edit session:', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// PREVIEW OPERATIONS
// ═══════════════════════════════════════════════════════════════

export async function refreshPreview(gw: GatewayBrowserClient, pageId: string, draft: boolean = true): Promise<void> {
  try {
    const result = await gw.request('community.pages.preview', { pageId, draft });

    if (result.ok && result.data) {
      state = { ...state, previewHtml: (result.data as any).html || '' };
      notifyListeners();
    }
  } catch (e) {
    console.error('Failed to refresh preview:', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// COMPONENT OPERATIONS
// ═══════════════════════════════════════════════════════════════

export function selectComponent(componentId: string | null): void {
  state = { ...state, selectedComponentId: componentId };
  notifyListeners();
}

export function setEditorPanel(panel: LandingBuilderState['editorPanel']): void {
  state = { ...state, editorPanel: panel };
  notifyListeners();
}

export function setPreviewMode(mode: LandingBuilderState['previewMode']): void {
  state = { ...state, previewMode: mode };
  notifyListeners();
}

export async function addComponent(
  gw: GatewayBrowserClient, 
  pageId: string, 
  component: Omit<PageComponent, 'id' | 'order'>,
  position?: number
): Promise<void> {
  try {
    const result = await gw.request('community.pages.component.add', { pageId, component, position });

    if (result.ok && result.data) {
      const page = (result.data as any).page as LandingPage;
      state = { 
        ...state, 
        currentPage: page,
        pages: state.pages.map(p => p.id === pageId ? page : p),
      };
      
      // Update edit session with new components
      if (state.editSession) {
        state.editSession = { ...state.editSession, draftComponents: page.components, hasUnsavedChanges: true };
      }
      
      await refreshPreview(gw, pageId, true);
      notifyListeners();
    }
  } catch (e) {
    console.error('Failed to add component:', e);
  }
}

export async function updateComponent(
  gw: GatewayBrowserClient, 
  pageId: string, 
  componentId: string, 
  updates: Partial<PageComponent>
): Promise<void> {
  try {
    const result = await gw.request('community.pages.component.update', { pageId, componentId, updates });

    if (result.ok && result.data) {
      const page = (result.data as any).page as LandingPage;
      state = { 
        ...state, 
        currentPage: page,
        pages: state.pages.map(p => p.id === pageId ? page : p),
      };
      
      if (state.editSession) {
        state.editSession = { ...state.editSession, draftComponents: page.components, hasUnsavedChanges: true };
      }
      
      await refreshPreview(gw, pageId, true);
      notifyListeners();
    }
  } catch (e) {
    console.error('Failed to update component:', e);
  }
}

export async function removeComponent(gw: GatewayBrowserClient, pageId: string, componentId: string): Promise<void> {
  try {
    const result = await gw.request('community.pages.component.remove', { pageId, componentId });

    if (result.ok && result.data) {
      const page = (result.data as any).page as LandingPage;
      state = { 
        ...state, 
        currentPage: page,
        pages: state.pages.map(p => p.id === pageId ? page : p),
        selectedComponentId: state.selectedComponentId === componentId ? null : state.selectedComponentId,
      };
      
      if (state.editSession) {
        state.editSession = { ...state.editSession, draftComponents: page.components, hasUnsavedChanges: true };
      }
      
      await refreshPreview(gw, pageId, true);
      notifyListeners();
    }
  } catch (e) {
    console.error('Failed to remove component:', e);
  }
}

export async function reorderComponents(gw: GatewayBrowserClient, pageId: string, componentIds: string[]): Promise<void> {
  try {
    const result = await gw.request('community.pages.component.reorder', { pageId, componentIds });

    if (result.ok && result.data) {
      const page = (result.data as any).page as LandingPage;
      state = { 
        ...state, 
        currentPage: page,
        pages: state.pages.map(p => p.id === pageId ? page : p),
      };
      
      if (state.editSession) {
        state.editSession = { ...state.editSession, draftComponents: page.components, hasUnsavedChanges: true };
      }
      
      await refreshPreview(gw, pageId, true);
      notifyListeners();
    }
  } catch (e) {
    console.error('Failed to reorder components:', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// VERSION OPERATIONS
// ═══════════════════════════════════════════════════════════════

export async function loadVersions(gw: GatewayBrowserClient, pageId: string): Promise<void> {
  try {
    const result = await gw.request('community.pages.versions.list', { pageId });

    if (result.ok && result.data) {
      state = { ...state, versions: (result.data as any).versions || [] };
      notifyListeners();
    }
  } catch (e) {
    console.error('Failed to load versions:', e);
  }
}

export async function restoreVersion(gw: GatewayBrowserClient, pageId: string, versionId: string): Promise<boolean> {
  try {
    const result = await gw.request('community.pages.versions.restore', { pageId, versionId });

    if (result.ok && result.data) {
      const page = (result.data as any).page as LandingPage;
      state = { 
        ...state, 
        currentPage: page,
        pages: state.pages.map(p => p.id === pageId ? page : p),
      };
      
      await refreshPreview(gw, pageId, false);
      await loadVersions(gw, pageId);
      notifyListeners();
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// TEMPLATE OPERATIONS
// ═══════════════════════════════════════════════════════════════

export async function loadTemplates(gw: GatewayBrowserClient): Promise<void> {
  try {
    const result = await gw.request('community.pages.templates.list', {});

    if (result.ok && result.data) {
      state = { ...state, templates: (result.data as any).templates || [] };
      notifyListeners();
    }
  } catch (e) {
    console.error('Failed to load templates:', e);
  }
}

export async function createFromTemplate(
  gw: GatewayBrowserClient, 
  templateId: string, 
  data: { communityId: string; name: string; slug?: string }
): Promise<LandingPage | null> {
  return createPage(gw, { ...data, templateId });
}

// ═══════════════════════════════════════════════════════════════
// UI STATE
// ═══════════════════════════════════════════════════════════════

export function setActiveTab(tab: LandingBuilderState['activeTab']): void {
  state = { ...state, activeTab: tab };
  notifyListeners();
}

export function setStatusFilter(status: PageStatus | 'all'): void {
  state = { ...state, statusFilter: status };
  notifyListeners();
}

export function setCommunityId(communityId: string | null): void {
  state = { ...state, communityId };
  notifyListeners();
}

export function clearError(): void {
  state = { ...state, error: null };
  notifyListeners();
}

// ═══════════════════════════════════════════════════════════════
// POLLING
// ═══════════════════════════════════════════════════════════════

export function startPolling(gw: GatewayBrowserClient, intervalMs: number = 30000): void {
  stopPolling();
  pollInterval = setInterval(() => loadPages(gw), intervalMs);
}

export function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// COMPONENT DEFINITIONS (for the component library)
// ═══════════════════════════════════════════════════════════════

export interface ComponentDefinition {
  type: ComponentType;
  name: string;
  description: string;
  icon: string;
  defaultProps: Partial<PageComponent>;
}

export const COMPONENT_LIBRARY: ComponentDefinition[] = [
  {
    type: 'hero',
    name: 'Hero Section',
    description: 'Large header with headline, subtext, and CTA buttons',
    icon: '🎯',
    defaultProps: {
      variant: 'centered',
      visible: true,
      headline: 'Your Headline Here',
      subheadline: 'Add a compelling subheadline',
      ctaText: 'Get Started',
      ctaUrl: '#',
      alignment: 'center',
    } as Partial<HeroComponent>,
  },
  {
    type: 'features',
    name: 'Features Grid',
    description: 'Grid of features with icons and descriptions',
    icon: '✨',
    defaultProps: {
      variant: 'default',
      visible: true,
      title: 'Features',
      columns: 3,
      iconStyle: 'emoji',
      items: [
        { id: '1', icon: '🚀', title: 'Feature 1', description: 'Description here' },
        { id: '2', icon: '💡', title: 'Feature 2', description: 'Description here' },
        { id: '3', icon: '⚡', title: 'Feature 3', description: 'Description here' },
      ],
    } as Partial<FeaturesComponent>,
  },
  {
    type: 'testimonials',
    name: 'Testimonials',
    description: 'Customer testimonials and reviews',
    icon: '💬',
    defaultProps: {
      variant: 'default',
      visible: true,
      title: 'What People Say',
      style: 'cards',
      items: [
        { id: '1', quote: 'Amazing experience!', author: 'John Doe', role: 'Customer' },
      ],
    } as Partial<TestimonialsComponent>,
  },
  {
    type: 'pricing',
    name: 'Pricing Table',
    description: 'Pricing tiers with features comparison',
    icon: '💰',
    defaultProps: {
      variant: 'default',
      visible: true,
      title: 'Pricing',
      tiers: [
        { id: '1', name: 'Basic', price: '$9', period: '/mo', features: ['Feature 1'], ctaText: 'Start', ctaUrl: '#' },
        { id: '2', name: 'Pro', price: '$29', period: '/mo', features: ['Feature 1', 'Feature 2'], ctaText: 'Start', ctaUrl: '#', highlighted: true },
      ],
    } as Partial<PricingComponent>,
  },
  {
    type: 'cta',
    name: 'Call to Action',
    description: 'Prominent call-to-action section',
    icon: '📢',
    defaultProps: {
      variant: 'centered',
      visible: true,
      headline: 'Ready to Get Started?',
      buttonText: 'Start Now',
      buttonUrl: '#',
      buttonStyle: 'gradient',
    } as Partial<CtaComponent>,
  },
  {
    type: 'form',
    name: 'Lead Form',
    description: 'Lead capture form with customizable fields',
    icon: '📝',
    defaultProps: {
      variant: 'default',
      visible: true,
      title: 'Get in Touch',
      fields: [
        { id: '1', name: 'email', label: 'Email', type: 'email', required: true },
      ],
      submitText: 'Submit',
      successMessage: 'Thank you!',
    } as Partial<FormComponent>,
  },
  {
    type: 'faq',
    name: 'FAQ Section',
    description: 'Frequently asked questions accordion',
    icon: '❓',
    defaultProps: {
      variant: 'default',
      visible: true,
      title: 'Frequently Asked Questions',
      style: 'accordion',
      items: [
        { id: '1', question: 'How does it work?', answer: 'Explanation here...' },
      ],
    } as Partial<FaqComponent>,
  },
  {
    type: 'stats',
    name: 'Statistics',
    description: 'Key metrics and numbers display',
    icon: '📊',
    defaultProps: {
      variant: 'default',
      visible: true,
      style: 'horizontal',
      items: [
        { id: '1', value: '10K+', label: 'Users' },
        { id: '2', value: '99%', label: 'Uptime' },
      ],
    } as Partial<StatsComponent>,
  },
  {
    type: 'video',
    name: 'Video Embed',
    description: 'Embedded video player',
    icon: '🎬',
    defaultProps: {
      variant: 'centered',
      visible: true,
      title: 'Watch Demo',
      videoUrl: '',
      provider: 'youtube',
    } as Partial<VideoComponent>,
  },
  {
    type: 'text',
    name: 'Text Block',
    description: 'Rich text or markdown content',
    icon: '📄',
    defaultProps: {
      variant: 'default',
      visible: true,
      content: 'Your content here...',
      format: 'markdown',
    } as Partial<TextComponent>,
  },
  {
    type: 'footer',
    name: 'Footer',
    description: 'Page footer with links and social',
    icon: '🔗',
    defaultProps: {
      variant: 'default',
      visible: true,
      columns: [
        { title: 'Links', links: [{ label: 'Home', url: '#' }] },
      ],
      copyright: '© 2024 Your Company',
    } as Partial<FooterComponent>,
  },
  {
    type: 'custom',
    name: 'Custom HTML',
    description: 'Custom HTML/CSS/JS block',
    icon: '🛠️',
    defaultProps: {
      variant: 'default',
      visible: true,
      html: '<div>Custom content</div>',
    } as Partial<CustomComponent>,
  },
];

export function getComponentDefinition(type: ComponentType): ComponentDefinition | undefined {
  return COMPONENT_LIBRARY.find(c => c.type === type);
}
