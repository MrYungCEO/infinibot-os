/**
 * Lead Generation Service - Type Definitions
 */

// ============================================================
// Lead Types
// ============================================================

export type LeadType =
  | "business" // Local businesses
  | "b2b" // Business to business
  | "b2c" // Business to consumer
  | "agency" // Marketing/creative agencies
  | "ecommerce" // Online stores
  | "restaurant" // Food & beverage
  | "healthcare" // Medical/dental/wellness
  | "realestate" // Real estate agents/companies
  | "professional" // Lawyers, accountants, consultants
  | "tech" // Tech companies, startups
  | "custom"; // User-defined

export type LeadSource =
  | "google_maps"
  | "google_search"
  | "yelp"
  | "yellow_pages"
  | "linkedin"
  | "apollo"
  | "hunter_io"
  | "clearbit"
  | "crunchbase"
  | "manual"
  | "import";

export type LeadStatus =
  | "new"
  | "contacted"
  | "qualified"
  | "proposal"
  | "negotiation"
  | "won"
  | "lost"
  | "unqualified";

export type LeadQuality = "hot" | "warm" | "cold" | "unknown";

// ============================================================
// Lead Data Structures
// ============================================================

export interface Lead {
  id: string;

  // Basic info
  companyName: string;
  website?: string;
  industry?: string;
  description?: string;

  // Contact info
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;

  // Contact person
  contactName?: string;
  contactTitle?: string;
  contactEmail?: string;
  contactPhone?: string;
  contactLinkedIn?: string;

  // Business details
  employeeCount?: string;
  revenue?: string;
  founded?: string;

  // Social presence
  linkedInUrl?: string;
  facebookUrl?: string;
  twitterUrl?: string;
  instagramUrl?: string;

  // Ratings & reviews (for local businesses)
  rating?: number;
  reviewCount?: number;

  // Classification
  type: LeadType;
  source: LeadSource;
  status: LeadStatus;
  quality: LeadQuality;
  tags?: string[];

  // Metadata
  scrapedAt: number;
  lastUpdated: number;
  notionPageId?: string;
  /** Local CRM client created from this lead (agency-operations store). */
  crmClientId?: string;
  notes?: string;

  // Raw data for debugging
  rawData?: Record<string, unknown>;
}

export interface LeadSearchParams {
  // What to search
  query: string;

  // Where to search
  location?: string;
  radius?: number; // km
  country?: string;

  // Filter options
  type?: LeadType;
  industry?: string;
  minRating?: number;
  minReviews?: number;
  hasEmail?: boolean;
  hasPhone?: boolean;
  hasWebsite?: boolean;

  // Pagination
  limit?: number;
  offset?: number;

  // Sources to use
  sources?: LeadSource[];

  /**
   * Optional business scope. Surfaced on the response so the UI knows which
   * tenant the results belong to, and reserved for future per-business
   * caching / rate-limit isolation. Ignored by the current scrapers.
   */
  businessId?: string | null;
}

export interface LeadSearchResult {
  leads: Lead[];
  total: number;
  source: LeadSource;
  searchParams: LeadSearchParams;
  scrapedAt: number;
  cached: boolean;
  errors?: string[];
}

// ============================================================
// Scraper Configuration
// ============================================================

export interface ScraperConfig {
  // Rate limiting
  requestsPerMinute: number;
  requestsPerDay: number;

  // Caching
  cacheEnabled: boolean;
  cacheTtlMs: number;

  // Retry settings
  maxRetries: number;
  retryDelayMs: number;

  // Proxy settings
  useProxy: boolean;
  proxyUrl?: string;

  // API keys (for paid services)
  apiKey?: string;
}

export interface ScraperStats {
  source: LeadSource;
  requestsToday: number;
  requestsThisMinute: number;
  lastRequestAt: number;
  errorsToday: number;
  leadsScrapedToday: number;
}

// ============================================================
// Notion CRM Integration
// ============================================================

export interface NotionLeadMapping {
  // Map Lead fields to Notion properties
  companyName: string; // title property
  email?: string; // email property
  phone?: string; // phone_number property
  website?: string; // url property
  address?: string; // rich_text property
  industry?: string; // select property
  status?: string; // status property
  source?: string; // select property
  quality?: string; // select property
  tags?: string; // multi_select property
  notes?: string; // rich_text property
  contactName?: string; // rich_text property
  contactEmail?: string; // email property
  rating?: string; // number property
  reviewCount?: string; // number property
}

export interface LeadToCrmParams {
  lead: Lead;
  /** Optional Notion CRM database to mirror into. The local CRM is always written. */
  databaseId?: string | null;
  /** Business (agency) the client belongs to; defaults to the default business. */
  businessId?: string | null;
  mapping?: Partial<NotionLeadMapping>;
  updateIfExists?: boolean;
}

// ============================================================
// Enrichment
// ============================================================

export interface EnrichmentResult {
  lead: Lead;
  enrichedFields: string[];
  source: LeadSource;
  confidence: number;
}

export interface EnrichmentParams {
  lead: Lead;
  fields?: Array<keyof Lead>;
  sources?: LeadSource[];
}
