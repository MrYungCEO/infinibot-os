/**
 * ManyChat API Client
 * Full integration for Instagram DM automation
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("manychat-client");

export interface ManyChatConfig {
  apiKey: string;
  pageId?: string;
  accountName?: string;
  connected: boolean;
  lastVerified?: number;
}

export interface ManyChatSubscriber {
  id: string;
  page_id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  name: string;
  gender: string;
  profile_pic: string;
  locale: string;
  language: string;
  timezone: string;
  live_chat_url: string;
  last_input_text: string;
  subscribed: string;
  last_interaction: string;
  last_seen: string;
  is_followup_enabled: boolean;
  ig_username?: string;
  ig_id?: string;
  phone?: string;
  email?: string;
  custom_fields: Record<string, any>;
  tags: { id: string; name: string }[];
}

export interface ManyChatFlow {
  id: string;
  name: string;
  type: string;
  status: string;
  created_at: string;
  updated_at: string;
  triggers?: ManyChatTrigger[];
}

export interface ManyChatTrigger {
  id: string;
  type: string;
  keyword?: string;
  flow_id: string;
}

export interface ManyChatTag {
  id: string;
  name: string;
  subscribers_count: number;
}

export interface ManyChatCustomField {
  id: number;
  name: string;
  type: string;
  description: string;
}

export interface ManyChatStats {
  total_subscribers: number;
  active_subscribers: number;
  new_subscribers_today: number;
  new_subscribers_week: number;
  messages_sent_today: number;
}

export class ManyChatClient {
  private apiKey: string;
  private baseUrl = 'https://api.manychat.com';
  
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }
  
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers as Record<string, string>,
    };
    
    log.info("[manychat] Request:", { endpoint, method: options.method || 'GET' });
    
    const res = await fetch(url, { ...options, headers });
    const responseText = await res.text();
    
    log.info("[manychat] Response:", { status: res.status, body: responseText.slice(0, 500) });
    
    if (!res.ok) {
      throw new Error(`ManyChat API error: ${res.status} - ${responseText}`);
    }
    
    try {
      const data = JSON.parse(responseText);
      return data.data || data;
    } catch {
      throw new Error(`ManyChat API returned invalid JSON: ${responseText.slice(0, 200)}`);
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // ACCOUNT
  // ═══════════════════════════════════════════════════════════════
  
  async verifyConnection(): Promise<{ valid: boolean; pageId?: string; pageName?: string; error?: string }> {
    try {
      const page = await this.request<{ id: string; name: string }>('/fb/page/getInfo');
      return { valid: true, pageId: page.id, pageName: page.name };
    } catch (e: any) {
      const errorMsg = e?.message || String(e);
      log.warn("[manychat] Connection verification failed:", { error: errorMsg });
      
      // Extract ManyChat error message if present
      let friendlyError = 'Connection failed';
      if (errorMsg.includes('Wrong token')) {
        friendlyError = 'Invalid or expired API key. Please refresh your key in ManyChat Settings → API';
      } else if (errorMsg.includes('401')) {
        friendlyError = 'Authentication failed. Check your API key.';
      }
      
      return { valid: false, error: friendlyError };
    }
  }
  
  async getPageInfo(): Promise<{ id: string; name: string; category: string }> {
    return this.request('/fb/page/getInfo');
  }
  
  // ═══════════════════════════════════════════════════════════════
  // SUBSCRIBERS
  // ═══════════════════════════════════════════════════════════════
  
  async getSubscriber(subscriberId: string): Promise<ManyChatSubscriber> {
    return this.request(`/fb/subscriber/getInfo?subscriber_id=${subscriberId}`);
  }
  
  async findSubscriberByEmail(email: string): Promise<ManyChatSubscriber | null> {
    try {
      return await this.request(`/fb/subscriber/findBySystemField?email=${encodeURIComponent(email)}`);
    } catch {
      return null;
    }
  }
  
  async findSubscriberByPhone(phone: string): Promise<ManyChatSubscriber | null> {
    try {
      return await this.request(`/fb/subscriber/findBySystemField?phone=${encodeURIComponent(phone)}`);
    } catch {
      return null;
    }
  }
  
  async findSubscriberByIgUsername(username: string): Promise<ManyChatSubscriber | null> {
    try {
      // Instagram-specific lookup
      return await this.request(`/fb/subscriber/findBySystemField?ig_username=${encodeURIComponent(username)}`);
    } catch {
      return null;
    }
  }
  
  async getSubscribersByTag(tagId: string, limit = 100): Promise<ManyChatSubscriber[]> {
    return this.request(`/fb/subscriber/getSubscribersByTag?tag_id=${tagId}&limit=${limit}`);
  }
  
  async addTag(subscriberId: string, tagId: string): Promise<void> {
    await this.request('/fb/subscriber/addTag', {
      method: 'POST',
      body: JSON.stringify({ subscriber_id: subscriberId, tag_id: tagId }),
    });
  }
  
  async removeTag(subscriberId: string, tagId: string): Promise<void> {
    await this.request('/fb/subscriber/removeTag', {
      method: 'POST',
      body: JSON.stringify({ subscriber_id: subscriberId, tag_id: tagId }),
    });
  }
  
  async setCustomField(subscriberId: string, fieldId: number, value: string | number | boolean): Promise<void> {
    await this.request('/fb/subscriber/setCustomField', {
      method: 'POST',
      body: JSON.stringify({ subscriber_id: subscriberId, field_id: fieldId, field_value: value }),
    });
  }
  
  // ═══════════════════════════════════════════════════════════════
  // FLOWS
  // ═══════════════════════════════════════════════════════════════
  
  async getFlows(): Promise<ManyChatFlow[]> {
    const result = await this.request<{ flows: any[] }>('/fb/page/getFlows');
    // Map API response to our interface (API returns ns/name/folder_id, not id/status/type)
    return (result.flows || []).map((f: any) => ({
      id: f.ns || f.id,
      name: f.name,
      type: f.type || 'content',
      status: f.status || 'active', // API doesn't return status, assume active
      folder_id: f.folder_id,
      created_at: f.created_at,
      updated_at: f.updated_at,
    }));
  }
  
  async sendFlow(subscriberId: string, flowNamespace: string): Promise<void> {
    await this.request('/fb/sending/sendFlow', {
      method: 'POST',
      body: JSON.stringify({ subscriber_id: subscriberId, flow_ns: flowNamespace }),
    });
  }
  
  async sendContent(subscriberId: string, content: ManyChatMessageContent): Promise<void> {
    await this.request('/fb/sending/sendContent', {
      method: 'POST',
      body: JSON.stringify({ subscriber_id: subscriberId, data: content }),
    });
  }
  
  // ═══════════════════════════════════════════════════════════════
  // TAGS
  // ═══════════════════════════════════════════════════════════════
  
  async getTags(): Promise<ManyChatTag[]> {
    try {
      const result = await this.request<{ tags: ManyChatTag[] }>('/fb/page/getTags');
      return (result.tags || []).map((t: any) => ({
        id: t.id || String(t.tag_id),
        name: t.name,
        subscribers_count: t.subscribers_count || t.count || 0,
      }));
    } catch {
      return [];
    }
  }
  
  async getSubscriberCount(): Promise<number> {
    try {
      // Try to get subscriber count from page info or bot fields
      const fields = await this.request<any>('/fb/page/getBotFields');
      return fields?.total_subscribers || fields?.subscribers_count || 0;
    } catch {
      return 0;
    }
  }
  
  async createTag(name: string): Promise<ManyChatTag> {
    return this.request('/fb/page/createTag', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }
  
  async deleteTag(tagId: string): Promise<void> {
    await this.request('/fb/page/removeTag', {
      method: 'POST',
      body: JSON.stringify({ tag_id: tagId }),
    });
  }
  
  // ═══════════════════════════════════════════════════════════════
  // CUSTOM FIELDS
  // ═══════════════════════════════════════════════════════════════
  
  async getCustomFields(): Promise<ManyChatCustomField[]> {
    const result = await this.request<{ fields: ManyChatCustomField[] }>('/fb/page/getCustomFields');
    return result.fields || [];
  }
  
  async createCustomField(name: string, type: 'text' | 'number' | 'date' | 'datetime' | 'boolean'): Promise<ManyChatCustomField> {
    return this.request('/fb/page/createCustomField', {
      method: 'POST',
      body: JSON.stringify({ name, type }),
    });
  }
  
  // ═══════════════════════════════════════════════════════════════
  // GROWTH TOOLS / TRIGGERS
  // ═══════════════════════════════════════════════════════════════
  
  async getGrowthTools(): Promise<any[]> {
    // Growth tools endpoint
    const result = await this.request<{ widgets: any[] }>('/fb/page/getGrowthTools');
    return result.widgets || [];
  }
  
  // ═══════════════════════════════════════════════════════════════
  // AUTOMATIONS
  // ═══════════════════════════════════════════════════════════════
  
  async getAutomations(): Promise<any[]> {
    // Automations endpoint may not be available on all accounts
    try {
      const result = await this.request<{ automations: any[] }>('/fb/page/getBotFields');
      return result.automations || [];
    } catch {
      // Endpoint not available - return empty
      return [];
    }
  }
  
  async enableAutomation(automationId: string): Promise<void> {
    await this.request('/fb/automation/enable', {
      method: 'POST',
      body: JSON.stringify({ automation_id: automationId }),
    });
  }
  
  async disableAutomation(automationId: string): Promise<void> {
    await this.request('/fb/automation/disable', {
      method: 'POST',
      body: JSON.stringify({ automation_id: automationId }),
    });
  }
}

// Message content types
export interface ManyChatMessageContent {
  version: 'v2';
  content: {
    messages: ManyChatMessage[];
    actions?: ManyChatAction[];
    quick_replies?: ManyChatQuickReply[];
  };
}

export interface ManyChatMessage {
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'cards' | 'list';
  text?: string;
  url?: string;
  buttons?: ManyChatButton[];
  elements?: ManyChatCardElement[];
}

export interface ManyChatButton {
  type: 'url' | 'flow' | 'call' | 'buy';
  caption: string;
  url?: string;
  target?: string;
  phone?: string;
  amount?: number;
}

export interface ManyChatCardElement {
  title: string;
  subtitle?: string;
  image_url?: string;
  action?: { type: 'url' | 'flow'; url?: string; target?: string };
  buttons?: ManyChatButton[];
}

export interface ManyChatQuickReply {
  type: 'text' | 'flow' | 'node';
  caption: string;
  target?: string;
}

export interface ManyChatAction {
  action: 'add_tag' | 'remove_tag' | 'set_field_value' | 'unset_field_value' | 'subscribe_bot' | 'unsubscribe_bot';
  tag_name?: string;
  field_name?: string;
  field_value?: any;
}
