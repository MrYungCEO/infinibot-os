import { assignItemProject } from '../lib/project-assign';
import { assignItemClient } from '../lib/client-assign';
import { useState, useCallback } from 'react';

const NOTION_PROJECTS_DS = '202f4bdd-9bcf-81f0-8ce1-000b71f4b395';
const NOTION_PROJECTS_DB = '202f4bdd-9bcf-814d-9255-d9afab315b1e';
const NOTION_TASKS_DS = '202f4bdd-9bcf-8199-adce-000b63f1ac19';
const NOTION_TASKS_DB = '202f4bdd-9bcf-81f3-9709-f99f4802ed97';

const STATUS_MAP = {
  'Not started': 'todo',
  'In progress': 'in_progress',
  'Awaiting Response': 'review',
  'Revisit': 'review',
  'Done': 'done',
};

const KANBAN_TO_NOTION = {
  backlog: 'Not started',
  todo: 'Not started',
  in_progress: 'In progress',
  review: 'Awaiting Response',
  done: 'Done',
};

const PRIORITY_MAP = {
  Immediate: 'critical',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
};

function extractTitle(props) {
  for (const key of ['Project', 'Task Name', 'Name', 'Title']) {
    if (props[key]?.title) {
      return props[key].title.map(t => t.plain_text || '').join('') || 'Untitled';
    }
  }
  for (const key of Object.keys(props)) {
    if (props[key]?.type === 'title' && props[key]?.title) {
      return props[key].title.map(t => t.plain_text || '').join('') || 'Untitled';
    }
  }
  return 'Untitled';
}

function extractRichText(props, key) {
  return (props[key]?.rich_text || []).map(t => t.plain_text || '').join('');
}

function extractStatus(props, key) {
  return props[key]?.status?.name || '';
}

function extractSelect(props, key) {
  return props[key]?.select?.name || '';
}

function extractMultiSelect(props, key) {
  return (props[key]?.multi_select || []).map(s => s.name);
}

function extractDate(props, key) {
  return props[key]?.date?.start || undefined;
}

function extractCheckbox(props, key) {
  return props[key]?.checkbox === true;
}

function extractPeople(props, key) {
  const people = props[key]?.people;
  if (!people?.length) return undefined;
  return people.map(p => p.name || p.person?.email || '').filter(Boolean).join(', ');
}

function extractRelationCount(props, key) {
  return props[key]?.relation?.length || 0;
}

function extractNumber(props, key) {
  const prop = props[key];
  if (prop?.type === 'number') return prop.number ?? undefined;
  if (prop?.type === 'rollup' && prop.rollup?.type === 'number') {
    return prop.rollup.number != null ? Math.round(prop.rollup.number * 100) : undefined;
  }
  return prop?.number ?? undefined;
}

function mapProject(page) {
  const props = page.properties || {};
  return {
    id: page.id,
    name: extractTitle(props),
    description: extractRichText(props, 'Description'),
    notionStatus: extractStatus(props, 'Status') || 'Not started',
    status: extractStatus(props, 'Status') || 'Not started',
    priority: extractSelect(props, 'Priority'),
    type: extractMultiSelect(props, 'Type'),
    notionProgress: extractNumber(props, 'Progress') ?? 0,
    progress: extractNumber(props, 'Progress') ?? 0,
    taskCount: extractRelationCount(props, 'Tasks'),
    dueDate: extractDate(props, 'Due Date') || extractDate(props, 'Due'),
    updatedAt: new Date(page.last_edited_time).getTime(),
    parentProjectId: props["Parent Project"]?.relation?.[0]?.id || null,
  };
}

// Recompute project status & progress from actual task data
function enrichProjectsWithTasks(projects, tasks) {
  return projects.map(project => {
    const projectTasks = tasks.filter(t => t.projectId === project.id);
    if (projectTasks.length === 0) return project;

    const total = projectTasks.length;
    const doneTasks = projectTasks.filter(t => t.done || t.status === 'done').length;
    const inProgress = projectTasks.filter(t => t.status === 'in_progress' || t.status === 'review').length;
    const computedProgress = Math.round((doneTasks / total) * 100);

    // Derive status from task states
    let computedStatus = project.notionStatus;
    if (total > 0 && doneTasks === total) {
      computedStatus = 'Completed';
    } else if (inProgress > 0 || doneTasks > 0) {
      computedStatus = 'In progress';
    } else {
      computedStatus = 'Not started';
    }

    return {
      ...project,
      status: computedStatus,
      progress: computedProgress,
      taskCount: total,
      _doneTasks: doneTasks,
      _totalTasks: total,
    };
  });
}

function mapTask(page) {
  const props = page.properties || {};
  const notionStatus = extractStatus(props, 'Status Update') || extractStatus(props, 'Status') || 'Not started';
  const kanbanStatus = STATUS_MAP[notionStatus] || 'todo';
  const priorityLevel = extractSelect(props, 'Priority Level');
  const priority = PRIORITY_MAP[priorityLevel] || 'medium';

  return {
    id: page.id,
    projectId: props.Project?.relation?.[0]?.id || '',
    title: extractTitle(props),
    description: extractRichText(props, 'Description') || extractRichText(props, 'Notes'),
    status: kanbanStatus,
    notionStatus,
    assignee: extractPeople(props, 'Assignee') || extractPeople(props, 'Assign'),
    priority,
    priorityLevel,
    dueDate: extractDate(props, 'Due Date') || extractDate(props, 'Due'),
    // Notion CRM page ids of the task's "Customer" relation (the client picker resolves them).
    customerNotionIds: (props.Customer?.relation || []).map((r) => r.id),
    done: extractCheckbox(props, 'Done'),
    department: extractMultiSelect(props, 'Department'),
    updatedAt: new Date(page.last_edited_time).getTime(),
  };
}

export function useKanban(sendReq) {
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadProjects = useCallback(async () => {
    if (!sendReq) return;
    setLoading(true);
    setError(null);
    try {
      // Paginate to fetch ALL projects (Notion API max 100 per request)
      let allResults = [];
      let startCursor = undefined;
      let hasMore = true;
      
      while (hasMore) {
        let res;
        try {
          // Use notion.databases.query first (more reliable, same as web UI)
          const params = {
            databaseId: NOTION_PROJECTS_DB,
            sorts: [{ property: 'Status', direction: 'ascending' }],
            pageSize: 100,
          };
          if (startCursor) params.startCursor = startCursor;
          res = await sendReq('notion.databases.query', params);
        } catch {
          // Fallback to data sources API
          const params = {
            dataSourceId: NOTION_PROJECTS_DS,
            sorts: [{ property: 'Status', direction: 'ascending' }],
            pageSize: 100,
          };
          if (startCursor) params.startCursor = startCursor;
          res = await sendReq('notion.query', params);
        }
        
        allResults = allResults.concat(res?.results || []);
        hasMore = res?.has_more === true;
        startCursor = res?.next_cursor || undefined;
        
        // Safety limit
        if (allResults.length > 500) break;
      }
      
      const mapped = allResults.map(mapProject);
      setProjects(mapped);
      return mapped;
    } catch (err) {
      // Fallback to kanban RPC
      try {
        const res = await sendReq('kanban.projects.list', {});
        setProjects(res || []);
        return res || [];
      } catch (e2) {
        setError(err.message);
        return [];
      }
    } finally {
      setLoading(false);
    }
  }, [sendReq]);

  const loadTasks = useCallback(async (projectId) => {
    if (!sendReq) return;
    setLoading(true);
    setError(null);
    try {
      const filter = projectId ? {
        property: 'Project',
        relation: { contains: projectId },
      } : undefined;
      
      // Paginate to fetch ALL tasks (Notion API max 100 per request)
      let allResults = [];
      let startCursor = undefined;
      let hasMore = true;
      
      while (hasMore) {
        let res;
        try {
          // Use notion.databases.query first (more reliable, same as web UI)
          const params = { databaseId: NOTION_TASKS_DB, pageSize: 100 };
          if (filter) params.filter = filter;
          if (startCursor) params.startCursor = startCursor;
          res = await sendReq('notion.databases.query', params);
        } catch {
          // Fallback to data sources API
          const params = { dataSourceId: NOTION_TASKS_DS, pageSize: 100 };
          if (filter) params.filter = filter;
          if (startCursor) params.startCursor = startCursor;
          res = await sendReq('notion.query', params);
        }
        
        allResults = allResults.concat(res?.results || []);
        hasMore = res?.has_more === true;
        startCursor = res?.next_cursor || undefined;
        
        // Safety limit to prevent infinite loops
        if (allResults.length > 2000) {
          console.warn('Task limit reached (2000), stopping pagination');
          break;
        }
      }
      
      const mapped = allResults.map(mapTask);
      setTasks(mapped);
      return mapped;
    } catch (err) {
      try {
        const res = await sendReq('kanban.tasks.list', {});
        setTasks(res || []);
        return res || [];
      } catch {
        setError(err.message);
        return [];
      }
    } finally {
      setLoading(false);
    }
  }, [sendReq]);

  const loadAll = useCallback(async () => {
    const projs = await loadProjects();
    const allTasks = await loadTasks(null);
    // Enrich projects with computed status/progress from tasks
    if (projs?.length && allTasks?.length) {
      const enriched = enrichProjectsWithTasks(projs, allTasks);
      setProjects(enriched);
      return enriched;
    }
    return projs;
  }, [loadProjects, loadTasks]);

  const updateTaskStatus = useCallback(async (taskId, newStatus) => {
    if (!sendReq) return;
    const notionStatus = KANBAN_TO_NOTION[newStatus];
    
    // Get the task's projectId and sync done with status
    const task = tasks.find(t => t.id === taskId);
    const projectId = task?.projectId;
    const newDone = newStatus === 'done';
    
    // Optimistic update - sync done with status
    setTasks(prev => {
      const updatedTasks = prev.map(t =>
        t.id === taskId ? { ...t, status: newStatus, notionStatus, done: newDone } : t
      );
      
      // Recalculate project progress
      if (projectId) {
        setProjects(prevProjects => enrichProjectsWithTasks(prevProjects, updatedTasks));
      }
      
      return updatedTasks;
    });
    
    try {
      // ── BACKLOG FIX: Use gateway endpoint instead of direct Notion update ──
      // Gateway stores the exact status locally (including "backlog") and syncs to Notion
      await sendReq('kanban.tasks.update', {
        id: taskId,
        patch: { status: newStatus, done: newDone },
      });
      
      // Also sync to Notion directly for Done checkbox + Status consistency
      try {
        await sendReq('notion.update', {
          pageId: taskId,
          properties: {
            'Done': { checkbox: newDone },
            'Status Update': { status: { name: notionStatus } },
          },
        });
      } catch {
        // Non-critical if this fails
      }
    } catch (err) {
      setError(err.message);
      // Reload on error
      if (selectedProjectId) loadTasks(selectedProjectId);
      else loadTasks(null);
    }
  }, [sendReq, selectedProjectId, loadTasks, tasks]);

  const updateTaskDone = useCallback(async (taskId, done) => {
    if (!sendReq) return;
    
    // When checking done, also move to "done" status
    // When unchecking, move back to "todo" status
    const newStatus = done ? 'done' : 'todo';
    const notionStatus = KANBAN_TO_NOTION[newStatus];
    
    // Get the task's projectId before update
    const task = tasks.find(t => t.id === taskId);
    const projectId = task?.projectId;
    
    // Optimistic update - update both done AND status
    setTasks(prev => {
      const updatedTasks = prev.map(t =>
        t.id === taskId ? { ...t, done, status: newStatus, notionStatus } : t
      );
      
      // Recalculate project progress
      if (projectId) {
        setProjects(prevProjects => enrichProjectsWithTasks(prevProjects, updatedTasks));
      }
      
      return updatedTasks;
    });
    
    try {
      // Update both Done checkbox AND Status in a single Notion API call
      await sendReq('notion.update', {
        pageId: taskId,
        properties: {
          'Done': { checkbox: done },
          'Status Update': { status: { name: notionStatus } },
        },
      });
      
      // Also update local kanban store for consistency
      try {
        await sendReq('kanban.tasks.update', {
          id: taskId,
          patch: { status: newStatus, done },
        });
      } catch {
        // Ignore if kanban.tasks.update isn't available
      }
    } catch (err) {
      setError(err.message);
      // Reload on error to get correct state
      if (selectedProjectId) loadTasks(selectedProjectId);
      else loadTasks(null);
    }
  }, [sendReq, selectedProjectId, loadTasks, tasks]);

  const updateTaskPriority = useCallback(async (taskId, priority) => {
    if (!sendReq) return;
    const pMap = { critical: 'Immediate', high: 'High', medium: 'Medium', low: 'Low' };
    // Optimistic update
    setTasks(prev => prev.map(t =>
      t.id === taskId ? { ...t, priority, priorityLevel: pMap[priority] } : t
    ));
    try {
      await sendReq('notion.update', {
        pageId: taskId,
        properties: {
          'Priority Level': { select: { name: pMap[priority] || 'Medium' } },
        },
      });
    } catch (err) {
      setError(err.message);
    }
  }, [sendReq]);

  const updateTask = useCallback(async (taskId, updates) => {
    if (!sendReq) return;
    
    // Get the task's projectId
    const task = tasks.find(t => t.id === taskId);
    const projectId = task?.projectId;

    // ── Project move: through capture.assignProject (keeps project page + graph links) ──
    if (updates.projectId !== undefined) {
      const { projectId: nextProjectId, ...rest } = updates;
      setTasks(prev => prev.map(t => (t.id === taskId ? { ...t, projectId: nextProjectId || undefined } : t)));
      try {
        await assignItemProject(sendReq, { kind: 'task', id: taskId, projectId: nextProjectId || null, previousProjectId: projectId });
      } catch (err) {
        setError(err.message);
      }
      if (!Object.keys(rest).length) return;
      updates = rest;
    }

    // ── CRM client: through capture.assignClient (client page, graph, Notion "Customer") ──
    if (updates.clientId !== undefined) {
      const { clientId: nextClientId, previousClientId, ...rest } = updates;
      setTasks(prev => prev.map(t => (t.id === taskId ? { ...t, clientId: nextClientId || undefined } : t)));
      try {
        await assignItemClient(sendReq, { kind: 'task', id: taskId, clientId: nextClientId || null, previousClientId });
      } catch (err) {
        setError(err.message);
      }
      if (!Object.keys(rest).length) return;
      updates = rest;
    }
    
    // ── Bidirectional sync: done ↔ status ──
    if (updates.done === true && updates.status === undefined) {
      updates.status = 'done';
    }
    if (updates.done === false && task?.status === 'done' && updates.status === undefined) {
      updates.status = 'todo';
    }
    if (updates.status === 'done' && updates.done === undefined) {
      updates.done = true;
    }
    if (updates.status && updates.status !== 'done' && task?.status === 'done' && updates.done === undefined) {
      updates.done = false;
    }
    
    const properties = {};
    
    if (updates.title !== undefined) {
      properties['Task Name'] = { title: [{ text: { content: updates.title } }] };
    }
    if (updates.done !== undefined) {
      properties['Done'] = { checkbox: updates.done };
    }
    if (updates.status !== undefined) {
      properties['Status Update'] = { status: { name: KANBAN_TO_NOTION[updates.status] || 'Not started' } };
    }
    if (updates.priority !== undefined) {
      const pMap = { critical: 'Immediate', high: 'High', medium: 'Medium', low: 'Low' };
      properties['Priority Level'] = { select: { name: pMap[updates.priority] || 'Medium' } };
    }
    if (updates.dueDate !== undefined) {
      // Date only: the board shows the Due Date as written.
      properties['Due Date'] = { date: updates.dueDate ? { start: String(updates.dueDate).slice(0, 10) } : null };
    }

    // Optimistic update with done↔status sync
    setTasks(prev => {
      const updatedTasks = prev.map(t => {
        if (t.id !== taskId) return t;
        const updated = { ...t };
        if (updates.title !== undefined) updated.title = updates.title;
        if (updates.done !== undefined) updated.done = updates.done;
        if (updates.status !== undefined) {
          updated.status = updates.status;
          updated.notionStatus = KANBAN_TO_NOTION[updates.status];
        }
        if (updates.priority !== undefined) {
          updated.priority = updates.priority;
        }
        if (updates.dueDate !== undefined) updated.dueDate = updates.dueDate || undefined;
        return updated;
      });
      
      // Recalculate project progress if done/status changed
      if (projectId && (updates.done !== undefined || updates.status !== undefined)) {
        setProjects(prevProjects => enrichProjectsWithTasks(prevProjects, updatedTasks));
      }
      
      return updatedTasks;
    });

    try {
      await sendReq('notion.update', { pageId: taskId, properties });
      
      // Also update kanban store for consistency
      if (updates.done !== undefined || updates.status !== undefined) {
        try {
          await sendReq('kanban.tasks.update', {
            id: taskId,
            patch: { status: updates.status, done: updates.done },
          });
        } catch {
          // Non-critical
        }
      }
    } catch (err) {
      setError(err.message);
      // Reload on error
      if (selectedProjectId) loadTasks(selectedProjectId);
      else loadTasks(null);
    }
  }, [sendReq, selectedProjectId, loadTasks, tasks]);

  const createTask = useCallback(async (projectId, title, opts = {}) => {
    if (!sendReq) return;
    try {
      const properties = {
        Name: { title: [{ text: { content: title } }] },
        Project: { relation: [{ id: projectId }] },
      };
      if (opts.status) {
        properties['Status Update'] = { status: { name: KANBAN_TO_NOTION[opts.status] || 'Not started' } };
      }
      if (opts.priority) {
        const pMap = { critical: 'Immediate', high: 'High', medium: 'Medium', low: 'Low' };
        properties['Priority Level'] = { select: { name: pMap[opts.priority] || 'Medium' } };
      }
      const res = await sendReq('notion.create', {
        parent: { database_id: NOTION_TASKS_DB },
        properties,
      });
      const mapped = mapTask(res);
      setTasks(prev => [...prev, mapped]);
      return mapped;
    } catch (err) {
      setError(err.message);
    }
  }, [sendReq]);

  const createProject = useCallback(async (name, opts = {}) => {
    if (!sendReq) return;
    try {
      const properties = {
        Project: { title: [{ text: { content: name } }] },
        Status: { status: { name: opts.status || 'Not started' } },
      };
      if (opts.priority) {
        const pMap = { critical: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
        properties['Priority'] = { select: { name: pMap[opts.priority] || 'Medium' } };
      }
      if (opts.description) {
        properties['Description'] = { rich_text: [{ text: { content: opts.description } }] };
      }
      if (opts.type) {
        properties['Type'] = { multi_select: opts.type.map(t => ({ name: t })) };
      }
      if (opts.active) {
        properties['Active Client Project'] = { checkbox: true };
      }
      const res = await sendReq('notion.create', {
        parent: { database_id: NOTION_PROJECTS_DB },
        properties,
      });
      const mapped = mapProject(res);
      setProjects(prev => [...prev, mapped]);
      return mapped;
    } catch (err) {
      setError(err.message);
    }
  }, [sendReq]);

  const updateProjectStatus = useCallback(async (projectId, newStatus) => {
    if (!sendReq) return;
    // Optimistic update
    setProjects(prev => prev.map(p =>
      p.id === projectId ? { ...p, status: newStatus, notionStatus: newStatus } : p
    ));
    try {
      await sendReq('notion.update', {
        pageId: projectId,
        properties: {
          'Status': { status: { name: newStatus } },
        },
      });
    } catch (err) {
      setError(err.message);
      // Reload on error
      loadProjects();
    }
  }, [sendReq, loadProjects]);

  return {
    projects, tasks, selectedProjectId, loading, error,
    setSelectedProjectId, loadProjects, loadTasks, loadAll,
    updateTaskStatus, updateTaskDone, updateTaskPriority, updateTask, createTask,
    createProject, updateProjectStatus,
  };
}
