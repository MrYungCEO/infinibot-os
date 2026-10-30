/**
 * Research Intelligence Controller
 * Handles state management and API calls for research/news aggregation
 */

import { GatewayBrowserClient } from '../../gateway/client.js';
import type { 
  ResearchIntelState, 
  ResearchTopic, 
  WatchlistAsset, 
  ResearchArticle,
  ResearchStats 
} from '../views/research-intel.js';

// =============================================================================
// STATE FACTORY
// =============================================================================

export function createResearchIntelState(): ResearchIntelState {
  return {
    loading: true,
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
// API CALLS
// =============================================================================

export async function loadResearchData(client: GatewayBrowserClient): Promise<Partial<ResearchIntelState>> {
  try {
    const result = await client.request('research:status', {});
    
    if (!result) {
      return { loading: false, error: 'No response from server' };
    }
    
    const data = result as any;
    
    return {
      loading: false,
      topics: data.topics || [],
      watchlist: data.watchlist || [],
      articles: data.articles || [],
      stats: data.stats || {
        totalArticles: data.articles?.length || 0,
        todayArticles: 0,
        unreadCount: data.articles?.filter((a: any) => !a.read).length || 0,
        lastSync: data.lastSync || 0,
        topicsCount: data.topics?.length || 0,
        watchlistCount: data.watchlist?.length || 0,
      },
      settings: data.settings || undefined,
    };
  } catch (e) {
    console.error('[ResearchIntel] Failed to load data:', e);
    return { loading: false, error: String(e) };
  }
}

export async function addTopic(client: GatewayBrowserClient, topic: Partial<ResearchTopic>): Promise<ResearchTopic | null> {
  try {
    const result = await client.request('research:topic.add', topic);
    return (result as any)?.topic || null;
  } catch (e) {
    console.error('[ResearchIntel] Failed to add topic:', e);
    return null;
  }
}

export async function removeTopic(client: GatewayBrowserClient, id: string): Promise<boolean> {
  try {
    await client.request('research:topic.remove', { id });
    return true;
  } catch (e) {
    console.error('[ResearchIntel] Failed to remove topic:', e);
    return false;
  }
}

export async function toggleTopic(client: GatewayBrowserClient, id: string): Promise<boolean> {
  try {
    await client.request('research:topic.toggle', { id });
    return true;
  } catch (e) {
    console.error('[ResearchIntel] Failed to toggle topic:', e);
    return false;
  }
}

export async function addWatchlistAsset(client: GatewayBrowserClient, asset: Partial<WatchlistAsset>): Promise<WatchlistAsset | null> {
  try {
    const result = await client.request('research:watchlist.add', asset);
    return (result as any)?.asset || null;
  } catch (e) {
    console.error('[ResearchIntel] Failed to add watchlist asset:', e);
    return null;
  }
}

export async function removeWatchlistAsset(client: GatewayBrowserClient, id: string): Promise<boolean> {
  try {
    await client.request('research:watchlist.remove', { id });
    return true;
  } catch (e) {
    console.error('[ResearchIntel] Failed to remove watchlist asset:', e);
    return false;
  }
}

export async function toggleWatchlistAsset(client: GatewayBrowserClient, id: string): Promise<boolean> {
  try {
    await client.request('research:watchlist.toggle', { id });
    return true;
  } catch (e) {
    console.error('[ResearchIntel] Failed to toggle watchlist asset:', e);
    return false;
  }
}

export async function markArticleRead(client: GatewayBrowserClient, id: string): Promise<boolean> {
  try {
    await client.request('research:article.read', { id });
    return true;
  } catch (e) {
    console.error('[ResearchIntel] Failed to mark article read:', e);
    return false;
  }
}

export async function bookmarkArticle(client: GatewayBrowserClient, id: string): Promise<boolean> {
  try {
    await client.request('research:article.bookmark', { id });
    return true;
  } catch (e) {
    console.error('[ResearchIntel] Failed to bookmark article:', e);
    return false;
  }
}

export async function updateSettings(client: GatewayBrowserClient, settings: Partial<ResearchIntelState['settings']>): Promise<boolean> {
  try {
    await client.request('research:settings.update', settings);
    return true;
  } catch (e) {
    console.error('[ResearchIntel] Failed to update settings:', e);
    return false;
  }
}

export async function fetchNow(client: GatewayBrowserClient): Promise<{ count: number } | null> {
  try {
    const result = await client.request('research:fetch', {});
    return result as any;
  } catch (e) {
    console.error('[ResearchIntel] Failed to fetch:', e);
    return null;
  }
}

export async function syncToNotion(client: GatewayBrowserClient): Promise<{ synced: number } | null> {
  try {
    const result = await client.request('research:notion.sync', {});
    return result as any;
  } catch (e) {
    console.error('[ResearchIntel] Failed to sync to Notion:', e);
    return null;
  }
}

// =============================================================================
// DEFAULT TOPICS
// =============================================================================

export const DEFAULT_TOPICS: Partial<ResearchTopic>[] = [
  // Crypto
  { name: 'Bitcoin', keywords: ['bitcoin', 'btc', 'satoshi'], category: 'crypto', priority: 'high' },
  { name: 'Ethereum', keywords: ['ethereum', 'eth', 'vitalik'], category: 'crypto', priority: 'high' },
  { name: 'DeFi', keywords: ['defi', 'decentralized finance', 'yield farming', 'liquidity'], category: 'crypto', priority: 'medium' },
  { name: 'NFTs', keywords: ['nft', 'non-fungible', 'digital art', 'collectibles'], category: 'crypto', priority: 'low' },
  
  // Finance
  { name: 'Federal Reserve', keywords: ['fed', 'federal reserve', 'fomc', 'interest rates', 'powell'], category: 'finance', priority: 'high' },
  { name: 'Stock Market', keywords: ['s&p 500', 'nasdaq', 'dow jones', 'stock market'], category: 'finance', priority: 'medium' },
  { name: 'Economic Indicators', keywords: ['gdp', 'inflation', 'unemployment', 'cpi', 'pce'], category: 'finance', priority: 'high' },
  
  // Tech
  { name: 'AI & Machine Learning', keywords: ['artificial intelligence', 'ai', 'machine learning', 'llm', 'openai', 'anthropic'], category: 'tech', priority: 'high' },
  { name: 'Semiconductors', keywords: ['nvidia', 'amd', 'tsmc', 'chips', 'semiconductor'], category: 'tech', priority: 'medium' },
  
  // Geopolitics
  { name: 'US-China Relations', keywords: ['china', 'us china', 'trade war', 'tariffs', 'taiwan'], category: 'geopolitics', priority: 'high' },
  { name: 'Global Conflicts', keywords: ['ukraine', 'russia', 'war', 'conflict', 'sanctions'], category: 'geopolitics', priority: 'medium' },
];

export const DEFAULT_WATCHLIST: Partial<WatchlistAsset>[] = [
  // Crypto
  { symbol: 'BTC', name: 'Bitcoin', type: 'crypto', alerts: true },
  { symbol: 'ETH', name: 'Ethereum', type: 'crypto', alerts: true },
  { symbol: 'SOL', name: 'Solana', type: 'crypto', alerts: false },
  { symbol: 'LINK', name: 'Chainlink', type: 'crypto', alerts: false },
  
  // Stocks
  { symbol: 'SPY', name: 'S&P 500 ETF', type: 'stock', alerts: true },
  { symbol: 'QQQ', name: 'Nasdaq 100 ETF', type: 'stock', alerts: false },
  { symbol: 'NVDA', name: 'NVIDIA', type: 'stock', alerts: true },
  
  // Forex
  { symbol: 'DXY', name: 'US Dollar Index', type: 'forex', alerts: true },
  
  // Commodities
  { symbol: 'GOLD', name: 'Gold', type: 'commodity', alerts: true },
];
