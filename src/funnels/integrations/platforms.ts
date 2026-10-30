/**
 * Platform Integration Definitions
 * Each platform's API config, features, and KPIs
 */

import type { PlatformIntegration, NodeIOConfig } from './types.js';

// ═══════════════════════════════════════════════════════════════
// INSTAGRAM
// ═══════════════════════════════════════════════════════════════

export const instagramIntegration: PlatformIntegration = {
  platformId: 'instagram',
  name: 'Instagram',
  icon: 'instagram',
  color: '#E4405F',
  description: 'Instagram Business/Creator account integration',
  
  methods: ['oauth', 'api_key', 'scraping'],
  preferredMethod: 'oauth',
  
  oauth: {
    authUrl: 'https://api.instagram.com/oauth/authorize',
    tokenUrl: 'https://api.instagram.com/oauth/access_token',
    scopes: ['user_profile', 'user_media', 'instagram_basic', 'instagram_manage_messages'],
    clientIdEnvVar: 'INSTAGRAM_CLIENT_ID',
    clientSecretEnvVar: 'INSTAGRAM_CLIENT_SECRET',
  },
  
  api: {
    baseUrl: 'https://graph.instagram.com',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  },
  
  features: [
    {
      id: 'dm_flows',
      name: 'DM Automation',
      description: 'Automated DM responses and flows via ManyChat',
      icon: 'message',
      requiredIntegration: 'manychat',
      configSchema: {
        flowId: { type: 'string', label: 'ManyChat Flow ID', required: true },
        triggerKeyword: { type: 'string', label: 'Trigger Keyword', placeholder: 'e.g., INFO' },
        welcomeMessage: { type: 'string', label: 'Welcome Message' },
      },
    },
    {
      id: 'link_in_bio',
      name: 'Link in Bio',
      description: 'Track clicks from bio link',
      icon: 'link',
      configSchema: {
        bioUrl: { type: 'string', label: 'Bio Link URL', required: true },
        trackingEnabled: { type: 'boolean', label: 'Enable Click Tracking', default: true },
      },
    },
    {
      id: 'story_links',
      name: 'Story Links',
      description: 'Track story link sticker clicks',
      icon: 'image',
    },
    {
      id: 'comment_triggers',
      name: 'Comment Triggers',
      description: 'Trigger DM flows based on post comments',
      icon: 'comment',
      requiredIntegration: 'manychat',
      configSchema: {
        triggerWords: { type: 'string', label: 'Trigger Words (comma-separated)' },
        responseFlowId: { type: 'string', label: 'Response Flow ID' },
      },
    },
  ],
  
  kpis: [
    { id: 'followers', name: 'Followers', description: 'Total follower count', unit: '', format: 'number', fetchMethod: 'api', apiEndpoint: '/me?fields=followers_count', refreshIntervalMs: 3600000 },
    { id: 'reach', name: 'Reach', description: 'Accounts reached (30 days)', unit: '', format: 'number', fetchMethod: 'api', apiEndpoint: '/me/insights?metric=reach&period=days_28', refreshIntervalMs: 86400000 },
    { id: 'engagement_rate', name: 'Engagement Rate', description: 'Avg engagement per post', unit: '%', format: 'percent', fetchMethod: 'api', refreshIntervalMs: 86400000 },
    { id: 'profile_views', name: 'Profile Views', description: 'Profile visits (7 days)', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 86400000 },
    { id: 'dm_conversations', name: 'DM Conversations', description: 'Active DM threads', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 3600000 },
  ],
};

export const instagramIO: NodeIOConfig = {
  inputs: [
    { id: 'lead_in', name: 'Lead', type: 'data', direction: 'input', dataType: 'lead' },
  ],
  outputs: [
    { id: 'new_follower', name: 'New Follower', type: 'trigger', direction: 'output', dataType: 'lead' },
    { id: 'dm_received', name: 'DM Received', type: 'trigger', direction: 'output', dataType: 'message' },
    { id: 'comment', name: 'Comment', type: 'trigger', direction: 'output', dataType: 'event' },
    { id: 'link_click', name: 'Bio Link Click', type: 'trigger', direction: 'output', dataType: 'event' },
  ],
};

// ═══════════════════════════════════════════════════════════════
// TIKTOK
// ═══════════════════════════════════════════════════════════════

export const tiktokIntegration: PlatformIntegration = {
  platformId: 'tiktok',
  name: 'TikTok',
  icon: 'tiktok',
  color: '#000000',
  description: 'TikTok Business account integration',
  
  methods: ['oauth', 'scraping'],
  preferredMethod: 'oauth',
  
  oauth: {
    authUrl: 'https://www.tiktok.com/v2/auth/authorize',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    scopes: ['user.info.basic', 'video.list', 'user.info.stats'],
    clientIdEnvVar: 'TIKTOK_CLIENT_KEY',
    clientSecretEnvVar: 'TIKTOK_CLIENT_SECRET',
  },
  
  api: {
    baseUrl: 'https://open.tiktokapis.com/v2',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  },
  
  features: [
    {
      id: 'link_in_bio',
      name: 'Link in Bio',
      description: 'Track clicks from bio link',
      icon: 'link',
      configSchema: {
        bioUrl: { type: 'string', label: 'Bio Link URL', required: true },
      },
    },
    {
      id: 'video_cta',
      name: 'Video CTAs',
      description: 'Track video call-to-action engagement',
      icon: 'video',
    },
  ],
  
  kpis: [
    { id: 'followers', name: 'Followers', description: 'Total follower count', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 3600000 },
    { id: 'video_views', name: 'Video Views', description: 'Total video views (30 days)', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 86400000 },
    { id: 'likes', name: 'Likes', description: 'Total likes received', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 86400000 },
    { id: 'shares', name: 'Shares', description: 'Total shares', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 86400000 },
  ],
};

export const tiktokIO: NodeIOConfig = {
  inputs: [
    { id: 'lead_in', name: 'Lead', type: 'data', direction: 'input', dataType: 'lead' },
  ],
  outputs: [
    { id: 'new_follower', name: 'New Follower', type: 'trigger', direction: 'output', dataType: 'lead' },
    { id: 'video_view', name: 'Video View', type: 'trigger', direction: 'output', dataType: 'event' },
    { id: 'link_click', name: 'Bio Link Click', type: 'trigger', direction: 'output', dataType: 'event' },
  ],
};

// ═══════════════════════════════════════════════════════════════
// YOUTUBE
// ═══════════════════════════════════════════════════════════════

export const youtubeIntegration: PlatformIntegration = {
  platformId: 'youtube',
  name: 'YouTube',
  icon: 'youtube',
  color: '#FF0000',
  description: 'YouTube channel integration',
  
  methods: ['oauth', 'api_key'],
  preferredMethod: 'oauth',
  
  oauth: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'],
    clientIdEnvVar: 'GOOGLE_CLIENT_ID',
    clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET',
  },
  
  api: {
    baseUrl: 'https://www.googleapis.com/youtube/v3',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  },
  
  features: [
    {
      id: 'link_in_bio',
      name: 'Channel Links',
      description: 'Track channel link clicks',
      icon: 'link',
    },
    {
      id: 'video_cards',
      name: 'Video Cards',
      description: 'Track end screen and card clicks',
      icon: 'card',
    },
    {
      id: 'description_links',
      name: 'Description Links',
      description: 'Track video description link clicks',
      icon: 'link',
    },
    {
      id: 'pinned_comments',
      name: 'Pinned Comments',
      description: 'Track pinned comment link clicks',
      icon: 'comment',
    },
  ],
  
  kpis: [
    { id: 'subscribers', name: 'Subscribers', description: 'Total subscriber count', unit: '', format: 'number', fetchMethod: 'api', apiEndpoint: '/channels?part=statistics&mine=true', refreshIntervalMs: 3600000 },
    { id: 'views', name: 'Total Views', description: 'Lifetime channel views', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 86400000 },
    { id: 'watch_time', name: 'Watch Time', description: 'Total watch hours (30 days)', unit: 'hrs', format: 'duration', fetchMethod: 'api', refreshIntervalMs: 86400000 },
    { id: 'ctr', name: 'CTR', description: 'Click-through rate', unit: '%', format: 'percent', fetchMethod: 'api', refreshIntervalMs: 86400000 },
  ],
};

export const youtubeIO: NodeIOConfig = {
  inputs: [
    { id: 'lead_in', name: 'Lead', type: 'data', direction: 'input', dataType: 'lead' },
  ],
  outputs: [
    { id: 'new_subscriber', name: 'New Subscriber', type: 'trigger', direction: 'output', dataType: 'lead' },
    { id: 'video_view', name: 'Video View', type: 'trigger', direction: 'output', dataType: 'event' },
    { id: 'link_click', name: 'Link Click', type: 'trigger', direction: 'output', dataType: 'event' },
    { id: 'comment', name: 'Comment', type: 'trigger', direction: 'output', dataType: 'event' },
  ],
};

// ═══════════════════════════════════════════════════════════════
// MANYCHAT
// ═══════════════════════════════════════════════════════════════

export const manychatIntegration: PlatformIntegration = {
  platformId: 'manychat',
  name: 'ManyChat',
  icon: 'manychat',
  color: '#0084FF',
  description: 'ManyChat automation for Instagram/FB DMs',
  
  methods: ['api_key'],
  preferredMethod: 'api_key',
  
  api: {
    baseUrl: 'https://api.manychat.com',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  },
  
  features: [
    {
      id: 'dm_automation',
      name: 'DM Automation',
      description: 'Automated DM flows and sequences',
      icon: 'message',
      configSchema: {
        defaultFlowId: { type: 'string', label: 'Default Flow ID' },
        enableKeywords: { type: 'boolean', label: 'Enable Keyword Triggers', default: true },
      },
    },
    {
      id: 'comment_automation',
      name: 'Comment Automation',
      description: 'Auto-reply to comments with DMs',
      icon: 'comment',
    },
    {
      id: 'subscriber_tags',
      name: 'Subscriber Tags',
      description: 'Tag and segment subscribers',
      icon: 'tag',
    },
    {
      id: 'custom_fields',
      name: 'Custom Fields',
      description: 'Store lead data in custom fields',
      icon: 'database',
    },
  ],
  
  kpis: [
    { id: 'subscribers', name: 'Subscribers', description: 'Total ManyChat subscribers', unit: '', format: 'number', fetchMethod: 'api', apiEndpoint: '/fb/subscriber/getInfo', refreshIntervalMs: 3600000 },
    { id: 'active_subscribers', name: 'Active Subscribers', description: 'Subscribers active in 24h', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 86400000 },
    { id: 'messages_sent', name: 'Messages Sent', description: 'Total messages sent (30 days)', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 86400000 },
    { id: 'open_rate', name: 'Open Rate', description: 'Message open rate', unit: '%', format: 'percent', fetchMethod: 'api', refreshIntervalMs: 86400000 },
  ],
};

export const manychatIO: NodeIOConfig = {
  inputs: [
    { id: 'trigger', name: 'Trigger', type: 'trigger', direction: 'input', dataType: 'any' },
    { id: 'lead_in', name: 'Lead Data', type: 'data', direction: 'input', dataType: 'lead' },
  ],
  outputs: [
    { id: 'dm_sent', name: 'DM Sent', type: 'trigger', direction: 'output', dataType: 'event' },
    { id: 'reply_received', name: 'Reply Received', type: 'trigger', direction: 'output', dataType: 'message' },
    { id: 'tag_applied', name: 'Tag Applied', type: 'trigger', direction: 'output', dataType: 'event' },
    { id: 'flow_completed', name: 'Flow Completed', type: 'trigger', direction: 'output', dataType: 'lead' },
  ],
};

// ═══════════════════════════════════════════════════════════════
// TELEGRAM
// ═══════════════════════════════════════════════════════════════

export const telegramIntegration: PlatformIntegration = {
  platformId: 'telegram',
  name: 'Telegram',
  icon: 'telegram',
  color: '#0088CC',
  description: 'Telegram bot and channel integration',
  
  methods: ['api_key', 'webhook'],
  preferredMethod: 'api_key',
  
  api: {
    baseUrl: 'https://api.telegram.org/bot',
    authHeader: '', // Token is in URL
  },
  
  features: [
    {
      id: 'bot_commands',
      name: 'Bot Commands',
      description: 'Handle bot commands and responses',
      icon: 'terminal',
      configSchema: {
        botToken: { type: 'string', label: 'Bot Token', required: true, placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11' },
      },
    },
    {
      id: 'channel_posts',
      name: 'Channel Posts',
      description: 'Auto-post to channels',
      icon: 'broadcast',
      configSchema: {
        channelId: { type: 'string', label: 'Channel ID', required: true },
      },
    },
    {
      id: 'group_management',
      name: 'Group Management',
      description: 'Manage group members and content',
      icon: 'users',
    },
  ],
  
  kpis: [
    { id: 'members', name: 'Members', description: 'Total group/channel members', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 3600000 },
    { id: 'messages', name: 'Messages', description: 'Messages sent (24h)', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 86400000 },
    { id: 'active_users', name: 'Active Users', description: 'Active users (7 days)', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 86400000 },
  ],
};

export const telegramIO: NodeIOConfig = {
  inputs: [
    { id: 'trigger', name: 'Trigger', type: 'trigger', direction: 'input', dataType: 'any' },
    { id: 'message', name: 'Message', type: 'data', direction: 'input', dataType: 'message' },
  ],
  outputs: [
    { id: 'message_received', name: 'Message Received', type: 'trigger', direction: 'output', dataType: 'message' },
    { id: 'member_joined', name: 'Member Joined', type: 'trigger', direction: 'output', dataType: 'lead' },
    { id: 'command', name: 'Command', type: 'trigger', direction: 'output', dataType: 'event' },
  ],
};

// ═══════════════════════════════════════════════════════════════
// DISCORD
// ═══════════════════════════════════════════════════════════════

export const discordIntegration: PlatformIntegration = {
  platformId: 'discord',
  name: 'Discord',
  icon: 'discord',
  color: '#5865F2',
  description: 'Discord server integration',
  
  methods: ['oauth', 'api_key', 'webhook'],
  preferredMethod: 'api_key',
  
  oauth: {
    authUrl: 'https://discord.com/api/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    scopes: ['identify', 'guilds', 'guilds.members.read'],
    clientIdEnvVar: 'DISCORD_CLIENT_ID',
    clientSecretEnvVar: 'DISCORD_CLIENT_SECRET',
  },
  
  api: {
    baseUrl: 'https://discord.com/api/v10',
    authHeader: 'Authorization',
    authPrefix: 'Bot ',
  },
  
  features: [
    {
      id: 'role_management',
      name: 'Role Management',
      description: 'Auto-assign roles based on actions',
      icon: 'shield',
      configSchema: {
        guildId: { type: 'string', label: 'Server ID', required: true },
        defaultRoleId: { type: 'string', label: 'Default Role ID' },
      },
    },
    {
      id: 'welcome_flow',
      name: 'Welcome Flow',
      description: 'Automated onboarding for new members',
      icon: 'door',
    },
    {
      id: 'ticket_system',
      name: 'Ticket System',
      description: 'Support ticket management',
      icon: 'ticket',
    },
  ],
  
  kpis: [
    { id: 'members', name: 'Members', description: 'Total server members', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 3600000 },
    { id: 'online', name: 'Online', description: 'Currently online members', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 300000 },
    { id: 'messages', name: 'Messages', description: 'Messages (24h)', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 86400000 },
  ],
};

export const discordIO: NodeIOConfig = {
  inputs: [
    { id: 'trigger', name: 'Trigger', type: 'trigger', direction: 'input', dataType: 'any' },
    { id: 'user', name: 'User Data', type: 'data', direction: 'input', dataType: 'lead' },
  ],
  outputs: [
    { id: 'member_joined', name: 'Member Joined', type: 'trigger', direction: 'output', dataType: 'lead' },
    { id: 'message', name: 'Message', type: 'trigger', direction: 'output', dataType: 'message' },
    { id: 'reaction', name: 'Reaction', type: 'trigger', direction: 'output', dataType: 'event' },
    { id: 'role_added', name: 'Role Added', type: 'trigger', direction: 'output', dataType: 'event' },
  ],
};

// ═══════════════════════════════════════════════════════════════
// STRIPE
// ═══════════════════════════════════════════════════════════════

export const stripeIntegration: PlatformIntegration = {
  platformId: 'stripe',
  name: 'Stripe',
  icon: 'stripe',
  color: '#635BFF',
  description: 'Payment processing and subscription management',
  
  methods: ['api_key', 'webhook'],
  preferredMethod: 'api_key',
  
  api: {
    baseUrl: 'https://api.stripe.com/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  },
  
  features: [
    {
      id: 'payment_links',
      name: 'Payment Links',
      description: 'Track payment link conversions',
      icon: 'link',
    },
    {
      id: 'subscriptions',
      name: 'Subscriptions',
      description: 'Manage recurring subscriptions',
      icon: 'refresh',
    },
    {
      id: 'checkout',
      name: 'Checkout Sessions',
      description: 'Track checkout completions',
      icon: 'cart',
    },
  ],
  
  kpis: [
    { id: 'mrr', name: 'MRR', description: 'Monthly Recurring Revenue', unit: '$', format: 'currency', fetchMethod: 'api', refreshIntervalMs: 3600000 },
    { id: 'revenue', name: 'Revenue', description: 'Total revenue (30 days)', unit: '$', format: 'currency', fetchMethod: 'api', refreshIntervalMs: 3600000 },
    { id: 'customers', name: 'Customers', description: 'Total customers', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 3600000 },
    { id: 'churn_rate', name: 'Churn Rate', description: 'Monthly churn rate', unit: '%', format: 'percent', fetchMethod: 'api', refreshIntervalMs: 86400000 },
  ],
};

export const stripeIO: NodeIOConfig = {
  inputs: [
    { id: 'customer', name: 'Customer', type: 'data', direction: 'input', dataType: 'lead' },
  ],
  outputs: [
    { id: 'payment_success', name: 'Payment Success', type: 'trigger', direction: 'output', dataType: 'event' },
    { id: 'payment_failed', name: 'Payment Failed', type: 'trigger', direction: 'output', dataType: 'event' },
    { id: 'subscription_created', name: 'Subscription Created', type: 'trigger', direction: 'output', dataType: 'event' },
    { id: 'subscription_cancelled', name: 'Subscription Cancelled', type: 'trigger', direction: 'output', dataType: 'event' },
  ],
};

// ═══════════════════════════════════════════════════════════════
// WHOP
// ═══════════════════════════════════════════════════════════════

export const whopIntegration: PlatformIntegration = {
  platformId: 'whop',
  name: 'Whop',
  icon: 'whop',
  color: '#FF6B35',
  description: 'Whop membership and product sales',
  
  methods: ['api_key', 'webhook'],
  preferredMethod: 'api_key',
  
  api: {
    baseUrl: 'https://api.whop.com/api/v2',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  },
  
  features: [
    {
      id: 'memberships',
      name: 'Memberships',
      description: 'Track membership sales and access',
      icon: 'users',
    },
    {
      id: 'products',
      name: 'Products',
      description: 'Track product purchases',
      icon: 'package',
    },
  ],
  
  kpis: [
    { id: 'revenue', name: 'Revenue', description: 'Total revenue (30 days)', unit: '$', format: 'currency', fetchMethod: 'api', refreshIntervalMs: 3600000 },
    { id: 'members', name: 'Members', description: 'Active members', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 3600000 },
    { id: 'sales', name: 'Sales', description: 'Total sales (30 days)', unit: '', format: 'number', fetchMethod: 'api', refreshIntervalMs: 86400000 },
  ],
};

export const whopIO: NodeIOConfig = {
  inputs: [
    { id: 'user', name: 'User', type: 'data', direction: 'input', dataType: 'lead' },
  ],
  outputs: [
    { id: 'purchase', name: 'Purchase', type: 'trigger', direction: 'output', dataType: 'event' },
    { id: 'membership_started', name: 'Membership Started', type: 'trigger', direction: 'output', dataType: 'lead' },
    { id: 'membership_cancelled', name: 'Membership Cancelled', type: 'trigger', direction: 'output', dataType: 'event' },
  ],
};

// ═══════════════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════════════

export const platformRegistry: Record<string, PlatformIntegration> = {
  instagram: instagramIntegration,
  tiktok: tiktokIntegration,
  youtube: youtubeIntegration,
  manychat: manychatIntegration,
  telegram: telegramIntegration,
  discord: discordIntegration,
  stripe: stripeIntegration,
  whop: whopIntegration,
};

export const platformIORegistry: Record<string, NodeIOConfig> = {
  instagram: instagramIO,
  tiktok: tiktokIO,
  youtube: youtubeIO,
  manychat: manychatIO,
  telegram: telegramIO,
  discord: discordIO,
  stripe: stripeIO,
  whop: whopIO,
};

export function getPlatformIntegration(platformId: string): PlatformIntegration | undefined {
  return platformRegistry[platformId];
}

export function getPlatformIO(platformId: string): NodeIOConfig | undefined {
  return platformIORegistry[platformId];
}
