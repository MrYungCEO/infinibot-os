/** Business hub — payload shapes returned by the `hub.*` RPCs (mirrors src/business-hub). */

export type Lifecycle = "subscriber" | "lead" | "qualified" | "customer" | "churned";

export type Contact = {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
  title: string | null;
  companyId: string | null;
  companyName?: string | null;
  clientId: string | null;
  lifecycle: Lifecycle;
  score: number;
  emailStatus: string;
  emailOptIn: boolean;
  owner: string | null;
  city: string | null;
  country: string | null;
  social: Record<string, string>;
  custom: Record<string, unknown>;
  firstSourceId: string | null;
  firstCampaignId: string | null;
  lastActivityAt: number | null;
  createdAt: number;
  updatedAt: number;
  tags?: string[];
};

export type Company = {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  clientId: string | null;
  social: Record<string, string>;
  tags?: string[];
};

export type Activity = { id: string; subjectType: string; subjectId: string; type: string; summary: string; data: Record<string, unknown>; actor: string | null; occurredAt: number };

export type Stage = { id: string; pipelineId: string; name: string; position: number; kind: "open" | "won" | "lost"; probability: number; requiredFields: string[]; rotDays: number | null; color: string | null };
export type Pipeline = { id: string; name: string; isDefault: boolean; stages: Stage[] };
export type StageRule = { id: string; event: string; toStageId: string; onlyFrom: string[]; enabled: boolean };

export type Deal = {
  id: string;
  title: string;
  pipelineId: string;
  stageId: string;
  status: "open" | "won" | "lost";
  valueCents: number;
  currency: string;
  probability: number | null;
  expectedCloseAt: number | null;
  nextAction: string | null;
  nextActionAt: number | null;
  lostReason: string | null;
  contactId: string | null;
  companyId: string | null;
  clientId: string | null;
  sourceId: string | null;
  campaignId: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  companyName?: string | null;
  sourceName?: string | null;
  campaignName?: string | null;
  ageDays?: number;
  rotting?: boolean;
  stageEnteredAt: number;
  createdAt: number;
  wonAt: number | null;
  custom: Record<string, unknown>;
  tags?: string[];
};

export type StageMetric = { stageId: string; name: string; kind: string; count: number; valueCents: number; weightedCents: number; reached: number; conversionFromPrev: number | null; avgDaysInStage: number | null; rotting: number };
export type AttributionRow = { key: string; label: string; deals: number; won: number; wonCents: number; winRate: number | null };
export type PipelineMetrics = {
  stages: StageMetric[];
  open: { count: number; valueCents: number; weightedCents: number };
  won: { count: number; valueCents: number };
  lost: { count: number; valueCents: number };
  winRate: number | null;
  avgCycleDays: number | null;
  bySource: AttributionRow[];
  byCampaign: AttributionRow[];
  lostReasons: Array<{ reason: string; count: number }>;
};

export type RevenueSummaryLite = {
  grossCents: number;
  netCents: number;
  feeCents: number;
  refundCents: number;
  chargeCount: number;
  mrrCents: number;
  arrCents: number;
  activeSubscriptions: number;
  churnRate: number | null;
};

export type OverviewData = {
  range: { from: number; to: number; prevFrom: number };
  contacts: { total: number; leads: number; customers: number; newInPeriod: number; newPrev: number; companies: number };
  pipeline: {
    open: { count: number; valueCents: number; weightedCents: number };
    won: { count: number; valueCents: number };
    lost: { count: number; valueCents: number };
    winRate: number | null;
    avgCycleDays: number | null;
    stages: StageMetric[];
    wonInPeriod: { n: number; v: number };
    wonPrev: { n: number; v: number };
    bySource: AttributionRow[];
  };
  email: { sent: number; opened: number; clicked: number; replied: number; bounced: number; unsubscribed: number; activeCampaigns: number; sentPrev: number };
  tracking: { pageViews: number; visitors: number; submits: number; pageViewsPrev: number; sites: number };
  revenue: RevenueSummaryLite | null;
  revenuePrev: RevenueSummaryLite | null;
  series: Record<"leads" | "revenue" | "pageViews" | "emails", Array<{ day: string; value: number }>>;
  attention: {
    dueActions: Array<{ id: string; title: string; nextAction: string; nextActionAt: number; valueCents: number; stage: string }>;
    rotting: number;
    hotLeads: Array<{ id: string; name: string; email: string | null; score: number; lifecycle: string }>;
  };
  bookings: {
    upcoming: number;
    next: Array<{ id: string; startsAt: number; name: string; email: string; offerName: string; dealId: string | null }>;
  };
  recent: Array<{ id: string; subjectType: "contact" | "deal" | "company" | "client"; subjectId: string; type: string; summary: string; occurredAt: number; subjectName: string | null }>;
  setup: Array<{ id: string; label: string; done: boolean; section: string }>;
};

export type ClientRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  statusLabel: string;
  notionLinked: boolean;
  updatedAt: number;
  ltvCents: number;
  lastPaymentAt: number | null;
  deals: number;
  openDealCents: number;
  contacts: number;
};

export type ImportBatch = {
  id: string;
  fileName: string;
  format: string;
  status: "previewed" | "committed" | "undone" | "failed";
  mapping: Record<string, string>;
  options: Record<string, unknown>;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  report: {
    total: number;
    valid: number;
    errors: number;
    warnings: number;
    willCreate: number;
    willUpdate: number;
    duplicatesInFile: number;
    invalidEmails: number;
    invalidPhones: number;
    issues: Array<{ row: number; field?: string; message: string }>;
  } | null;
  tags: string[];
  createdAt: number;
  committedAt: number | null;
  undoneAt: number | null;
};
