/**
 * Funnel Automation Triggers
 * Event types that can trigger automation rules
 */

import type { Lead, LeadActivity, QualificationRule } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TRIGGER TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type TriggerType = 
  | 'lead_created'
  | 'lead_updated'
  | 'stage_changed'
  | 'field_updated'
  | 'score_changed'
  | 'tag_added'
  | 'tag_removed'
  | 'activity_logged'
  | 'time_in_stage'
  | 'scheduled'
  | 'webhook_received'
  | 'manual';

export interface TriggerConfig {
  type: TriggerType;
  label: string;
  description: string;
  icon: string;
  fields: TriggerFieldConfig[];
}

export interface TriggerFieldConfig {
  id: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'multiselect' | 'stage' | 'field';
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  hint?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRIGGER DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const TRIGGER_CONFIGS: Record<TriggerType, TriggerConfig> = {
  lead_created: {
    type: 'lead_created',
    label: 'Lead Created',
    description: 'Triggers when a new lead enters the funnel',
    icon: 'user-plus',
    fields: [
      { id: 'source', label: 'From Source', type: 'multiselect', options: [
        { value: 'website', label: 'Website' },
        { value: 'social', label: 'Social Media' },
        { value: 'referral', label: 'Referral' },
        { value: 'email', label: 'Email' },
        { value: 'import', label: 'Import' },
        { value: 'manual', label: 'Manual' },
      ], hint: 'Leave empty for any source' },
    ],
  },

  lead_updated: {
    type: 'lead_updated',
    label: 'Lead Updated',
    description: 'Triggers when any lead field is modified',
    icon: 'edit',
    fields: [],
  },

  stage_changed: {
    type: 'stage_changed',
    label: 'Stage Changed',
    description: 'Triggers when a lead moves to a different stage',
    icon: 'arrow-right',
    fields: [
      { id: 'fromStage', label: 'From Stage', type: 'stage', hint: 'Leave empty for any stage' },
      { id: 'toStage', label: 'To Stage', type: 'stage', hint: 'Leave empty for any stage' },
    ],
  },

  field_updated: {
    type: 'field_updated',
    label: 'Field Updated',
    description: 'Triggers when a specific field changes',
    icon: 'form-input',
    fields: [
      { id: 'field', label: 'Field Name', type: 'field', required: true },
      { id: 'oldValue', label: 'Previous Value', type: 'text', hint: 'Optional: match specific old value' },
      { id: 'newValue', label: 'New Value', type: 'text', hint: 'Optional: match specific new value' },
    ],
  },

  score_changed: {
    type: 'score_changed',
    label: 'Score Changed',
    description: 'Triggers when lead score crosses a threshold',
    icon: 'trending-up',
    fields: [
      { id: 'direction', label: 'Direction', type: 'select', options: [
        { value: 'increased', label: 'Increased' },
        { value: 'decreased', label: 'Decreased' },
        { value: 'crossed_above', label: 'Crossed Above' },
        { value: 'crossed_below', label: 'Crossed Below' },
      ]},
      { id: 'threshold', label: 'Threshold', type: 'number', placeholder: '50' },
    ],
  },

  tag_added: {
    type: 'tag_added',
    label: 'Tag Added',
    description: 'Triggers when a specific tag is added to lead',
    icon: 'tag',
    fields: [
      { id: 'tag', label: 'Tag Name', type: 'text', required: true },
    ],
  },

  tag_removed: {
    type: 'tag_removed',
    label: 'Tag Removed',
    description: 'Triggers when a specific tag is removed',
    icon: 'tag-off',
    fields: [
      { id: 'tag', label: 'Tag Name', type: 'text', required: true },
    ],
  },

  activity_logged: {
    type: 'activity_logged',
    label: 'Activity Logged',
    description: 'Triggers when an activity is recorded',
    icon: 'activity',
    fields: [
      { id: 'activityType', label: 'Activity Type', type: 'multiselect', options: [
        { value: 'note', label: 'Note' },
        { value: 'email', label: 'Email' },
        { value: 'call', label: 'Call' },
        { value: 'meeting', label: 'Meeting' },
        { value: 'task', label: 'Task' },
      ]},
    ],
  },

  time_in_stage: {
    type: 'time_in_stage',
    label: 'Time in Stage',
    description: 'Triggers after lead stays in stage for X days',
    icon: 'clock',
    fields: [
      { id: 'stageId', label: 'Stage', type: 'stage', required: true },
      { id: 'days', label: 'Days', type: 'number', required: true, placeholder: '7' },
    ],
  },

  scheduled: {
    type: 'scheduled',
    label: 'Scheduled',
    description: 'Triggers at a specific time/interval',
    icon: 'calendar',
    fields: [
      { id: 'schedule', label: 'Schedule (Cron)', type: 'text', placeholder: '0 9 * * 1', hint: 'Cron expression' },
    ],
  },

  webhook_received: {
    type: 'webhook_received',
    label: 'Webhook Received',
    description: 'Triggers when external webhook hits the endpoint',
    icon: 'webhook',
    fields: [
      { id: 'webhookId', label: 'Webhook ID', type: 'text', hint: 'Auto-generated endpoint ID' },
    ],
  },

  manual: {
    type: 'manual',
    label: 'Manual Trigger',
    description: 'Only runs when explicitly triggered',
    icon: 'play',
    fields: [],
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// TRIGGER EVENT
// ═══════════════════════════════════════════════════════════════════════════════

export interface TriggerEvent {
  type: TriggerType;
  timestamp: string;
  businessId: string;
  funnelId?: string;
  leadId?: string;
  lead?: Lead;
  
  // Context data based on trigger type
  data: {
    // stage_changed
    fromStageId?: string;
    toStageId?: string;
    
    // field_updated
    field?: string;
    oldValue?: unknown;
    newValue?: unknown;
    
    // score_changed
    oldScore?: number;
    newScore?: number;
    
    // tag_added/tag_removed
    tag?: string;
    
    // activity_logged
    activity?: LeadActivity;
    
    // webhook_received
    webhookPayload?: Record<string, unknown>;
    
    // Generic
    [key: string]: unknown;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRIGGER MATCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a trigger event matches a rule's trigger configuration
 */
export function matchesTrigger(event: TriggerEvent, rule: QualificationRule): boolean {
  // Type must match
  if (event.type !== rule.triggerOn) {
    return false;
  }

  // Check trigger-specific field matching
  const triggerField = rule.triggerField;
  
  switch (event.type) {
    case 'stage_changed': {
      const { fromStageId, toStageId } = event.data;
      // If rule specifies stages, they must match
      if (rule.stageId && rule.stageId !== toStageId) {
        return false;
      }
      break;
    }

    case 'field_updated': {
      if (triggerField && triggerField !== event.data.field) {
        return false;
      }
      break;
    }

    case 'tag_added':
    case 'tag_removed': {
      if (triggerField && triggerField !== event.data.tag) {
        return false;
      }
      break;
    }

    case 'time_in_stage': {
      if (rule.stageId && rule.stageId !== event.data.stageId) {
        return false;
      }
      break;
    }
  }

  return true;
}

/**
 * Create a trigger event from lead data changes
 */
export function createTriggerEvent(
  type: TriggerType,
  businessId: string,
  options: {
    funnelId?: string;
    leadId?: string;
    lead?: Lead;
    data?: TriggerEvent['data'];
  } = {}
): TriggerEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    businessId,
    funnelId: options.funnelId,
    leadId: options.leadId,
    lead: options.lead,
    data: options.data || {},
  };
}
