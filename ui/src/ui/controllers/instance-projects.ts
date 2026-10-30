/**
 * Instance-Project Assignment Controller
 * Manages assignments between connected instances and projects
 * Syncs to Notion via "Assigned Instances" multi_select property
 */

import type { GatewayBrowserClient } from "../gateway";
import type { KanbanProject, PresenceEntry } from "../types";
import type { InstanceContextMenu } from "../views/instances";

export interface InstanceProjectsState {
  assignments: Record<string, string[]>; // instanceId -> projectIds
  contextMenu: InstanceContextMenu;
  loading: boolean;
}

const STORAGE_KEY = 'infinibot-instance-projects';

// Get gateway client from window
function getGatewayClient(): GatewayBrowserClient | null {
  return (window as any).__infinibotGatewayClient || null;
}

// Load assignments from localStorage
export function loadInstanceProjectAssignments(): Record<string, string[]> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('[instance-projects] Failed to load assignments:', e);
  }
  return {};
}

// Save assignments to localStorage
export function saveInstanceProjectAssignments(assignments: Record<string, string[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(assignments));
  } catch (e) {
    console.error('[instance-projects] Failed to save assignments:', e);
  }
}

// Sync project's assigned instances to Notion
async function syncProjectInstancesToNotion(projectId: string, projectNotionId: string | undefined, instanceIds: string[]): Promise<void> {
  const client = getGatewayClient();
  if (!client || !projectNotionId) {
    console.warn('[instance-projects] Cannot sync to Notion: no client or notionId');
    return;
  }
  
  try {
    // Update the "Assigned Instances" multi_select property
    await client.request("notion.update", {
      pageId: projectNotionId,
      properties: {
        "Assigned Instances": {
          multi_select: instanceIds.map(id => ({ name: id })),
        },
      },
    });
    console.log('[instance-projects] Synced instances to Notion:', instanceIds);
  } catch (e) {
    console.error('[instance-projects] Failed to sync to Notion:', e);
  }
}

// Assign instance to project
export function assignInstanceToProject(
  assignments: Record<string, string[]>,
  instanceId: string,
  projectId: string,
  projectNotionId?: string
): Record<string, string[]> {
  const current = assignments[instanceId] || [];
  if (current.includes(projectId)) {
    return assignments; // Already assigned
  }
  const updated = {
    ...assignments,
    [instanceId]: [...current, projectId],
  };
  saveInstanceProjectAssignments(updated);
  
  // Sync to Notion (get all instances for this project)
  const projectInstances = getProjectInstances(updated, projectId);
  if (projectNotionId) {
    void syncProjectInstancesToNotion(projectId, projectNotionId, projectInstances);
  }
  
  return updated;
}

// Unassign instance from project
export function unassignInstanceFromProject(
  assignments: Record<string, string[]>,
  instanceId: string,
  projectId: string,
  projectNotionId?: string
): Record<string, string[]> {
  const current = assignments[instanceId] || [];
  if (!current.includes(projectId)) {
    return assignments; // Not assigned
  }
  const updated = {
    ...assignments,
    [instanceId]: current.filter(id => id !== projectId),
  };
  // Clean up empty arrays
  if (updated[instanceId].length === 0) {
    delete updated[instanceId];
  }
  saveInstanceProjectAssignments(updated);
  
  // Sync to Notion (get all instances for this project)
  const projectInstances = getProjectInstances(updated, projectId);
  if (projectNotionId) {
    void syncProjectInstancesToNotion(projectId, projectNotionId, projectInstances);
  }
  
  return updated;
}

// Get projects assigned to an instance
export function getInstanceProjects(
  assignments: Record<string, string[]>,
  instanceId: string
): string[] {
  return assignments[instanceId] || [];
}

// Get instances assigned to a project
export function getProjectInstances(
  assignments: Record<string, string[]>,
  projectId: string
): string[] {
  return Object.entries(assignments)
    .filter(([_, projectIds]) => projectIds.includes(projectId))
    .map(([instanceId]) => instanceId);
}

// Create initial state
export function createInstanceProjectsState(): InstanceProjectsState {
  return {
    assignments: loadInstanceProjectAssignments(),
    contextMenu: null,
    loading: false,
  };
}

// Load assignments from Notion projects (reverse sync)
export async function loadAssignmentsFromNotion(projects: KanbanProject[]): Promise<Record<string, string[]>> {
  const assignments: Record<string, string[]> = {};
  
  for (const project of projects) {
    const instances = (project as any).assignedInstances || [];
    for (const instanceId of instances) {
      if (!assignments[instanceId]) {
        assignments[instanceId] = [];
      }
      if (!assignments[instanceId].includes(project.id)) {
        assignments[instanceId].push(project.id);
      }
    }
  }
  
  return assignments;
}
