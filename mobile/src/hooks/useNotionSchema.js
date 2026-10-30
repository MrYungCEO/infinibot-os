import { useState, useCallback, useMemo, useEffect } from 'react';

/**
 * Notion Property Types Reference:
 * - title: Main title property
 * - rich_text: Multi-line text
 * - number: Numeric value
 * - select: Single choice from options
 * - multi_select: Multiple choices
 * - status: Kanban-style status with groups
 * - date: Date with optional end date and time
 * - people: User references
 * - files: File attachments
 * - checkbox: Boolean
 * - url: URL string
 * - email: Email string
 * - phone_number: Phone string
 * - formula: Computed value (read-only)
 * - relation: Links to other database pages
 * - rollup: Aggregation from relations (read-only)
 * - created_time: Auto timestamp (read-only)
 * - created_by: Auto user (read-only)
 * - last_edited_time: Auto timestamp (read-only)
 * - last_edited_by: Auto user (read-only)
 * - unique_id: Auto-generated ID (read-only)
 */

const NOTION_PROJECTS_DB = '202f4bdd-9bcf-814d-9255-d9afab315b1e';
const NOTION_TASKS_DB = '202f4bdd-9bcf-81f3-9709-f99f4802ed97';
const NOTION_STAFF_DB = '202f4bdd-9bcf-8109-bafe-f75979aa05c1';
const NOTION_CLIENTS_DB = '202f4bdd-9bcf-81c1-9a6c-ff54e52cae78';

// Editable property types
const EDITABLE_TYPES = new Set([
  'title', 'rich_text', 'number', 'select', 'multi_select', 'status',
  'date', 'people', 'checkbox', 'url', 'email', 'phone_number', 'relation', 'files'
]);

// Read-only property types
const READONLY_TYPES = new Set([
  'formula', 'rollup', 'created_time', 'created_by', 'last_edited_time', 
  'last_edited_by', 'unique_id', 'verification'
]);

// Map of known database IDs to friendly names
const DB_NAMES = {
  [NOTION_PROJECTS_DB]: 'Projects',
  [NOTION_TASKS_DB]: 'Tasks',
  [NOTION_STAFF_DB]: 'Staff',
  [NOTION_CLIENTS_DB]: 'Clients',
};

/**
 * Parse a Notion property schema into a normalized format
 */
function parsePropertySchema(name, config) {
  const { type, id } = config;
  
  const base = {
    name,
    id,
    type,
    editable: EDITABLE_TYPES.has(type),
    readonly: READONLY_TYPES.has(type),
  };

  switch (type) {
    case 'title':
    case 'rich_text':
      return { ...base, inputType: 'text' };
    
    case 'number':
      return {
        ...base,
        inputType: 'number',
        format: config.number?.format || 'number',
      };
    
    case 'select':
      return {
        ...base,
        inputType: 'select',
        options: config.select?.options || [],
      };
    
    case 'multi_select':
      return {
        ...base,
        inputType: 'multiSelect',
        options: config.multi_select?.options || [],
      };
    
    case 'status':
      return {
        ...base,
        inputType: 'status',
        options: config.status?.options || [],
        groups: config.status?.groups || [],
      };
    
    case 'date':
      return { ...base, inputType: 'date' };
    
    case 'people':
      return { ...base, inputType: 'people' };
    
    case 'checkbox':
      return { ...base, inputType: 'checkbox' };
    
    case 'url':
      return { ...base, inputType: 'url' };
    
    case 'email':
      return { ...base, inputType: 'email' };
    
    case 'phone_number':
      return { ...base, inputType: 'phone' };
    
    case 'relation':
      return {
        ...base,
        inputType: 'relation',
        relatedDatabaseId: config.relation?.database_id,
        relatedDatabaseName: DB_NAMES[config.relation?.database_id] || 'Related Items',
        syncedPropertyName: config.relation?.synced_property_name,
        syncedPropertyId: config.relation?.synced_property_id,
        isTwoWay: config.relation?.type === 'dual_property',
      };
    
    case 'rollup':
      return {
        ...base,
        inputType: 'rollup',
        rollupFunction: config.rollup?.function,
        relationProperty: config.rollup?.relation_property_name,
        rollupProperty: config.rollup?.rollup_property_name,
      };
    
    case 'formula':
      return {
        ...base,
        inputType: 'formula',
        expression: config.formula?.expression,
      };
    
    case 'files':
      return { ...base, inputType: 'files' };
    
    case 'created_time':
    case 'last_edited_time':
      return { ...base, inputType: 'timestamp' };
    
    case 'created_by':
    case 'last_edited_by':
      return { ...base, inputType: 'user' };
    
    case 'unique_id':
      return {
        ...base,
        inputType: 'uniqueId',
        prefix: config.unique_id?.prefix,
      };
    
    default:
      return { ...base, inputType: 'unknown' };
  }
}

/**
 * Parse full database schema
 */
function parseDatabaseSchema(response) {
  const { id, title, description, properties, icon, cover, is_inline, url } = response;
  
  const titleText = title?.map(t => t.plain_text || '').join('') || 'Untitled';
  const descText = description?.map(t => t.plain_text || '').join('') || '';
  
  // Parse all properties
  const parsedProperties = {};
  const propertyList = [];
  
  for (const [name, config] of Object.entries(properties || {})) {
    const parsed = parsePropertySchema(name, config);
    parsedProperties[name] = parsed;
    propertyList.push(parsed);
  }
  
  // Sort: editable first, then readonly, alphabetically within groups
  propertyList.sort((a, b) => {
    if (a.readonly !== b.readonly) return a.readonly ? 1 : -1;
    if (a.type === 'title') return -1;
    if (b.type === 'title') return 1;
    return a.name.localeCompare(b.name);
  });
  
  return {
    id,
    title: titleText,
    description: descText,
    url,
    isInline: is_inline,
    icon: icon?.emoji || icon?.external?.url || null,
    cover: cover?.external?.url || cover?.file?.url || null,
    properties: parsedProperties,
    propertyList,
    editableProperties: propertyList.filter(p => p.editable),
    readonlyProperties: propertyList.filter(p => p.readonly),
  };
}

/**
 * Cache for database schemas
 */
const schemaCache = new Map();

const SCHEMA_TIMEOUT_MS = 12000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const normalizeId = (id) => String(id || '').replace(/-/g, '').toLowerCase();

/**
 * The gateway has no raw "retrieve database" RPC. The schema of a database
 * connected in the Notion Database Manager comes back on `notion.db.list` as
 *   { databaseId, databaseName, properties: { [name]: { id, name, type, options?, groups?, relationDbId? } } }
 * Re-shape it into the Notion REST database object `parseDatabaseSchema` reads.
 */
function managerEntryToDatabase(entry) {
  const properties = {};
  for (const [name, prop] of Object.entries(entry?.schema?.properties || {})) {
    const config = { id: prop.id, name, type: prop.type };
    if (prop.type === 'select' || prop.type === 'multi_select') {
      config[prop.type] = { options: prop.options || [] };
    } else if (prop.type === 'status') {
      config.status = { options: prop.options || [], groups: prop.groups || [] };
    } else if (prop.type === 'relation') {
      config.relation = { database_id: prop.relationDbId };
    }
    properties[name] = config;
  }
  return {
    id: entry.databaseId,
    title: [{ plain_text: entry.name || entry.schema?.databaseName || 'Untitled' }],
    icon: entry.icon ? { emoji: entry.icon } : null,
    properties,
  };
}

/**
 * Fallback for a database that is not connected in the manager: read one row
 * through `notion.databases.query` and take property names/types from it.
 * Select/status option lists are not available this way.
 */
function pageToDatabase(databaseId, page) {
  const properties = {};
  for (const [name, value] of Object.entries(page?.properties || {})) {
    properties[name] = { id: value?.id, name, type: value?.type };
  }
  return { id: databaseId, title: [], properties };
}

/**
 * Hook to fetch and cache Notion database schemas
 */
export function useNotionSchema(sendReq) {
  const [schemas, setSchemas] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Fetch schema for a specific database
   */
  const fetchSchema = useCallback(async (databaseId) => {
    if (!sendReq || !databaseId) return null;
    
    // Check cache
    if (schemaCache.has(databaseId)) {
      return schemaCache.get(databaseId);
    }
    
    setLoading(true);
    setError(null);
    
    try {
      let res = null;
      let partial = false;
      try {
        const list = await withTimeout(sendReq('notion.db.list', {}), SCHEMA_TIMEOUT_MS, 'notion.db.list');
        const wanted = normalizeId(databaseId);
        const entry = (list?.databases || []).find((d) => normalizeId(d.databaseId) === wanted);
        if (entry) res = managerEntryToDatabase(entry);
      } catch {
        // fall through to the query-based fallback
      }

      if (!res) {
        const page = await withTimeout(
          sendReq('notion.databases.query', { databaseId, pageSize: 1 }),
          SCHEMA_TIMEOUT_MS,
          'notion.databases.query',
        );
        const first = page?.results?.[0];
        if (!first) throw new Error('Database schema unavailable (not connected and no rows to infer it from)');
        res = pageToDatabase(databaseId, first);
        partial = true;
      }

      const parsed = { ...parseDatabaseSchema(res), partial };
      schemaCache.set(databaseId, parsed);
      setSchemas(prev => ({ ...prev, [databaseId]: parsed }));
      return parsed;
    } catch (err) {
      console.error('Failed to fetch schema:', err);
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [sendReq]);

  /**
   * Preload schemas for common databases
   */
  const preloadSchemas = useCallback(async () => {
    const dbIds = [NOTION_PROJECTS_DB, NOTION_TASKS_DB];
    await Promise.all(dbIds.map(id => fetchSchema(id)));
  }, [fetchSchema]);

  /**
   * Get cached schema or fetch it
   */
  const getSchema = useCallback(async (databaseId) => {
    if (schemas[databaseId]) return schemas[databaseId];
    return fetchSchema(databaseId);
  }, [schemas, fetchSchema]);

  /**
   * Clear cache and refetch
   */
  const refreshSchema = useCallback(async (databaseId) => {
    schemaCache.delete(databaseId);
    setSchemas(prev => {
      const next = { ...prev };
      delete next[databaseId];
      return next;
    });
    return fetchSchema(databaseId);
  }, [fetchSchema]);

  /**
   * Get select/multi-select options for a property
   */
  const getPropertyOptions = useCallback((databaseId, propertyName) => {
    const schema = schemas[databaseId];
    if (!schema) return [];
    const prop = schema.properties[propertyName];
    return prop?.options || [];
  }, [schemas]);

  /**
   * Get status options with groups
   */
  const getStatusOptions = useCallback((databaseId, propertyName) => {
    const schema = schemas[databaseId];
    if (!schema) return { options: [], groups: [] };
    const prop = schema.properties[propertyName];
    return {
      options: prop?.options || [],
      groups: prop?.groups || [],
    };
  }, [schemas]);

  /**
   * Get relation info
   */
  const getRelationInfo = useCallback((databaseId, propertyName) => {
    const schema = schemas[databaseId];
    if (!schema) return null;
    const prop = schema.properties[propertyName];
    if (prop?.type !== 'relation') return null;
    return {
      relatedDatabaseId: prop.relatedDatabaseId,
      relatedDatabaseName: prop.relatedDatabaseName,
      isTwoWay: prop.isTwoWay,
    };
  }, [schemas]);

  // Preload on mount if sendReq is available
  useEffect(() => {
    if (sendReq) preloadSchemas();
  }, [sendReq, preloadSchemas]);

  return {
    schemas,
    loading,
    error,
    fetchSchema,
    getSchema,
    refreshSchema,
    getPropertyOptions,
    getStatusOptions,
    getRelationInfo,
    
    // Convenience getters
    projectsSchema: schemas[NOTION_PROJECTS_DB],
    tasksSchema: schemas[NOTION_TASKS_DB],
    
    // Constants
    NOTION_PROJECTS_DB,
    NOTION_TASKS_DB,
    NOTION_STAFF_DB,
    NOTION_CLIENTS_DB,
  };
}

/**
 * Extract property value from a Notion page in display format
 */
export function extractPropertyValue(property) {
  if (!property) return null;
  
  const { type } = property;
  
  switch (type) {
    case 'title':
      return property.title?.map(t => t.plain_text || '').join('') || '';
    
    case 'rich_text':
      return property.rich_text?.map(t => t.plain_text || '').join('') || '';
    
    case 'number':
      return property.number;
    
    case 'select':
      return property.select ? {
        name: property.select.name,
        color: property.select.color,
        id: property.select.id,
      } : null;
    
    case 'multi_select':
      return property.multi_select?.map(s => ({
        name: s.name,
        color: s.color,
        id: s.id,
      })) || [];
    
    case 'status':
      return property.status ? {
        name: property.status.name,
        color: property.status.color,
        id: property.status.id,
      } : null;
    
    case 'date':
      return property.date ? {
        start: property.date.start,
        end: property.date.end,
        timeZone: property.date.time_zone,
      } : null;
    
    case 'people':
      return property.people?.map(p => ({
        id: p.id,
        name: p.name || p.person?.email,
        email: p.person?.email,
        avatarUrl: p.avatar_url,
      })) || [];
    
    case 'files':
      return property.files?.map(f => ({
        name: f.name,
        url: f.file?.url || f.external?.url,
        type: f.type,
      })) || [];
    
    case 'checkbox':
      return property.checkbox === true;
    
    case 'url':
      return property.url;
    
    case 'email':
      return property.email;
    
    case 'phone_number':
      return property.phone_number;
    
    case 'formula':
      const formula = property.formula;
      if (!formula) return null;
      return formula[formula.type];
    
    case 'relation':
      return property.relation?.map(r => ({ id: r.id })) || [];
    
    case 'rollup':
      const rollup = property.rollup;
      if (!rollup) return null;
      if (rollup.type === 'array') {
        return rollup.array?.map(extractPropertyValue) || [];
      }
      return rollup[rollup.type];
    
    case 'created_time':
      return property.created_time;
    
    case 'created_by':
      return property.created_by ? {
        id: property.created_by.id,
        name: property.created_by.name,
      } : null;
    
    case 'last_edited_time':
      return property.last_edited_time;
    
    case 'last_edited_by':
      return property.last_edited_by ? {
        id: property.last_edited_by.id,
        name: property.last_edited_by.name,
      } : null;
    
    case 'unique_id':
      return property.unique_id ? {
        prefix: property.unique_id.prefix,
        number: property.unique_id.number,
        display: property.unique_id.prefix 
          ? `${property.unique_id.prefix}-${property.unique_id.number}`
          : String(property.unique_id.number),
      } : null;
    
    default:
      return null;
  }
}

/**
 * Convert a display value back to Notion property format for updates
 */
export function buildPropertyUpdate(type, value, options = {}) {
  switch (type) {
    case 'title':
      return { title: [{ text: { content: value || '' } }] };
    
    case 'rich_text':
      return { rich_text: [{ text: { content: value || '' } }] };
    
    case 'number':
      return { number: value === '' || value === null ? null : Number(value) };
    
    case 'select':
      if (!value) return { select: null };
      return { select: { name: typeof value === 'string' ? value : value.name } };
    
    case 'multi_select':
      if (!value || !Array.isArray(value)) return { multi_select: [] };
      return { multi_select: value.map(v => ({ name: typeof v === 'string' ? v : v.name })) };
    
    case 'status':
      if (!value) return { status: null };
      return { status: { name: typeof value === 'string' ? value : value.name } };
    
    case 'date':
      if (!value) return { date: null };
      if (typeof value === 'string') return { date: { start: value } };
      return { date: { start: value.start, end: value.end || undefined } };
    
    case 'people':
      if (!value || !Array.isArray(value)) return { people: [] };
      return { people: value.map(v => ({ object: 'user', id: typeof v === 'string' ? v : v.id })) };
    
    case 'checkbox':
      return { checkbox: Boolean(value) };
    
    case 'url':
      return { url: value || null };
    
    case 'email':
      return { email: value || null };
    
    case 'phone_number':
      return { phone_number: value || null };
    
    case 'relation':
      if (!value || !Array.isArray(value)) return { relation: [] };
      return { relation: value.map(v => ({ id: typeof v === 'string' ? v : v.id })) };
    
    case 'files':
      if (!value || !Array.isArray(value)) return { files: [] };
      return {
        files: value.map(f => ({
          name: f.name || 'File',
          external: { url: f.url },
        }))
      };
    
    default:
      // Read-only types can't be updated
      return null;
  }
}
