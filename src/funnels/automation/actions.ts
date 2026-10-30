/**
 * Funnel Automation Actions
 * Actions that can be executed when rules trigger
 */

import type { 
  Lead, 
  QualificationAction, 
  QualificationActionConfig,
  FunnelTask,
  FunnelTaskType,
  FunnelTaskPriority 
} from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ActionConfig {
  type: QualificationAction;
  label: string;
  description: string;
  icon: string;
  category: 'lead' | 'score' | 'notification' | 'integration' | 'task';
  fields: ActionFieldConfig[];
}

export interface ActionFieldConfig {
  id: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'multiselect' | 'stage' | 'user' | 'template' | 'textarea';
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  hint?: string;
  default?: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const ACTION_CONFIGS: Record<QualificationAction, ActionConfig> = {
  add_score: {
    type: 'add_score',
    label: 'Add Score',
    description: 'Increase lead score by a value',
    icon: 'plus-circle',
    category: 'score',
    fields: [
      { id: 'value', label: 'Points to Add', type: 'number', required: true, placeholder: '10' },
      { id: 'reason', label: 'Reason', type: 'text', placeholder: 'Engaged with email' },
    ],
  },

  subtract_score: {
    type: 'subtract_score',
    label: 'Subtract Score',
    description: 'Decrease lead score by a value',
    icon: 'minus-circle',
    category: 'score',
    fields: [
      { id: 'value', label: 'Points to Subtract', type: 'number', required: true, placeholder: '5' },
      { id: 'reason', label: 'Reason', type: 'text', placeholder: 'No response in 7 days' },
    ],
  },

  set_score: {
    type: 'set_score',
    label: 'Set Score',
    description: 'Set lead score to a specific value',
    icon: 'target',
    category: 'score',
    fields: [
      { id: 'value', label: 'Score Value', type: 'number', required: true, placeholder: '50' },
      { id: 'reason', label: 'Reason', type: 'text', placeholder: 'Initial qualification' },
    ],
  },

  move_stage: {
    type: 'move_stage',
    label: 'Move to Stage',
    description: 'Move lead to a different funnel stage',
    icon: 'arrow-right-circle',
    category: 'lead',
    fields: [
      { id: 'stageId', label: 'Target Stage', type: 'stage', required: true },
      { id: 'reason', label: 'Reason', type: 'text', placeholder: 'Auto-qualified by rule' },
    ],
  },

  add_tag: {
    type: 'add_tag',
    label: 'Add Tag',
    description: 'Add a tag to the lead',
    icon: 'tag',
    category: 'lead',
    fields: [
      { id: 'tag', label: 'Tag Name', type: 'text', required: true, placeholder: 'hot-lead' },
    ],
  },

  remove_tag: {
    type: 'remove_tag',
    label: 'Remove Tag',
    description: 'Remove a tag from the lead',
    icon: 'tag-off',
    category: 'lead',
    fields: [
      { id: 'tag', label: 'Tag Name', type: 'text', required: true, placeholder: 'needs-followup' },
    ],
  },

  assign_to: {
    type: 'assign_to',
    label: 'Assign To',
    description: 'Assign lead to a user or agent',
    icon: 'user-check',
    category: 'lead',
    fields: [
      { id: 'assigneeId', label: 'Assignee', type: 'user', required: true },
      { id: 'notifyAssignee', label: 'Notify Assignee', type: 'select', options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ], default: 'yes' },
    ],
  },

  create_task: {
    type: 'create_task',
    label: 'Create Task',
    description: 'Create a follow-up task for this lead',
    icon: 'clipboard-list',
    category: 'task',
    fields: [
      { id: 'title', label: 'Task Title', type: 'text', required: true, placeholder: 'Follow up with {{lead.name}}' },
      { id: 'description', label: 'Description', type: 'textarea', placeholder: 'Task details...' },
      { id: 'taskType', label: 'Task Type', type: 'select', required: true, options: [
        { value: 'follow_up', label: 'Follow Up' },
        { value: 'call', label: 'Call' },
        { value: 'email', label: 'Email' },
        { value: 'meeting', label: 'Meeting' },
        { value: 'proposal', label: 'Proposal' },
        { value: 'demo', label: 'Demo' },
        { value: 'review', label: 'Review' },
      ]},
      { id: 'priority', label: 'Priority', type: 'select', options: [
        { value: 'low', label: 'Low' },
        { value: 'normal', label: 'Normal' },
        { value: 'high', label: 'High' },
        { value: 'urgent', label: 'Urgent' },
      ], default: 'normal' },
      { id: 'dueDays', label: 'Due In (Days)', type: 'number', placeholder: '3', default: 3 },
      { id: 'assigneeId', label: 'Assign To', type: 'user', hint: 'Leave empty for lead owner' },
    ],
  },

  send_notification: {
    type: 'send_notification',
    label: 'Send Notification',
    description: 'Send a notification to users or channels',
    icon: 'bell',
    category: 'notification',
    fields: [
      { id: 'channel', label: 'Channel', type: 'select', required: true, options: [
        { value: 'in_app', label: 'In-App' },
        { value: 'email', label: 'Email' },
        { value: 'slack', label: 'Slack' },
        { value: 'discord', label: 'Discord' },
        { value: 'telegram', label: 'Telegram' },
      ]},
      { id: 'recipients', label: 'Recipients', type: 'multiselect', hint: 'Users or channels to notify' },
      { id: 'title', label: 'Title', type: 'text', required: true, placeholder: 'New qualified lead!' },
      { id: 'message', label: 'Message', type: 'textarea', required: true, placeholder: '{{lead.name}} from {{lead.company}} just qualified.' },
    ],
  },

  webhook: {
    type: 'webhook',
    label: 'Call Webhook',
    description: 'Send data to an external webhook URL',
    icon: 'globe',
    category: 'integration',
    fields: [
      { id: 'url', label: 'Webhook URL', type: 'text', required: true, placeholder: 'https://...' },
      { id: 'method', label: 'Method', type: 'select', options: [
        { value: 'POST', label: 'POST' },
        { value: 'PUT', label: 'PUT' },
        { value: 'PATCH', label: 'PATCH' },
      ], default: 'POST' },
      { id: 'headers', label: 'Headers (JSON)', type: 'textarea', placeholder: '{"Authorization": "Bearer ..."}' },
      { id: 'includeLeadData', label: 'Include Lead Data', type: 'select', options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ], default: 'yes' },
    ],
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION RESULT
// ═══════════════════════════════════════════════════════════════════════════════

export interface ActionResult {
  success: boolean;
  action: QualificationAction;
  message?: string;
  error?: string;
  data?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION EXECUTORS
// ═══════════════════════════════════════════════════════════════════════════════

export interface ActionContext {
  lead: Lead;
  businessId: string;
  funnelId: string;
  ruleId: string;
  ruleName: string;
  
  // Service callbacks for persistence
  updateLead: (leadId: string, updates: Partial<Lead>) => Promise<void>;
  moveLead: (leadId: string, stageId: string, reason?: string) => Promise<void>;
  createTask: (task: Omit<FunnelTask, 'id' | 'createdAt' | 'updatedAt'>) => Promise<FunnelTask>;
  sendNotification: (opts: { channel: string; recipients: string[]; title: string; message: string }) => Promise<void>;
  callWebhook: (url: string, method: string, headers: Record<string, string>, body: unknown) => Promise<Response>;
  logActivity: (leadId: string, type: string, description: string) => Promise<void>;
}

/**
 * Execute a single action
 */
export async function executeAction(
  actionConfig: QualificationActionConfig,
  context: ActionContext
): Promise<ActionResult> {
  const { type, config } = actionConfig;
  const { lead } = context;

  try {
    switch (type) {
      case 'add_score': {
        const value = Number(config.value) || 0;
        const newScore = Math.min(100, (lead.score || 0) + value);
        await context.updateLead(lead.id, { score: newScore });
        await context.logActivity(lead.id, 'score_change', `Score increased by ${value} to ${newScore} (Rule: ${context.ruleName})`);
        return { success: true, action: type, message: `Added ${value} points`, data: { newScore } };
      }

      case 'subtract_score': {
        const value = Number(config.value) || 0;
        const newScore = Math.max(0, (lead.score || 0) - value);
        await context.updateLead(lead.id, { score: newScore });
        await context.logActivity(lead.id, 'score_change', `Score decreased by ${value} to ${newScore} (Rule: ${context.ruleName})`);
        return { success: true, action: type, message: `Subtracted ${value} points`, data: { newScore } };
      }

      case 'set_score': {
        const newScore = Math.max(0, Math.min(100, Number(config.value) || 0));
        await context.updateLead(lead.id, { score: newScore });
        await context.logActivity(lead.id, 'score_change', `Score set to ${newScore} (Rule: ${context.ruleName})`);
        return { success: true, action: type, message: `Set score to ${newScore}`, data: { newScore } };
      }

      case 'move_stage': {
        const stageId = config.stageId as string;
        const reason = (config.reason as string) || `Moved by rule: ${context.ruleName}`;
        await context.moveLead(lead.id, stageId, reason);
        return { success: true, action: type, message: `Moved to stage ${stageId}` };
      }

      case 'add_tag': {
        const tag = config.tag as string;
        const currentTags = lead.tags || [];
        if (!currentTags.includes(tag)) {
          await context.updateLead(lead.id, { tags: [...currentTags, tag] });
          await context.logActivity(lead.id, 'system', `Tag "${tag}" added (Rule: ${context.ruleName})`);
        }
        return { success: true, action: type, message: `Added tag: ${tag}` };
      }

      case 'remove_tag': {
        const tag = config.tag as string;
        const currentTags = lead.tags || [];
        if (currentTags.includes(tag)) {
          await context.updateLead(lead.id, { tags: currentTags.filter(t => t !== tag) });
          await context.logActivity(lead.id, 'system', `Tag "${tag}" removed (Rule: ${context.ruleName})`);
        }
        return { success: true, action: type, message: `Removed tag: ${tag}` };
      }

      case 'assign_to': {
        const assigneeId = config.assigneeId as string;
        await context.updateLead(lead.id, { assignedTo: assigneeId });
        await context.logActivity(lead.id, 'system', `Assigned to ${assigneeId} (Rule: ${context.ruleName})`);
        
        if (config.notifyAssignee === 'yes') {
          await context.sendNotification({
            channel: 'in_app',
            recipients: [assigneeId],
            title: 'Lead Assigned to You',
            message: `${lead.name} has been assigned to you by automation rule "${context.ruleName}"`,
          });
        }
        return { success: true, action: type, message: `Assigned to ${assigneeId}` };
      }

      case 'create_task': {
        const dueDays = Number(config.dueDays) || 3;
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + dueDays);

        const task = await context.createTask({
          businessId: context.businessId,
          funnelId: context.funnelId,
          leadId: lead.id,
          title: interpolateTemplate(config.title as string, lead),
          description: config.description ? interpolateTemplate(config.description as string, lead) : undefined,
          type: (config.taskType as FunnelTaskType) || 'follow_up',
          status: 'pending',
          priority: (config.priority as FunnelTaskPriority) || 'normal',
          assignedTo: (config.assigneeId as string) || lead.assignedTo,
          dueAt: dueDate.toISOString(),
          autoGenerated: true,
          ruleId: context.ruleId,
        });

        await context.logActivity(lead.id, 'task', `Task created: ${task.title} (Rule: ${context.ruleName})`);
        return { success: true, action: type, message: `Created task: ${task.title}`, data: { taskId: task.id } };
      }

      case 'send_notification': {
        await context.sendNotification({
          channel: config.channel as string,
          recipients: config.recipients as string[],
          title: interpolateTemplate(config.title as string, lead),
          message: interpolateTemplate(config.message as string, lead),
        });
        return { success: true, action: type, message: `Sent notification via ${config.channel}` };
      }

      case 'webhook': {
        const headers = config.headers ? JSON.parse(config.headers as string) : {};
        const body = config.includeLeadData === 'yes' ? {
          lead,
          rule: { id: context.ruleId, name: context.ruleName },
          timestamp: new Date().toISOString(),
        } : {};

        const response = await context.callWebhook(
          config.url as string,
          (config.method as string) || 'POST',
          headers,
          body
        );

        return { 
          success: response.ok, 
          action: type, 
          message: `Webhook ${response.ok ? 'succeeded' : 'failed'}: ${response.status}`,
          data: { status: response.status },
        };
      }

      default:
        return { success: false, action: type, error: `Unknown action type: ${type}` };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, action: type, error: errorMessage };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE INTERPOLATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Replace {{lead.field}} placeholders with actual values
 */
function interpolateTemplate(template: string, lead: Lead): string {
  return template.replace(/\{\{(\w+)\.(\w+)\}\}/g, (match, obj, field) => {
    if (obj === 'lead') {
      const value = (lead as unknown as Record<string, unknown>)[field];
      return value != null ? String(value) : match;
    }
    return match;
  });
}

/**
 * Group actions by category for UI
 */
export function getActionsByCategory(): Record<string, ActionConfig[]> {
  const categories: Record<string, ActionConfig[]> = {
    lead: [],
    score: [],
    task: [],
    notification: [],
    integration: [],
  };

  Object.values(ACTION_CONFIGS).forEach(config => {
    categories[config.category].push(config);
  });

  return categories;
}
