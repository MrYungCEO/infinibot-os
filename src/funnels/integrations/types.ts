/**
 * Funnel Integration Types
 * Platform-specific API integrations and KPI connectors
 */

// ═══════════════════════════════════════════════════════════════
// PLATFORM INTEGRATIONS
// ═══════════════════════════════════════════════════════════════

export type PlatformId = 
  | 'instagram' | 'tiktok' | 'youtube' | 'twitter' | 'linkedin'
  | 'telegram' | 'discord' | 'whatsapp' | 'email'
  | 'manychat' | 'gohighlevel' | 'kajabi' | 'stripe' | 'whop'
  | 'website' | 'app' | 'custom';

export type IntegrationMethod = 'oauth' | 'api_key' | 'webhook' | 'scraping' | 'manual';

export interface PlatformIntegration {
  platformId: PlatformId;
  name: string;
  icon: string;
  color: string;
  description: string;
  
  // Available integration methods
  methods: IntegrationMethod[];
  preferredMethod: IntegrationMethod;
  
  // OAuth config (if supported)
  oauth?: {
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
    clientIdEnvVar: string;
    clientSecretEnvVar: string;
  };
  
  // API config
  api?: {
    baseUrl: string;
    authHeader: string; // e.g., "Authorization", "X-API-Key"
    authPrefix?: string; // e.g., "Bearer ", "Basic "
  };
  
  // Available features for this platform
  features: PlatformFeature[];
  
  // KPIs this platform can provide
  kpis: KPIDefinition[];
}

export interface PlatformFeature {
  id: string;
  name: string;
  description: string;
  icon: string;
  
  // Required integration for this feature
  requiredIntegration?: PlatformId; // e.g., Instagram DM needs ManyChat
  
  // API endpoint or method to enable
  enableMethod?: string;
  
  // Config schema
  configSchema?: Record<string, FieldSchema>;
}

export interface FieldSchema {
  type: 'string' | 'number' | 'boolean' | 'select' | 'multiselect' | 'json';
  label: string;
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  default?: any;
}

export interface KPIDefinition {
  id: string;
  name: string;
  description: string;
  unit: string;
  format: 'number' | 'currency' | 'percent' | 'duration';
  
  // How to fetch this KPI
  fetchMethod: 'api' | 'scraping' | 'webhook' | 'manual';
  apiEndpoint?: string;
  responseParser?: string; // JSONPath or function name
  
  // Refresh rate
  refreshIntervalMs?: number;
}

// ═══════════════════════════════════════════════════════════════
// INTEGRATION CREDENTIALS
// ═══════════════════════════════════════════════════════════════

export interface IntegrationCredential {
  id: string;
  platformId: PlatformId;
  method: IntegrationMethod;
  
  // For OAuth
  accessToken?: string;
  refreshToken?: string;
  tokenExpiry?: number;
  
  // For API Key
  apiKey?: string;
  apiSecret?: string;
  
  // For Webhook
  webhookUrl?: string;
  webhookSecret?: string;
  
  // Status
  connected: boolean;
  lastVerified?: number;
  lastError?: string;
  
  // Metadata
  accountId?: string;
  accountName?: string;
  
  createdAt: string;
  updatedAt: string;
}

// ═══════════════════════════════════════════════════════════════
// CONNECTION TYPES (n8n-style)
// ═══════════════════════════════════════════════════════════════

export type ConnectionTrigger = 
  | 'on_new_follower'
  | 'on_dm_received'
  | 'on_comment'
  | 'on_mention'
  | 'on_form_submit'
  | 'on_purchase'
  | 'on_signup'
  | 'on_link_click'
  | 'on_video_view'
  | 'on_email_open'
  | 'on_schedule'
  | 'manual';

export type ConnectionAction =
  | 'send_dm'
  | 'add_to_list'
  | 'add_tag'
  | 'remove_tag'
  | 'send_email'
  | 'create_lead'
  | 'update_lead'
  | 'move_stage'
  | 'notify_webhook'
  | 'delay'
  | 'condition'
  | 'ai_qualify';

export interface FlowConnection {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  fromOutput: string; // Output port name
  toInput: string;    // Input port name
  
  // Trigger/Action config
  trigger?: ConnectionTrigger;
  action?: ConnectionAction;
  
  // Conditions
  conditions?: ConnectionCondition[];
  
  // Transform/map data
  dataMapping?: Record<string, string>;
  
  // Stats
  executionCount?: number;
  lastExecutedAt?: number;
  conversionRate?: number;
}

export interface ConnectionCondition {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'gt' | 'lt' | 'exists' | 'regex';
  value: any;
}

// ═══════════════════════════════════════════════════════════════
// NODE IO PORTS
// ═══════════════════════════════════════════════════════════════

export interface NodePort {
  id: string;
  name: string;
  type: 'trigger' | 'action' | 'data';
  direction: 'input' | 'output';
  dataType?: 'lead' | 'event' | 'message' | 'any';
  required?: boolean;
}

export interface NodeIOConfig {
  inputs: NodePort[];
  outputs: NodePort[];
}
