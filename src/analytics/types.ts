/**
 * KPI Analytics System — Type Definitions
 * Universal tracking for websites, funnels, and applications
 */

// ══════════════════════════════════════════════════════════════════
// CORE TYPES
// ══════════════════════════════════════════════════════════════════

export type EventType = 
  | 'page_view' 
  | 'click' 
  | 'form_submit' 
  | 'conversion' 
  | 'scroll' 
  | 'engagement' 
  | 'custom';

export type AttributionModel = 'first_touch' | 'last_touch' | 'linear' | 'time_decay';

export type TimeRange = '1h' | '24h' | '7d' | '30d' | '90d' | '1y' | 'all';

// ══════════════════════════════════════════════════════════════════
// SITE & TRACKING CONFIGURATION
// ══════════════════════════════════════════════════════════════════

export interface KPISite {
  id: string;
  communityId?: string;  // Links to vault community if applicable
  domain: string;
  name: string;
  scriptKey: string;     // Unique key for the tracking script
  settings: KPISiteSettings;
  createdAt: string;
  updatedAt: string;
}

export interface KPISiteSettings {
  trackPageViews: boolean;
  trackClicks: boolean;
  trackScrollDepth: boolean;
  trackFormSubmits: boolean;
  trackConversions: boolean;
  anonymizeIp: boolean;
  respectDnt: boolean;        // Do Not Track header
  sessionTimeout: number;     // Minutes until session expires
  excludePaths: string[];     // Paths to exclude from tracking
  customDimensions: string[]; // Custom data fields to track
}

// ══════════════════════════════════════════════════════════════════
// SESSIONS
// ══════════════════════════════════════════════════════════════════

export interface KPISession {
  id: string;
  siteId: string;
  fingerprint: string;
  startedAt: string;
  lastActivityAt: string;
  pageCount: number;
  eventCount: number;
  duration: number;           // Seconds
  entryPage: string;
  exitPage?: string;
  utm: UTMParams;
  referrer?: string;
  device: DeviceInfo;
  country?: string;
  city?: string;
  isNew: boolean;
  bounced: boolean;
  converted: boolean;
}

export interface DeviceInfo {
  type: 'desktop' | 'tablet' | 'mobile' | 'unknown';
  browser: string;
  browserVersion?: string;
  os: string;
  osVersion?: string;
  screenWidth?: number;
  screenHeight?: number;
}

export interface UTMParams {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

// ══════════════════════════════════════════════════════════════════
// EVENTS
// ══════════════════════════════════════════════════════════════════

export interface KPIEvent {
  id: string;
  siteId: string;
  sessionId: string;
  eventType: EventType;
  timestamp: string;
  data: EventData;
}

export type EventData = 
  | PageViewData 
  | ClickData 
  | FormSubmitData 
  | ConversionData 
  | ScrollData
  | EngagementData
  | CustomEventData;

export interface PageViewData {
  type: 'page_view';
  url: string;
  path: string;
  title?: string;
  referrer?: string;
  duration?: number;        // Time on page (filled on next event)
  loadTime?: number;        // Page load time ms
}

export interface ClickData {
  type: 'click';
  element: string;          // Element selector or identifier
  elementText?: string;
  targetUrl?: string;
  coordinates?: { x: number; y: number };
  isExternal: boolean;
}

export interface FormSubmitData {
  type: 'form_submit';
  formId?: string;
  formName?: string;
  formAction?: string;
  fields: string[];         // Field names submitted (not values for privacy)
  success: boolean;
}

export interface ConversionData {
  type: 'conversion';
  goalId: string;
  goalName: string;
  value?: number;
  currency?: string;
  orderId?: string;
  products?: ConversionProduct[];
}

export interface ConversionProduct {
  id: string;
  name: string;
  quantity: number;
  price: number;
}

export interface ScrollData {
  type: 'scroll';
  maxDepth: number;         // 0-100 percentage
  milestones: number[];     // Depths reached [25, 50, 75, 100]
}

export interface EngagementData {
  type: 'engagement';
  action: string;           // 'video_play', 'file_download', etc.
  label?: string;
  value?: number;
}

export interface CustomEventData {
  type: 'custom';
  name: string;
  category?: string;
  data: Record<string, unknown>;
}

// ══════════════════════════════════════════════════════════════════
// CONVERSIONS & GOALS
// ══════════════════════════════════════════════════════════════════

export interface KPIConversion {
  id: string;
  siteId: string;
  sessionId: string;
  goalId: string;
  type: string;
  value?: number;
  currency?: string;
  attribution: AttributionData;
  funnelPath: string[];     // Pages visited before conversion
  timestamp: string;
}

export interface AttributionData {
  model: AttributionModel;
  source: string;
  medium?: string;
  campaign?: string;
  touchpoints: TouchPoint[];
}

export interface TouchPoint {
  source: string;
  medium?: string;
  campaign?: string;
  timestamp: string;
  page: string;
  weight: number;           // Attribution weight (0-1)
}

export interface KPIGoal {
  id: string;
  siteId: string;
  name: string;
  description?: string;
  type: 'destination' | 'duration' | 'pages_per_session' | 'event';
  config: GoalConfig;
  value?: number;           // Default monetary value
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type GoalConfig = 
  | { type: 'destination'; url: string; matchType: 'exact' | 'starts_with' | 'regex' }
  | { type: 'duration'; seconds: number; comparison: 'gte' | 'lte' }
  | { type: 'pages_per_session'; count: number; comparison: 'gte' | 'lte' }
  | { type: 'event'; eventName: string; conditions?: Record<string, unknown> };

// ══════════════════════════════════════════════════════════════════
// FUNNELS
// ══════════════════════════════════════════════════════════════════

export interface KPIFunnel {
  id: string;
  siteId: string;
  name: string;
  description?: string;
  steps: FunnelStep[];
  createdAt: string;
  updatedAt: string;
}

export interface FunnelStep {
  id: string;
  name: string;
  type: 'page' | 'event';
  config: {
    url?: string;
    matchType?: 'exact' | 'starts_with' | 'regex';
    eventName?: string;
    conditions?: Record<string, unknown>;
  };
  order: number;
}

export interface FunnelAnalytics {
  funnelId: string;
  timeRange: TimeRange;
  steps: FunnelStepAnalytics[];
  overallConversion: number;
  completions: number;
  abandonments: number;
  avgTimeToComplete: number;
}

export interface FunnelStepAnalytics {
  stepId: string;
  stepName: string;
  entered: number;
  completed: number;
  dropped: number;
  conversionRate: number;
  dropoffRate: number;
  avgTimeInStep: number;
}

// ══════════════════════════════════════════════════════════════════
// ANALYTICS & REPORTING
// ══════════════════════════════════════════════════════════════════

export interface KPIAnalytics {
  siteId: string;
  timeRange: TimeRange;
  period: {
    start: string;
    end: string;
  };
  overview: OverviewMetrics;
  traffic: TrafficMetrics;
  engagement: EngagementMetrics;
  conversions: ConversionMetrics;
  realtime: RealtimeMetrics;
}

export interface OverviewMetrics {
  pageViews: number;
  uniqueVisitors: number;
  sessions: number;
  avgSessionDuration: number;  // seconds
  bounceRate: number;          // 0-100
  newVisitors: number;
  returningVisitors: number;
  pageViewsChange: number;     // % change from previous period
  visitorsChange: number;
}

export interface TrafficMetrics {
  sources: { source: string; visits: number; percentage: number }[];
  mediums: { medium: string; visits: number; percentage: number }[];
  campaigns: { campaign: string; visits: number; conversions: number }[];
  referrers: { referrer: string; visits: number }[];
  topPages: { path: string; views: number; avgDuration: number; bounceRate: number }[];
  entryPages: { path: string; entries: number; bounceRate: number }[];
  exitPages: { path: string; exits: number; exitRate: number }[];
}

export interface EngagementMetrics {
  avgPagesPerSession: number;
  avgScrollDepth: number;
  clickEvents: number;
  formSubmissions: number;
  downloads: number;
  videoPlays: number;
  timeOnSite: { bucket: string; sessions: number }[];
  scrollDistribution: { depth: string; percentage: number }[];
}

export interface ConversionMetrics {
  totalConversions: number;
  conversionRate: number;
  totalValue: number;
  avgOrderValue: number;
  goalCompletions: { goalId: string; goalName: string; completions: number; value: number }[];
  conversionsBySource: { source: string; conversions: number; value: number; rate: number }[];
  conversionPath: { path: string[]; count: number; avgValue: number }[];
}

export interface RealtimeMetrics {
  activeVisitors: number;
  activePages: { path: string; visitors: number }[];
  eventsPerMinute: number;
  recentConversions: { goalName: string; value?: number; timestamp: string }[];
  trafficByCountry: { country: string; visitors: number }[];
}

// ══════════════════════════════════════════════════════════════════
// TRACKING SCRIPT PAYLOAD
// ══════════════════════════════════════════════════════════════════

export interface TrackingPayload {
  siteKey: string;
  sessionId?: string;
  fingerprint: string;
  event: {
    type: EventType;
    data: Record<string, unknown>;
    timestamp: number;
  };
  context: {
    url: string;
    referrer?: string;
    utm?: UTMParams;
    device: DeviceInfo;
    timezone: string;
    language: string;
  };
}

export interface TrackingResponse {
  success: boolean;
  sessionId: string;
  error?: string;
}

// ══════════════════════════════════════════════════════════════════
// FILTERS & QUERIES
// ══════════════════════════════════════════════════════════════════

export interface AnalyticsQuery {
  siteId: string;
  timeRange?: TimeRange;
  startDate?: string;
  endDate?: string;
  filters?: AnalyticsFilter[];
  segments?: string[];
  granularity?: 'hour' | 'day' | 'week' | 'month';
  limit?: number;
  offset?: number;
}

export interface AnalyticsFilter {
  field: string;
  operator: 'eq' | 'ne' | 'contains' | 'starts_with' | 'gt' | 'lt' | 'gte' | 'lte' | 'in';
  value: string | number | string[] | number[];
}

export interface TimeSeriesPoint {
  timestamp: string;
  value: number;
  label?: string;
}

export interface TimeSeriesData {
  metric: string;
  points: TimeSeriesPoint[];
  total: number;
  change: number;
}
