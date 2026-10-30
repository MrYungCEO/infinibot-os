/**
 * KPI Analytics System — Event Tracker
 * Processes incoming analytics events from tracking scripts
 */

import { getKPIStore, type KPIStore } from './kpi-store.js';
import type {
  TrackingPayload,
  TrackingResponse,
  EventType,
  KPISite,
  KPISession,
  KPIEvent,
  KPIGoal,
  KPIAnalytics,
  TimeRange,
  AttributionData,
  AttributionModel,
  TouchPoint,
  GoalConfig,
} from './types.js';

// ═══════════════════════════════════════════════════════════════
// KPI TRACKER CLASS
// ═══════════════════════════════════════════════════════════════

export class KPITracker {
  private store: KPIStore;

  constructor(store?: KPIStore) {
    this.store = store ?? getKPIStore();
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENT TRACKING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Process an incoming tracking event from the embed script
   */
  async track(payload: TrackingPayload): Promise<TrackingResponse> {
    try {
      // Validate site key
      const site = this.store.getSiteByScriptKey(payload.siteKey);
      if (!site) {
        return { success: false, sessionId: '', error: 'Invalid site key' };
      }

      // Check settings
      if (site.settings.respectDnt && payload.context.url.includes('dnt=1')) {
        return { success: true, sessionId: '', error: 'DNT respected' };
      }

      // Check excluded paths
      const path = new URL(payload.context.url).pathname;
      if (site.settings.excludePaths.some(p => path.startsWith(p))) {
        return { success: true, sessionId: '', error: 'Path excluded' };
      }

      // Get or create session
      let session = payload.sessionId 
        ? this.store.getSession(payload.sessionId)
        : this.store.getOrCreateSession(site.id, payload.fingerprint, site.settings.sessionTimeout);

      if (!session) {
        session = this.store.createSession({
          siteId: site.id,
          fingerprint: payload.fingerprint,
          entryPage: path,
          utm: payload.context.utm,
          referrer: payload.context.referrer,
          device: payload.context.device,
        });
      }

      // Process event based on type
      const eventData = this.processEventData(payload.event.type, payload.event.data, payload.context.url);
      
      // Check if this event type should be tracked
      if (!this.shouldTrackEvent(site, payload.event.type)) {
        return { success: true, sessionId: session.id };
      }

      // Record the event
      const event = this.store.recordEvent({
        siteId: site.id,
        sessionId: session.id,
        eventType: payload.event.type,
        eventData,
      });

      // Update session activity
      if (payload.event.type === 'page_view') {
        this.store.updateSessionActivity(session.id, path);
        this.store.updateRealtimeVisitor(site.id, session.id, path);
      }

      // Check for goal conversions
      await this.checkGoals(site, session, event);

      return { success: true, sessionId: session.id };
    } catch (error) {
      console.error('[KPI Tracker] Error processing event:', error);
      return { 
        success: false, 
        sessionId: payload.sessionId || '', 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  private shouldTrackEvent(site: KPISite, eventType: EventType): boolean {
    switch (eventType) {
      case 'page_view': return site.settings.trackPageViews;
      case 'click': return site.settings.trackClicks;
      case 'scroll': return site.settings.trackScrollDepth;
      case 'form_submit': return site.settings.trackFormSubmits;
      case 'conversion': return site.settings.trackConversions;
      default: return true;
    }
  }

  private processEventData(type: EventType, data: Record<string, unknown>, url: string): Record<string, unknown> {
    const parsed = new URL(url);
    
    switch (type) {
      case 'page_view':
        return {
          type: 'page_view',
          url,
          path: parsed.pathname,
          title: data.title,
          referrer: data.referrer,
          loadTime: data.loadTime,
          ...data,
        };
      case 'click':
        return {
          type: 'click',
          element: data.element,
          elementText: data.elementText,
          targetUrl: data.targetUrl,
          coordinates: data.coordinates,
          isExternal: data.isExternal ?? false,
          ...data,
        };
      case 'form_submit':
        return {
          type: 'form_submit',
          formId: data.formId,
          formName: data.formName,
          formAction: data.formAction,
          fields: data.fields || [],
          success: data.success ?? true,
          ...data,
        };
      case 'conversion':
        return {
          type: 'conversion',
          goalId: data.goalId,
          goalName: data.goalName,
          value: data.value,
          currency: data.currency || 'USD',
          orderId: data.orderId,
          products: data.products,
          ...data,
        };
      case 'scroll':
        return {
          type: 'scroll',
          maxDepth: data.maxDepth || 0,
          milestones: data.milestones || [],
          ...data,
        };
      default:
        return { type, ...data };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GOAL CHECKING
  // ═══════════════════════════════════════════════════════════════

  private async checkGoals(site: KPISite, session: KPISession, event: KPIEvent): Promise<void> {
    const goals = this.store.listGoals(site.id, true);
    
    for (const goal of goals) {
      if (this.matchesGoal(goal, event, session)) {
        // Build attribution
        const attribution = this.buildAttribution(session, 'last_touch');
        
        // Get funnel path
        const events = this.store.getEvents({ siteId: site.id, limit: 50 });
        const sessionEvents = events.filter(e => e.sessionId === session.id && e.eventType === 'page_view');
        const funnelPath = sessionEvents.map(e => (e.data as any).path || '');

        // Record conversion
        this.store.recordConversion({
          siteId: site.id,
          sessionId: session.id,
          goalId: goal.id,
          type: goal.type,
          value: goal.value,
          attribution,
          funnelPath,
        });
      }
    }
  }

  private matchesGoal(goal: KPIGoal, event: KPIEvent, session: KPISession): boolean {
    const config = goal.config as GoalConfig;

    switch (config.type) {
      case 'destination':
        if (event.eventType !== 'page_view') return false;
        const path = (event.data as any).path || '';
        if (config.matchType === 'exact') return path === config.url;
        if (config.matchType === 'starts_with') return path.startsWith(config.url);
        if (config.matchType === 'regex') {
          try {
            return new RegExp(config.url).test(path);
          } catch {
            return false;
          }
        }
        return false;

      case 'duration':
        const duration = session.duration;
        if (config.comparison === 'gte') return duration >= config.seconds;
        if (config.comparison === 'lte') return duration <= config.seconds;
        return false;

      case 'pages_per_session':
        const pages = session.pageCount;
        if (config.comparison === 'gte') return pages >= config.count;
        if (config.comparison === 'lte') return pages <= config.count;
        return false;

      case 'event':
        if (event.eventType !== 'custom') return false;
        const eventName = (event.data as any).name;
        if (eventName !== config.eventName) return false;
        
        if (config.conditions) {
          for (const [key, value] of Object.entries(config.conditions)) {
            if ((event.data as any)[key] !== value) return false;
          }
        }
        return true;

      default:
        return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ATTRIBUTION
  // ═══════════════════════════════════════════════════════════════

  private buildAttribution(session: KPISession, model: AttributionModel): AttributionData {
    const touchpoint: TouchPoint = {
      source: session.utm.source || (session.referrer ? 'referral' : 'direct'),
      medium: session.utm.medium,
      campaign: session.utm.campaign,
      timestamp: session.startedAt,
      page: session.entryPage,
      weight: 1,
    };

    return {
      model,
      source: touchpoint.source,
      medium: touchpoint.medium,
      campaign: touchpoint.campaign,
      touchpoints: [touchpoint],
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ANALYTICS RETRIEVAL
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get comprehensive analytics for a site
   */
  getAnalytics(siteId: string, timeRange: TimeRange = '30d'): KPIAnalytics {
    const site = this.store.getSite(siteId);
    if (!site) throw new Error('Site not found');

    const overview = this.store.getOverviewMetrics(siteId, timeRange);
    const topPages = this.store.getTopPages(siteId, timeRange);
    const sources = this.store.getTrafficSources(siteId, timeRange);
    const conversionMetrics = this.store.getConversionMetrics(siteId, timeRange);
    const activeVisitors = this.store.getActiveVisitors(siteId);
    const activePages = this.store.getActivePages(siteId);

    // Calculate previous period for comparison
    const prevRange = this.getPreviousTimeRange(timeRange);
    const prevOverview = this.store.getOverviewMetrics(siteId, prevRange);

    return {
      siteId,
      timeRange,
      period: this.getTimeRangeDates(timeRange),
      overview: {
        ...overview,
        pageViewsChange: this.calcPercentChange(overview.pageViews, prevOverview.pageViews),
        visitorsChange: this.calcPercentChange(overview.uniqueVisitors, prevOverview.uniqueVisitors),
      },
      traffic: {
        sources,
        mediums: this.getMediums(siteId, timeRange),
        campaigns: this.getCampaigns(siteId, timeRange),
        referrers: this.getReferrers(siteId, timeRange),
        topPages: topPages.map(p => ({
          path: p.path,
          views: p.views,
          avgDuration: Math.round(p.avgDuration || 0),
          bounceRate: 0, // Would need per-page bounce calculation
        })),
        entryPages: this.getEntryPages(siteId, timeRange),
        exitPages: this.getExitPages(siteId, timeRange),
      },
      engagement: {
        avgPagesPerSession: overview.sessions > 0 ? Math.round((overview.pageViews / overview.sessions) * 10) / 10 : 0,
        avgScrollDepth: this.getAvgScrollDepth(siteId, timeRange),
        clickEvents: this.store.countEvents(siteId, 'click', timeRange),
        formSubmissions: this.store.countEvents(siteId, 'form_submit', timeRange),
        downloads: 0, // Would track via custom events
        videoPlays: 0, // Would track via custom events
        timeOnSite: this.getTimeOnSiteDistribution(siteId, timeRange),
        scrollDistribution: this.getScrollDistribution(siteId, timeRange),
      },
      conversions: {
        ...conversionMetrics,
        goalCompletions: this.getGoalCompletions(siteId, timeRange),
        conversionsBySource: this.getConversionsBySource(siteId, timeRange),
        conversionPath: [], // Would need path tracking
      },
      realtime: {
        activeVisitors,
        activePages,
        eventsPerMinute: this.getEventsPerMinute(siteId),
        recentConversions: this.getRecentConversions(siteId),
        trafficByCountry: this.getTrafficByCountry(siteId),
      },
    };
  }

  private getPreviousTimeRange(range: TimeRange): TimeRange {
    // For comparison, we use the same range offset back
    return range;
  }

  private getTimeRangeDates(range: TimeRange): { start: string; end: string } {
    const now = new Date();
    const end = now.toISOString();
    let start: Date;

    switch (range) {
      case '1h': start = new Date(now.getTime() - 60 * 60 * 1000); break;
      case '24h': start = new Date(now.getTime() - 24 * 60 * 60 * 1000); break;
      case '7d': start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
      case '30d': start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
      case '90d': start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000); break;
      case '1y': start = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); break;
      default: start = new Date(0);
    }

    return { start: start.toISOString(), end };
  }

  private calcPercentChange(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
  }

  // Helper methods for analytics
  private getMediums(siteId: string, timeRange: TimeRange): { medium: string; visits: number; percentage: number }[] {
    // Simplified - would query sessions by utm_medium
    return [];
  }

  private getCampaigns(siteId: string, timeRange: TimeRange): { campaign: string; visits: number; conversions: number }[] {
    return [];
  }

  private getReferrers(siteId: string, timeRange: TimeRange): { referrer: string; visits: number }[] {
    return [];
  }

  private getEntryPages(siteId: string, timeRange: TimeRange): { path: string; entries: number; bounceRate: number }[] {
    return [];
  }

  private getExitPages(siteId: string, timeRange: TimeRange): { path: string; exits: number; exitRate: number }[] {
    return [];
  }

  private getAvgScrollDepth(siteId: string, timeRange: TimeRange): number {
    return 0; // Would aggregate from scroll events
  }

  private getTimeOnSiteDistribution(siteId: string, timeRange: TimeRange): { bucket: string; sessions: number }[] {
    return [
      { bucket: '0-10s', sessions: 0 },
      { bucket: '11-30s', sessions: 0 },
      { bucket: '31-60s', sessions: 0 },
      { bucket: '1-3m', sessions: 0 },
      { bucket: '3-10m', sessions: 0 },
      { bucket: '10m+', sessions: 0 },
    ];
  }

  private getScrollDistribution(siteId: string, timeRange: TimeRange): { depth: string; percentage: number }[] {
    return [
      { depth: '0-25%', percentage: 0 },
      { depth: '25-50%', percentage: 0 },
      { depth: '50-75%', percentage: 0 },
      { depth: '75-100%', percentage: 0 },
    ];
  }

  private getGoalCompletions(siteId: string, timeRange: TimeRange): { goalId: string; goalName: string; completions: number; value: number }[] {
    const goals = this.store.listGoals(siteId, true);
    const conversions = this.store.getConversions(siteId, timeRange);

    return goals.map(goal => {
      const goalConversions = conversions.filter(c => c.goalId === goal.id);
      return {
        goalId: goal.id,
        goalName: goal.name,
        completions: goalConversions.length,
        value: goalConversions.reduce((sum, c) => sum + (c.value || 0), 0),
      };
    });
  }

  private getConversionsBySource(siteId: string, timeRange: TimeRange): { source: string; conversions: number; value: number; rate: number }[] {
    return [];
  }

  private getEventsPerMinute(siteId: string): number {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const events = this.store.getEvents({
      siteId,
      startDate: oneMinuteAgo,
      endDate: new Date().toISOString(),
    });
    return events.length;
  }

  private getRecentConversions(siteId: string): { goalName: string; value?: number; timestamp: string }[] {
    const conversions = this.store.getConversions(siteId, '1h');
    const goals = this.store.listGoals(siteId);
    const goalMap = new Map(goals.map(g => [g.id, g.name]));

    return conversions.slice(0, 10).map(c => ({
      goalName: goalMap.get(c.goalId) || 'Unknown Goal',
      value: c.value,
      timestamp: c.timestamp,
    }));
  }

  private getTrafficByCountry(siteId: string): { country: string; visitors: number }[] {
    return [];
  }

  // ═══════════════════════════════════════════════════════════════
  // TIME SERIES
  // ═══════════════════════════════════════════════════════════════

  getTimeSeries(siteId: string, metric: 'page_views' | 'sessions' | 'visitors', timeRange: TimeRange) {
    return this.store.getTimeSeries(siteId, timeRange, metric);
  }

  // ═══════════════════════════════════════════════════════════════
  // FUNNEL ANALYTICS
  // ═══════════════════════════════════════════════════════════════

  getFunnelAnalytics(funnelId: string, timeRange: TimeRange = '30d') {
    return this.store.getFunnelAnalytics(funnelId, timeRange);
  }

  // ═══════════════════════════════════════════════════════════════
  // SITE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  createSite(data: Parameters<KPIStore['createSite']>[0]) {
    return this.store.createSite(data);
  }

  getSite(id: string) {
    return this.store.getSite(id);
  }

  listSites(communityId?: string) {
    return this.store.listSites(communityId);
  }

  updateSite(id: string, updates: Parameters<KPIStore['updateSite']>[1]) {
    return this.store.updateSite(id, updates);
  }

  deleteSite(id: string) {
    return this.store.deleteSite(id);
  }

  regenerateScriptKey(siteId: string) {
    return this.store.regenerateScriptKey(siteId);
  }

  // ═══════════════════════════════════════════════════════════════
  // GOAL MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  createGoal(data: Parameters<KPIStore['createGoal']>[0]) {
    return this.store.createGoal(data);
  }

  getGoal(id: string) {
    return this.store.getGoal(id);
  }

  listGoals(siteId: string) {
    return this.store.listGoals(siteId);
  }

  updateGoal(id: string, updates: Parameters<KPIStore['updateGoal']>[1]) {
    return this.store.updateGoal(id, updates);
  }

  deleteGoal(id: string) {
    return this.store.deleteGoal(id);
  }

  // ═══════════════════════════════════════════════════════════════
  // FUNNEL MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  createFunnel(data: Parameters<KPIStore['createFunnel']>[0]) {
    return this.store.createFunnel(data);
  }

  getFunnel(id: string) {
    return this.store.getFunnel(id);
  }

  listFunnels(siteId: string) {
    return this.store.listFunnels(siteId);
  }

  updateFunnel(id: string, updates: Parameters<KPIStore['updateFunnel']>[1]) {
    return this.store.updateFunnel(id, updates);
  }

  deleteFunnel(id: string) {
    return this.store.deleteFunnel(id);
  }

  // ═══════════════════════════════════════════════════════════════
  // REALTIME
  // ═══════════════════════════════════════════════════════════════

  getActiveVisitors(siteId: string) {
    return this.store.getActiveVisitors(siteId);
  }

  getActivePages(siteId: string) {
    return this.store.getActivePages(siteId);
  }

  // ═══════════════════════════════════════════════════════════════
  // MAINTENANCE
  // ═══════════════════════════════════════════════════════════════

  cleanup(): void {
    this.store.cleanupRealtimeData(15);
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════

let trackerInstance: KPITracker | null = null;

export function getKPITracker(): KPITracker {
  if (!trackerInstance) {
    trackerInstance = new KPITracker();
  }
  return trackerInstance;
}

export function resetKPITracker(): void {
  trackerInstance = null;
}
