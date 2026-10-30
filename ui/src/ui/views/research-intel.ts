/**
 * Research & News Intelligence Dashboard
 * Automated daily research aggregation with Notion sync
 * Sleek Black & Gold Theme
 */

import { html, nothing, TemplateResult } from 'lit';
import { commIcon, ensureCommunicationGlassStyles } from './communication-glass.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ResearchTopic {
  id: string;
  name: string;
  keywords: string[];
  category: 'crypto' | 'finance' | 'tech' | 'geopolitics' | 'custom';
  enabled: boolean;
  priority: 'high' | 'medium' | 'low';
  lastFetched?: number;
  articleCount?: number;
}

export interface WatchlistAsset {
  id: string;
  symbol: string;
  name: string;
  type: 'crypto' | 'stock' | 'forex' | 'commodity';
  enabled: boolean;
  alerts: boolean;
  lastPrice?: number;
  change24h?: number;
}

export interface ResearchArticle {
  id: string;
  title: string;
  summary: string;
  source: string;
  sourceUrl: string;
  publishedAt: number;
  fetchedAt: number;
  topics: string[];
  assets: string[];
  sentiment?: 'bullish' | 'bearish' | 'neutral';
  importance: 'breaking' | 'high' | 'medium' | 'low';
  notionPageId?: string;
  read: boolean;
  bookmarked: boolean;
}

export interface ResearchStats {
  totalArticles: number;
  todayArticles: number;
  unreadCount: number;
  lastSync: number;
  topicsCount: number;
  watchlistCount: number;
}

export interface ResearchIntelState {
  loading: boolean;
  error?: string;
  
  // Data
  topics: ResearchTopic[];
  watchlist: WatchlistAsset[];
  articles: ResearchArticle[];
  stats: ResearchStats;
  
  // UI State
  selectedTab: 'feed' | 'topics' | 'watchlist' | 'settings';
  selectedArticle?: string;
  filterTopic?: string;
  filterAsset?: string;
  filterImportance?: string;
  searchQuery: string;
  
  // Settings
  settings: {
    autoFetch: boolean;
    fetchInterval: number; // hours
    notionSync: boolean;
    notionDatabaseId?: string;
    maxArticlesPerTopic: number;
    summarizeArticles: boolean;
    sentimentAnalysis: boolean;
  };
}

export interface ResearchHandlers {
  onRefresh: () => void;
  onTabChange: (tab: ResearchIntelState['selectedTab']) => void;
  onSelectArticle: (id: string | null) => void;
  onMarkRead: (id: string) => void;
  onBookmark: (id: string) => void;
  onAddTopic: (topic: Partial<ResearchTopic>) => void;
  onRemoveTopic: (id: string) => void;
  onToggleTopic: (id: string) => void;
  onAddWatchlist: (asset: Partial<WatchlistAsset>) => void;
  onRemoveWatchlist: (id: string) => void;
  onToggleWatchlist: (id: string) => void;
  onUpdateSettings: (settings: Partial<ResearchIntelState['settings']>) => void;
  onFetchNow: () => void;
  onSyncNotion: () => void;
  onSearch: (query: string) => void;
  onFilter: (type: string, value: string | null) => void;
}

// =============================================================================
// INITIAL STATE
// =============================================================================

export function createResearchState(): ResearchIntelState {
  return {
    // The main /research route has no eager loader (only the grid adapter does),
    // so starting in a loading state leaves the full-page view spinning forever.
    // Render the honest empty dashboard immediately; refresh/data hydration can
    // still replace these defaults as soon as a caller supplies real data.
    loading: false,
    topics: [],
    watchlist: [],
    articles: [],
    stats: {
      totalArticles: 0,
      todayArticles: 0,
      unreadCount: 0,
      lastSync: 0,
      topicsCount: 0,
      watchlistCount: 0,
    },
    selectedTab: 'feed',
    searchQuery: '',
    settings: {
      autoFetch: true,
      fetchInterval: 6,
      notionSync: true,
      maxArticlesPerTopic: 10,
      summarizeArticles: true,
      sentimentAnalysis: true,
    },
  };
}

// =============================================================================
// MAIN VIEW
// =============================================================================

export function renderResearchIntel(
  state: ResearchIntelState,
  handlers: ResearchHandlers
): TemplateResult {
  ensureCommunicationGlassStyles();
  if (state.loading) {
    return html`
      <div class="ri-loading">
        <div class="ri-spinner"></div>
        <span>Loading intelligence feeds...</span>
      </div>
    `;
  }

  if (state.error) {
    return html`
      <div class="ri-error">
        <div class="ri-error-icon">${commIcon("alert", 24)}</div>
        <div class="ri-error-text">${state.error}</div>
        <button class="ri-btn gold" @click=${handlers.onRefresh}>${commIcon("refresh", 14)} Retry</button>
      </div>
    `;
  }

  return html`
    <div class="ri-dashboard">
      <!-- Header -->
      <div class="ri-header">
        <div class="ri-header-left">
          <div class="ri-logo">
            <span class="ri-logo-icon">${commIcon("search", 18)}</span>
            <span class="ri-logo-text">RESEARCH INTELLIGENCE</span>
          </div>
          <div class="ri-status-row">
            ${state.stats.unreadCount > 0 ? html`
              <span class="ri-status-pill unread">${state.stats.unreadCount} UNREAD</span>
            ` : nothing}
            <span class="ri-status-pill">${state.stats.todayArticles} TODAY</span>
            ${state.settings.autoFetch ? html`
              <span class="ri-status-pill active">◉ AUTO-FETCH</span>
            ` : nothing}
          </div>
        </div>
        <div class="ri-header-right">
          <div class="ri-metrics">
            <div class="ri-metric">
              <span class="ri-metric-value">${state.stats.totalArticles}</span>
              <span class="ri-metric-label">ARTICLES</span>
            </div>
            <div class="ri-metric">
              <span class="ri-metric-value">${state.topics.filter(t => t.enabled).length}</span>
              <span class="ri-metric-label">TOPICS</span>
            </div>
            <div class="ri-metric">
              <span class="ri-metric-value">${state.watchlist.filter(w => w.enabled).length}</span>
              <span class="ri-metric-label">WATCHLIST</span>
            </div>
          </div>
          <div class="ri-actions">
            <button class="ri-btn icon" @click=${handlers.onRefresh} title="Refresh">${commIcon("refresh", 15)}</button>
            <button class="ri-btn icon" @click=${handlers.onSyncNotion} title="Sync to Notion">${commIcon("list", 15)}</button>
            <button class="ri-btn gold" @click=${handlers.onFetchNow}>${commIcon("search", 14)} FETCH NOW</button>
          </div>
        </div>
      </div>

      <!-- Main Grid -->
      <div class="ri-grid">
        <!-- Left: Feed/List -->
        <div class="ri-panel ri-feed-panel">
          <div class="ri-tabs">
            ${(['feed', 'topics', 'watchlist', 'settings'] as const).map(tab => html`
              <button 
                class="ri-tab ${state.selectedTab === tab ? 'active' : ''}"
                @click=${() => handlers.onTabChange(tab)}
              >
                ${commIcon(tab === 'feed' ? 'list' : tab === 'topics' ? 'search' : tab === 'watchlist' ? 'star' : 'tag', 14)}
                ${tab.toUpperCase()}
                ${tab === 'feed' && state.stats.unreadCount > 0 ? html`<span class="ri-tab-badge">${state.stats.unreadCount}</span>` : nothing}
              </button>
            `)}
          </div>
          
          ${state.selectedTab === 'feed' ? renderFeedTab(state, handlers) : nothing}
          ${state.selectedTab === 'topics' ? renderTopicsTab(state, handlers) : nothing}
          ${state.selectedTab === 'watchlist' ? renderWatchlistTab(state, handlers) : nothing}
          ${state.selectedTab === 'settings' ? renderSettingsTab(state, handlers) : nothing}
        </div>

        <!-- Right: Article Detail / Preview -->
        <div class="ri-panel ri-detail-panel">
          ${renderDetailPanel(state, handlers)}
        </div>
      </div>
    </div>
  `;
}

// =============================================================================
// FEED TAB
// =============================================================================

function renderFeedTab(state: ResearchIntelState, handlers: ResearchHandlers): TemplateResult {
  // Filter articles
  let articles = [...state.articles];
  
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    articles = articles.filter(a => 
      a.title.toLowerCase().includes(q) || 
      a.summary.toLowerCase().includes(q)
    );
  }
  
  if (state.filterTopic) {
    articles = articles.filter(a => a.topics.includes(state.filterTopic!));
  }
  
  if (state.filterAsset) {
    articles = articles.filter(a => a.assets.includes(state.filterAsset!));
  }
  
  if (state.filterImportance) {
    articles = articles.filter(a => a.importance === state.filterImportance);
  }
  
  // Sort by date
  articles.sort((a, b) => b.publishedAt - a.publishedAt);

  return html`
    <div class="ri-feed">
      <!-- Search & Filters -->
      <div class="ri-filters">
        <div class="ri-search">
          <span class="ri-search-icon">${commIcon("search", 14)}</span>
          <input 
            type="text" 
            class="ri-search-input" 
            placeholder="Search articles..."
            .value=${state.searchQuery}
            @input=${(e: Event) => handlers.onSearch((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="ri-filter-row">
          <select class="ri-select" @change=${(e: Event) => handlers.onFilter('importance', (e.target as HTMLSelectElement).value || null)}>
            <option value="">All Importance</option>
            <option value="breaking">Breaking</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select class="ri-select" @change=${(e: Event) => handlers.onFilter('topic', (e.target as HTMLSelectElement).value || null)}>
            <option value="">All Topics</option>
            ${state.topics.map(t => html`<option value="${t.id}">${t.name}</option>`)}
          </select>
        </div>
      </div>

      <!-- Article List -->
      <div class="ri-article-list">
        ${articles.length === 0 ? html`
          <div class="ri-empty">
            <span class="ri-empty-icon">${commIcon("search", 24)}</span>
            <span>No articles found</span>
            <button class="ri-btn small gold" @click=${handlers.onFetchNow}>Fetch Articles</button>
          </div>
        ` : articles.map(article => renderArticleCard(article, state.selectedArticle, handlers))}
      </div>
    </div>
  `;
}

function renderArticleCard(
  article: ResearchArticle, 
  selectedId: string | undefined,
  handlers: ResearchHandlers
): TemplateResult {
  const isSelected = article.id === selectedId;
  const timeAgo = formatTimeAgo(article.publishedAt);
  
  return html`
    <div 
      class="ri-article-card ${isSelected ? 'selected' : ''} ${article.read ? 'read' : 'unread'} ${article.importance}"
      @click=${() => handlers.onSelectArticle(isSelected ? null : article.id)}
    >
      <div class="ri-article-header">
        <span class="ri-article-importance ${article.importance}">
          ${article.importance === 'breaking' ? commIcon('bolt', 14) : article.importance === 'high' ? '●' : article.importance === 'medium' ? '◐' : '○'}
        </span>
        <span class="ri-article-title">${article.title}</span>
        ${article.bookmarked ? html`<span class="ri-article-bookmark">${commIcon("star", 14)}</span>` : nothing}
      </div>
      <div class="ri-article-meta">
        <span class="ri-article-source">${article.source}</span>
        <span class="ri-article-time">${timeAgo}</span>
        ${article.sentiment ? html`
          <span class="ri-article-sentiment ${article.sentiment}">
            ${article.sentiment === 'bullish' ? '↑' : article.sentiment === 'bearish' ? '↓' : '→'}
          </span>
        ` : nothing}
      </div>
      <div class="ri-article-tags">
        ${article.topics.slice(0, 2).map(t => html`<span class="ri-tag topic">${t}</span>`)}
        ${article.assets.slice(0, 2).map(a => html`<span class="ri-tag asset">${a}</span>`)}
      </div>
    </div>
  `;
}

// =============================================================================
// TOPICS TAB
// =============================================================================

function renderTopicsTab(state: ResearchIntelState, handlers: ResearchHandlers): TemplateResult {
  const categories = ['crypto', 'finance', 'tech', 'geopolitics', 'custom'] as const;
  
  return html`
    <div class="ri-topics">
      <div class="ri-section-header">
        <span class="ri-section-title">${commIcon('search', 14)} RESEARCH TOPICS</span>
        <button class="ri-btn small gold" @click=${() => handlers.onAddTopic({ name: 'New Topic', category: 'custom', keywords: [], enabled: true, priority: 'medium' })}>+ ADD</button>
      </div>
      
      ${categories.map(cat => {
        const catTopics = state.topics.filter(t => t.category === cat);
        if (catTopics.length === 0) return nothing;
        
        return html`
          <div class="ri-topic-group">
            <div class="ri-topic-group-header">${cat.toUpperCase()}</div>
            ${catTopics.map(topic => html`
              <div class="ri-topic-card ${topic.enabled ? 'enabled' : 'disabled'}">
                <div class="ri-topic-main">
                  <button 
                    class="ri-toggle ${topic.enabled ? 'on' : 'off'}"
                    @click=${() => handlers.onToggleTopic(topic.id)}
                  >
                    ${topic.enabled ? '◉' : '○'}
                  </button>
                  <div class="ri-topic-info">
                    <span class="ri-topic-name">${topic.name}</span>
                    <span class="ri-topic-keywords">${topic.keywords.join(', ')}</span>
                  </div>
                  <span class="ri-topic-priority ${topic.priority}">${topic.priority}</span>
                </div>
                <div class="ri-topic-stats">
                  <span>${topic.articleCount || 0} articles</span>
                  ${topic.lastFetched ? html`<span>Last: ${formatTimeAgo(topic.lastFetched)}</span>` : nothing}
                </div>
                <button class="ri-btn-icon danger" aria-label="Remove topic" @click=${() => handlers.onRemoveTopic(topic.id)}>${commIcon('close', 14)}</button>
              </div>
            `)}
          </div>
        `;
      })}
      
      ${state.topics.length === 0 ? html`
        <div class="ri-empty">
          <span class="ri-empty-icon">${commIcon("search", 24)}</span>
          <span>No topics configured</span>
          <span class="ri-hint">Add topics to start gathering research</span>
        </div>
      ` : nothing}
    </div>
  `;
}

// =============================================================================
// WATCHLIST TAB
// =============================================================================

function renderWatchlistTab(state: ResearchIntelState, handlers: ResearchHandlers): TemplateResult {
  const types = ['crypto', 'stock', 'forex', 'commodity'] as const;
  
  return html`
    <div class="ri-watchlist">
      <div class="ri-section-header">
        <span class="ri-section-title">${commIcon('star', 14)} ASSET WATCHLIST</span>
        <button class="ri-btn small gold" @click=${() => handlers.onAddWatchlist({ symbol: 'NEW', name: 'New Asset', type: 'crypto', enabled: true, alerts: false })}>+ ADD</button>
      </div>
      
      ${types.map(type => {
        const typeAssets = state.watchlist.filter(w => w.type === type);
        if (typeAssets.length === 0) return nothing;
        
        return html`
          <div class="ri-watchlist-group">
            <div class="ri-watchlist-group-header">${type.toUpperCase()}</div>
            ${typeAssets.map(asset => html`
              <div class="ri-asset-card ${asset.enabled ? 'enabled' : 'disabled'}">
                <button 
                  class="ri-toggle ${asset.enabled ? 'on' : 'off'}"
                  @click=${() => handlers.onToggleWatchlist(asset.id)}
                >
                  ${asset.enabled ? '◉' : '○'}
                </button>
                <div class="ri-asset-info">
                  <span class="ri-asset-symbol">${asset.symbol}</span>
                  <span class="ri-asset-name">${asset.name}</span>
                </div>
                ${asset.lastPrice !== undefined ? html`
                  <div class="ri-asset-price">
                    <span class="ri-price-value">$${asset.lastPrice.toLocaleString()}</span>
                    ${asset.change24h !== undefined ? html`
                      <span class="ri-price-change ${asset.change24h >= 0 ? 'up' : 'down'}">
                        ${asset.change24h >= 0 ? '+' : ''}${asset.change24h.toFixed(2)}%
                      </span>
                    ` : nothing}
                  </div>
                ` : nothing}
                <button 
                  class="ri-btn-icon ${asset.alerts ? 'active' : ''}" 
                  @click=${() => {}}
                  title="Toggle Alerts"
                >
                  ${commIcon("bell", 15)}
                </button>
                <button class="ri-btn-icon danger" aria-label="Remove asset" @click=${() => handlers.onRemoveWatchlist(asset.id)}>${commIcon('close', 14)}</button>
              </div>
            `)}
          </div>
        `;
      })}
      
      ${state.watchlist.length === 0 ? html`
        <div class="ri-empty">
          <span class="ri-empty-icon">${commIcon("star", 24)}</span>
          <span>No assets in watchlist</span>
          <span class="ri-hint">Add crypto, stocks, or forex pairs to track</span>
        </div>
      ` : nothing}
    </div>
  `;
}

// =============================================================================
// SETTINGS TAB
// =============================================================================

function renderSettingsTab(state: ResearchIntelState, handlers: ResearchHandlers): TemplateResult {
  const { settings } = state;
  
  return html`
    <div class="ri-settings">
      <div class="ri-section-header">
        <span class="ri-section-title">${commIcon('tag', 14)} SETTINGS</span>
      </div>
      
      <div class="ri-settings-group">
        <div class="ri-settings-group-header">AUTOMATION</div>
        
        <div class="ri-setting-row">
          <div class="ri-setting-info">
            <span class="ri-setting-label">Auto-Fetch</span>
            <span class="ri-setting-desc">Automatically fetch new articles</span>
          </div>
          <button 
            class="ri-toggle-btn ${settings.autoFetch ? 'on' : 'off'}"
            @click=${() => handlers.onUpdateSettings({ autoFetch: !settings.autoFetch })}
          >
            ${settings.autoFetch ? 'ON' : 'OFF'}
          </button>
        </div>
        
        <div class="ri-setting-row">
          <div class="ri-setting-info">
            <span class="ri-setting-label">Fetch Interval</span>
            <span class="ri-setting-desc">Hours between automatic fetches</span>
          </div>
          <select 
            class="ri-select"
            .value=${String(settings.fetchInterval)}
            @change=${(e: Event) => handlers.onUpdateSettings({ fetchInterval: Number((e.target as HTMLSelectElement).value) })}
          >
            <option value="1">1 hour</option>
            <option value="3">3 hours</option>
            <option value="6">6 hours</option>
            <option value="12">12 hours</option>
            <option value="24">24 hours</option>
          </select>
        </div>
        
        <div class="ri-setting-row">
          <div class="ri-setting-info">
            <span class="ri-setting-label">Max Articles per Topic</span>
            <span class="ri-setting-desc">Limit articles fetched per topic</span>
          </div>
          <select 
            class="ri-select"
            .value=${String(settings.maxArticlesPerTopic)}
            @change=${(e: Event) => handlers.onUpdateSettings({ maxArticlesPerTopic: Number((e.target as HTMLSelectElement).value) })}
          >
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="50">50</option>
          </select>
        </div>
      </div>
      
      <div class="ri-settings-group">
        <div class="ri-settings-group-header">NOTION SYNC</div>
        
        <div class="ri-setting-row">
          <div class="ri-setting-info">
            <span class="ri-setting-label">Sync to Notion</span>
            <span class="ri-setting-desc">Save articles to Notion database</span>
          </div>
          <button 
            class="ri-toggle-btn ${settings.notionSync ? 'on' : 'off'}"
            @click=${() => handlers.onUpdateSettings({ notionSync: !settings.notionSync })}
          >
            ${settings.notionSync ? 'ON' : 'OFF'}
          </button>
        </div>
        
        <div class="ri-setting-row">
          <div class="ri-setting-info">
            <span class="ri-setting-label">Notion Database ID</span>
            <span class="ri-setting-desc">Target database for articles</span>
          </div>
          <input 
            type="text" 
            class="ri-input"
            placeholder="Enter database ID..."
            .value=${settings.notionDatabaseId || ''}
            @change=${(e: Event) => handlers.onUpdateSettings({ notionDatabaseId: (e.target as HTMLInputElement).value })}
          />
        </div>
      </div>
      
      <div class="ri-settings-group">
        <div class="ri-settings-group-header">AI PROCESSING</div>
        
        <div class="ri-setting-row">
          <div class="ri-setting-info">
            <span class="ri-setting-label">Summarize Articles</span>
            <span class="ri-setting-desc">Generate AI summaries for articles</span>
          </div>
          <button 
            class="ri-toggle-btn ${settings.summarizeArticles ? 'on' : 'off'}"
            @click=${() => handlers.onUpdateSettings({ summarizeArticles: !settings.summarizeArticles })}
          >
            ${settings.summarizeArticles ? 'ON' : 'OFF'}
          </button>
        </div>
        
        <div class="ri-setting-row">
          <div class="ri-setting-info">
            <span class="ri-setting-label">Sentiment Analysis</span>
            <span class="ri-setting-desc">Analyze bullish/bearish sentiment</span>
          </div>
          <button 
            class="ri-toggle-btn ${settings.sentimentAnalysis ? 'on' : 'off'}"
            @click=${() => handlers.onUpdateSettings({ sentimentAnalysis: !settings.sentimentAnalysis })}
          >
            ${settings.sentimentAnalysis ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>
    </div>
  `;
}

// =============================================================================
// DETAIL PANEL
// =============================================================================

function renderDetailPanel(state: ResearchIntelState, handlers: ResearchHandlers): TemplateResult {
  const article = state.selectedArticle 
    ? state.articles.find(a => a.id === state.selectedArticle)
    : null;
  
  if (!article) {
    return html`
      <div class="ri-detail-empty">
        <span class="ri-detail-empty-icon">${commIcon("search", 24)}</span>
        <span>Select an article to view</span>
      </div>
    `;
  }

  return html`
    <div class="ri-detail">
      <div class="ri-detail-header">
        <span class="ri-detail-importance ${article.importance}">
          ${article.importance.toUpperCase()}
        </span>
        ${article.sentiment ? html`
          <span class="ri-detail-sentiment ${article.sentiment}">
            ${article.sentiment === 'bullish' ? '↑ BULLISH' : article.sentiment === 'bearish' ? '↓ BEARISH' : '→ NEUTRAL'}
          </span>
        ` : nothing}
      </div>
      
      <h2 class="ri-detail-title">${article.title}</h2>
      
      <div class="ri-detail-meta">
        <span class="ri-detail-source">${article.source}</span>
        <span class="ri-detail-time">${new Date(article.publishedAt).toLocaleString()}</span>
      </div>
      
      <div class="ri-detail-tags">
        ${article.topics.map(t => html`<span class="ri-tag topic">${t}</span>`)}
        ${article.assets.map(a => html`<span class="ri-tag asset">${a}</span>`)}
      </div>
      
      <div class="ri-detail-summary">
        <div class="ri-detail-section-label">SUMMARY</div>
        <p>${article.summary}</p>
      </div>
      
      <div class="ri-detail-actions">
        <a href="${article.sourceUrl}" target="_blank" class="ri-btn gold full">
          ${commIcon("share", 14)} READ FULL ARTICLE
        </a>
        <div class="ri-detail-btn-row">
          <button 
            class="ri-btn ${article.read ? '' : 'active'}" 
            @click=${() => handlers.onMarkRead(article.id)}
          >
            ${article.read ? '○ Mark Unread' : '● Mark Read'}
          </button>
          <button 
            class="ri-btn ${article.bookmarked ? 'active' : ''}" 
            @click=${() => handlers.onBookmark(article.id)}
          >
            ${article.bookmarked
              ? html`${commIcon("star", 14)} Bookmarked`
              : html`${commIcon("bookmark", 14)} Bookmark`}
          </button>
        </div>
        ${article.notionPageId ? html`
          <div class="ri-notion-link">
            <span class="ri-notion-icon">${commIcon("list", 15)}</span>
            <span>Synced to Notion</span>
          </div>
        ` : nothing}
      </div>
    </div>
  `;
}

// =============================================================================
// HELPERS
// =============================================================================

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

// =============================================================================
// STYLES
// =============================================================================

export const researchIntelStyles = `
/* === DASHBOARD LAYOUT === */
.ri-dashboard {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 12px;
  padding: 12px;
  background: transparent;
  color: var(--glass-fg, var(--text, #e4e4e7));
  font-family: var(--glass-font, var(--font-ui, Inter, "SF Pro Display", -apple-system, sans-serif));
}

.ri-grid {
  display: grid;
  grid-template-columns: 1fr 400px;
  flex: 1;
  min-height: 0;
  gap: 12px;
  background: transparent;
}

/* === HEADER === */
.ri-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  background: var(--bg-accent, #0a0a0a);
  border-bottom: 1px solid var(--border, #27272a);
  flex-shrink: 0;
}

.ri-header-left { display: flex; align-items: center; gap: 20px; }
.ri-logo { display: flex; align-items: center; gap: 10px; }
.ri-logo-icon { color: var(--accent, var(--g-primary)); font-size: 1.25rem; text-shadow: 0 0 10px color-mix(in srgb, var(--g-primary) 30%, transparent); }
.ri-logo-text { font-size: 0.85rem; font-weight: 650; letter-spacing: 0.15em; color: var(--glass-fg, #fff); }
.ri-status-row { display: flex; gap: 8px; }

.ri-status-pill {
  padding: 4px 12px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  border-radius: 2px;
  border: 1px solid var(--border, #27272a);
  background: var(--bg-elevated, #111111);
  color: var(--muted, #a1a1aa);
}

.ri-status-pill.unread { background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.4); color: #ef4444; }
.ri-status-pill.active { background: rgba(34, 197, 94, 0.15); border-color: rgba(34, 197, 94, 0.4); color: #22c55e; }

.ri-header-right { display: flex; align-items: center; gap: 24px; }
.ri-metrics { display: flex; gap: 24px; }
.ri-metric { text-align: center; }
.ri-metric-value { font-size: 1.1rem; font-weight: 600; color: var(--accent, var(--g-primary)); }
.ri-metric-label { font-size: 0.6rem; color: var(--muted, #a1a1aa); letter-spacing: 0.1em; }
.ri-actions { display: flex; gap: 8px; }

/* === BUTTONS === */
.ri-btn {
  padding: 8px 16px;
  font-size: 0.75rem;
  font-weight: 600;
  font-family: inherit;
  letter-spacing: 0.05em;
  border: 1px solid var(--border, #27272a);
  border-radius: 2px;
  background: var(--bg-elevated, #111111);
  color: var(--text, #e4e4e7);
  cursor: pointer;
  transition: all 0.15s;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.ri-btn:hover { border-color: var(--accent, var(--g-primary)); box-shadow: 0 0 10px color-mix(in srgb, var(--g-primary) 10%, transparent); }
.ri-btn.icon { padding: 8px 10px; }
.ri-btn.gold { background: linear-gradient(180deg, var(--g-primary), var(--g-primary)); border-color: var(--g-primary); color: #000; }
.ri-btn.gold:hover { box-shadow: 0 0 20px color-mix(in srgb, var(--g-primary) 30%, transparent); }
.ri-btn.small { padding: 4px 10px; font-size: 0.65rem; }
.ri-btn.full { width: 100%; }
.ri-btn.active { border-color: var(--accent, var(--g-primary)); color: var(--accent, var(--g-primary)); }
.ri-btn-icon { padding: 4px 8px; background: transparent; border: none; color: var(--muted, #a1a1aa); cursor: pointer; font-size: 0.9rem; }
.ri-btn-icon:hover { color: var(--text, #e4e4e7); }
.ri-btn-icon.danger:hover { color: #ef4444; }
.ri-btn-icon.active { color: var(--accent, var(--g-primary)); }

/* === PANELS === */
.ri-panel {
  background: var(--bg-accent, #0a0a0a);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* === TABS === */
.ri-tabs {
  display: flex;
  border-bottom: 1px solid var(--border, #27272a);
  flex-shrink: 0;
}

.ri-tab {
  flex: 1;
  padding: 10px 16px;
  font-size: 0.7rem;
  font-weight: 600;
  font-family: inherit;
  letter-spacing: 0.1em;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--muted, #a1a1aa);
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.ri-tab:hover { color: var(--text, #e4e4e7); }
.ri-tab.active { color: var(--accent, var(--g-primary)); border-bottom-color: var(--accent, var(--g-primary)); }
.ri-tab-badge { background: #ef4444; color: #fff; font-size: 0.6rem; padding: 2px 6px; border-radius: 2px; }

/* === FEED === */
.ri-feed { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }

.ri-filters {
  padding: 12px;
  border-bottom: 1px solid var(--border, #27272a);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ri-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-elevated, #111111);
  border: 1px solid var(--border, #27272a);
  border-radius: 2px;
}

.ri-search-icon { color: var(--muted, #a1a1aa); }
.ri-search-input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--text, #e4e4e7);
  font-family: inherit;
  font-size: 0.85rem;
  outline: none;
}

.ri-search-input::placeholder { color: var(--muted-strong, #71717a); }

.ri-filter-row { display: flex; gap: 8px; }

.ri-select {
  flex: 1;
  padding: 6px 10px;
  background: var(--bg-elevated, #111111);
  border: 1px solid var(--border, #27272a);
  border-radius: 2px;
  color: var(--text, #e4e4e7);
  font-family: inherit;
  font-size: 0.75rem;
}

.ri-input {
  flex: 1;
  padding: 6px 10px;
  background: var(--bg-elevated, #111111);
  border: 1px solid var(--border, #27272a);
  border-radius: 2px;
  color: var(--text, #e4e4e7);
  font-family: inherit;
  font-size: 0.8rem;
}

.ri-article-list { flex: 1; overflow-y: auto; padding: 8px; }

/* === ARTICLE CARDS === */
.ri-article-card {
  padding: 12px;
  margin-bottom: 8px;
  background: var(--bg-elevated, #111111);
  border: 1px solid var(--border, #27272a);
  border-left: 3px solid var(--border, #27272a);
  border-radius: 2px;
  cursor: pointer;
  transition: all 0.15s;
}

.ri-article-card:hover { border-color: #3f3f46; }
.ri-article-card.selected { border-left-color: var(--accent, var(--g-primary)); background: color-mix(in srgb, var(--g-primary) 5%, transparent); }
.ri-article-card.unread { border-left-color: #3b82f6; }
.ri-article-card.breaking { border-left-color: #ef4444; }
.ri-article-card.high { border-left-color: #f97316; }

.ri-article-header { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 6px; }
.ri-article-importance { font-size: 0.9rem; flex-shrink: 0; }
.ri-article-importance.breaking { color: #ef4444; }
.ri-article-importance.high { color: #f97316; }
.ri-article-importance.medium { color: var(--accent, var(--g-primary)); }
.ri-article-importance.low { color: var(--muted, #a1a1aa); }
.ri-article-title { font-size: 0.85rem; font-weight: 500; color: var(--text, #e4e4e7); line-height: 1.4; flex: 1; }
.ri-article-bookmark { color: var(--accent, var(--g-primary)); }

.ri-article-meta {
  display: flex;
  gap: 12px;
  font-size: 0.7rem;
  color: var(--muted, #a1a1aa);
  margin-bottom: 8px;
}

.ri-article-sentiment.bullish { color: #22c55e; }
.ri-article-sentiment.bearish { color: #ef4444; }
.ri-article-sentiment.neutral { color: var(--muted, #a1a1aa); }

.ri-article-tags { display: flex; gap: 6px; flex-wrap: wrap; }

.ri-tag {
  font-size: 0.6rem;
  padding: 2px 6px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--muted, #a1a1aa);
}

.ri-tag.topic { background: rgba(59, 130, 246, 0.15); color: #3b82f6; }
.ri-tag.asset { background: color-mix(in srgb, var(--g-primary) 15%, transparent); color: var(--accent, var(--g-primary)); }

/* === TOPICS & WATCHLIST === */
.ri-topics, .ri-watchlist, .ri-settings { flex: 1; overflow-y: auto; padding: 12px; }

.ri-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--muted, #a1a1aa);
  margin-bottom: 12px;
}
.ri-section-title { display: inline-flex; align-items: center; gap: 7px; }

.ri-topic-group, .ri-watchlist-group { margin-bottom: 16px; }
.ri-topic-group-header, .ri-watchlist-group-header {
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--muted-strong, #71717a);
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 2px;
  margin-bottom: 8px;
}

.ri-topic-card, .ri-asset-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-elevated, #111111);
  border: 1px solid var(--border, #27272a);
  border-radius: 2px;
  margin-bottom: 6px;
}

.ri-topic-card.disabled, .ri-asset-card.disabled { opacity: 0.5; }

.ri-toggle {
  background: none;
  border: none;
  font-size: 1rem;
  cursor: pointer;
  color: var(--muted, #a1a1aa);
  padding: 0;
}

.ri-toggle.on { color: var(--accent, var(--g-primary)); }

.ri-topic-info, .ri-asset-info { flex: 1; min-width: 0; }
.ri-topic-name, .ri-asset-symbol { font-size: 0.85rem; font-weight: 500; color: var(--text, #e4e4e7); display: block; }
.ri-topic-keywords, .ri-asset-name { font-size: 0.7rem; color: var(--muted, #a1a1aa); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.ri-topic-priority {
  font-size: 0.6rem;
  padding: 2px 6px;
  border-radius: 2px;
  text-transform: uppercase;
}

.ri-topic-priority.high { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
.ri-topic-priority.medium { background: color-mix(in srgb, var(--g-primary) 15%, transparent); color: var(--accent, var(--g-primary)); }
.ri-topic-priority.low { background: rgba(107, 114, 128, 0.2); color: #9ca3af; }

.ri-topic-stats { font-size: 0.65rem; color: var(--muted-strong, #71717a); display: flex; gap: 12px; }

.ri-asset-price { text-align: right; }
.ri-price-value { font-size: 0.85rem; font-weight: 500; color: var(--text, #e4e4e7); display: block; }
.ri-price-change { font-size: 0.7rem; }
.ri-price-change.up { color: #22c55e; }
.ri-price-change.down { color: #ef4444; }

/* === SETTINGS === */
.ri-settings-group { margin-bottom: 20px; }
.ri-settings-group-header {
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--muted-strong, #71717a);
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 2px;
  margin-bottom: 8px;
}

.ri-setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background: var(--bg-elevated, #111111);
  border: 1px solid var(--border, #27272a);
  border-radius: 2px;
  margin-bottom: 6px;
}

.ri-setting-info { flex: 1; }
.ri-setting-label { font-size: 0.85rem; color: var(--text, #e4e4e7); display: block; }
.ri-setting-desc { font-size: 0.7rem; color: var(--muted, #a1a1aa); }

.ri-toggle-btn {
  padding: 6px 14px;
  font-size: 0.7rem;
  font-weight: 600;
  font-family: inherit;
  border: 1px solid var(--border, #27272a);
  border-radius: 2px;
  cursor: pointer;
  transition: all 0.15s;
}

.ri-toggle-btn.off { background: var(--bg, #050505); color: var(--muted, #a1a1aa); }
.ri-toggle-btn.on { background: rgba(34, 197, 94, 0.2); border-color: #22c55e; color: #22c55e; }

/* === DETAIL PANEL === */
.ri-detail-panel { border-left: 1px solid var(--border, #27272a); }

.ri-detail-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted-strong, #71717a);
  gap: 8px;
}

.ri-detail-empty-icon { font-size: 3rem; opacity: 0.3; }

.ri-detail { padding: 20px; overflow-y: auto; height: 100%; }

.ri-detail-header { display: flex; gap: 10px; margin-bottom: 12px; }

.ri-detail-importance {
  font-size: 0.65rem;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 2px;
}

.ri-detail-importance.breaking { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
.ri-detail-importance.high { background: rgba(249, 115, 22, 0.2); color: #f97316; }
.ri-detail-importance.medium { background: color-mix(in srgb, var(--g-primary) 15%, transparent); color: var(--accent, var(--g-primary)); }
.ri-detail-importance.low { background: rgba(107, 114, 128, 0.2); color: #9ca3af; }

.ri-detail-sentiment {
  font-size: 0.65rem;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 2px;
}

.ri-detail-sentiment.bullish { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
.ri-detail-sentiment.bearish { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
.ri-detail-sentiment.neutral { background: rgba(107, 114, 128, 0.2); color: #9ca3af; }

.ri-detail-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--glass-fg, #fff);
  line-height: 1.4;
  margin: 0 0 12px 0;
}

.ri-detail-meta {
  display: flex;
  gap: 16px;
  font-size: 0.75rem;
  color: var(--muted, #a1a1aa);
  margin-bottom: 12px;
}

.ri-detail-tags { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }

.ri-detail-summary {
  background: var(--bg-elevated, #111111);
  border: 1px solid var(--border, #27272a);
  border-radius: 2px;
  padding: 16px;
  margin-bottom: 20px;
}

.ri-detail-section-label {
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--muted-strong, #71717a);
  margin-bottom: 10px;
}

.ri-detail-summary p {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.6;
  color: var(--text, #e4e4e7);
}

.ri-detail-actions { display: flex; flex-direction: column; gap: 10px; }
.ri-detail-btn-row { display: flex; gap: 8px; }
.ri-detail-btn-row .ri-btn { flex: 1; }

.ri-notion-link {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px;
  background: color-mix(in srgb, var(--g-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
  border-radius: 2px;
  font-size: 0.75rem;
  color: var(--accent, var(--g-primary));
}

/* === EMPTY STATE === */
.ri-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: var(--muted-strong, #71717a);
  gap: 8px;
  text-align: center;
}

.ri-empty-icon { font-size: 2rem; opacity: 0.3; }
.ri-hint { font-size: 0.75rem; color: var(--muted-strong, #71717a); }

/* === LOADING / ERROR === */
.ri-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;
  color: var(--muted, #a1a1aa);
}

.ri-spinner {
  width: 32px;
  height: 32px;
  border: 2px solid var(--border, #27272a);
  border-top-color: var(--accent, var(--g-primary));
  border-radius: 50%;
  animation: ri-spin 1s linear infinite;
}

@keyframes ri-spin { to { transform: rotate(360deg); } }

.ri-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: var(--muted, #a1a1aa);
}

.ri-error-icon { font-size: 2rem; color: #ef4444; }

/* === RESPONSIVE === */
@media (max-width: 1000px) {
  .ri-grid { grid-template-columns: 1fr; }
  .ri-detail-panel { display: none; }
}
@media (max-width: 640px) {
  .ri-dashboard { padding: 8px; gap: 8px; }
  .ri-header { align-items: stretch; flex-direction: column; gap: 12px; padding: 14px; }
  .ri-header-left, .ri-header-right { align-items: stretch; flex-direction: column; gap: 10px; min-width: 0; }
  .ri-logo { min-width: 0; }
  .ri-logo-text { font-size: 0.75rem; letter-spacing: 0.11em; overflow: hidden; text-overflow: ellipsis; }
  .ri-status-row, .ri-actions { flex-wrap: wrap; }
  .ri-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .ri-actions .ri-btn { flex: 1 1 auto; min-height: 42px; }
  .ri-tabs { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
  .ri-tab { flex: 0 0 auto; min-height: 42px; padding-inline: 12px; }
  .ri-filter-row { flex-direction: column; }
  .ri-section-header { gap: 8px; }
  .ri-topic-card, .ri-asset-card { align-items: flex-start; flex-wrap: wrap; }
  .ri-asset-price { margin-left: auto; }
  .ri-detail-btn-row { flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) {
  .ri-dashboard *, .ri-dashboard *::before, .ri-dashboard *::after {
    animation: none !important;
    transition: none !important;
  }
}
`;

// =============================================================================
// STYLE INJECTION
// =============================================================================

let researchStylesInjected = false;

export function injectResearchStyles(): void {
  if (researchStylesInjected) return;
  researchStylesInjected = true;
  
  const style = document.createElement('style');
  style.id = 'research-intel-styles';
  style.textContent = researchIntelStyles;
  document.head.appendChild(style);
}
