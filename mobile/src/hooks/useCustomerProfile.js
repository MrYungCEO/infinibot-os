/**
 * useCustomerProfile — Full Notion page data management
 * Handles properties, nested blocks, and real-time editing
 */
import { useState, useCallback, useEffect } from 'react';
import * as NotionApi from '../services/notionApi';

// Notion property types that we support editing
const EDITABLE_PROPERTY_TYPES = [
  'title', 'rich_text', 'number', 'select', 'multi_select', 'status',
  'date', 'checkbox', 'url', 'email', 'phone_number', 'relation', 'people'
];

// Convert Notion property to display value
function extractPropertyValue(prop) {
  if (!prop) return null;
  
  switch (prop.type) {
    case 'title':
      return prop.title?.map(t => t.plain_text).join('') || '';
    case 'rich_text':
      return prop.rich_text?.map(t => t.plain_text).join('') || '';
    case 'number':
      return prop.number;
    case 'select':
      return prop.select?.name || null;
    case 'multi_select':
      return prop.multi_select?.map(s => s.name) || [];
    case 'status':
      return prop.status?.name || null;
    case 'date':
      return prop.date ? {
        start: prop.date.start,
        end: prop.date.end,
        time_zone: prop.date.time_zone
      } : null;
    case 'checkbox':
      return prop.checkbox || false;
    case 'url':
      return prop.url;
    case 'email':
      return prop.email;
    case 'phone_number':
      return prop.phone_number;
    case 'relation':
      return prop.relation?.map(r => ({ id: r.id })) || [];
    case 'people':
      return prop.people?.map(p => ({ id: p.id, name: p.name })) || [];
    case 'files':
      return prop.files?.map(f => ({
        name: f.name,
        url: f.type === 'file' ? f.file?.url : f.external?.url,
        type: f.type
      })) || [];
    case 'created_time':
      return prop.created_time;
    case 'last_edited_time':
      return prop.last_edited_time;
    case 'created_by':
      return prop.created_by?.name || prop.created_by?.id;
    case 'last_edited_by':
      return prop.last_edited_by?.name || prop.last_edited_by?.id;
    case 'rollup':
      return prop.rollup?.number || prop.rollup?.date || extractArrayRollup(prop.rollup);
    case 'formula':
      return prop.formula?.[prop.formula.type];
    default:
      return null;
  }
}

function extractArrayRollup(rollup) {
  if (!rollup || rollup.type !== 'array') return null;
  return rollup.array?.map(item => extractPropertyValue(item));
}

// Extract rich text from block
function extractBlockText(richText) {
  if (!richText || !Array.isArray(richText)) return '';
  return richText.map(t => t.plain_text || '').join('');
}

// Parse Notion block to simpler structure
/**
 * Gateway block ({ id, type, hasChildren, data, children? } from
 * `notion.db.pages.blocks`) -> the same parsed shape parseBlock produces from a
 * raw Notion block, children included.
 */
function parseGatewayBlock(block) {
  const parsed = parseBlock({
    id: block.id,
    type: block.type,
    has_children: !!block.hasChildren,
    [block.type]: block.data || {},
  });
  if (Array.isArray(block.children) && block.children.length > 0) {
    parsed.children = block.children.map(parseGatewayBlock);
  }
  return parsed;
}

/**
 * Notion Database Manager schema ({ properties: { [name]: { type, options?, groups? } } })
 * -> the slice of a raw Notion database object loadDatabaseSchema reads.
 */
function managerSchemaToDatabase(schema) {
  const properties = {};
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    const config = { id: prop.id, type: prop.type };
    if (prop.type === 'select' || prop.type === 'multi_select') {
      config[prop.type] = { options: prop.options || [] };
    } else if (prop.type === 'status') {
      config.status = { options: prop.options || [], groups: prop.groups || [] };
    }
    properties[name] = config;
  }
  return { id: schema.databaseId, properties };
}

function parseBlock(block) {
  const base = {
    id: block.id,
    type: block.type,
    hasChildren: block.has_children,
    children: [],
  };

  switch (block.type) {
    case 'paragraph':
      return { ...base, text: extractBlockText(block.paragraph?.rich_text) };
    case 'heading_1':
      return { ...base, text: extractBlockText(block.heading_1?.rich_text), level: 1 };
    case 'heading_2':
      return { ...base, text: extractBlockText(block.heading_2?.rich_text), level: 2 };
    case 'heading_3':
      return { ...base, text: extractBlockText(block.heading_3?.rich_text), level: 3 };
    case 'bulleted_list_item':
      return { ...base, text: extractBlockText(block.bulleted_list_item?.rich_text), listType: 'bullet' };
    case 'numbered_list_item':
      return { ...base, text: extractBlockText(block.numbered_list_item?.rich_text), listType: 'number' };
    case 'to_do':
      return { 
        ...base, 
        text: extractBlockText(block.to_do?.rich_text),
        checked: block.to_do?.checked || false
      };
    case 'toggle':
      return { ...base, text: extractBlockText(block.toggle?.rich_text) };
    case 'quote':
      return { ...base, text: extractBlockText(block.quote?.rich_text) };
    case 'callout':
      return { 
        ...base, 
        text: extractBlockText(block.callout?.rich_text),
        // Server-supplied Notion emoji is user content; the fallback is a vector glyph.
        icon: block.callout?.icon?.emoji || null,
        iconName: block.callout?.icon?.emoji ? undefined : 'bulb-outline'
      };
    case 'divider':
      return { ...base };
    case 'table':
      return { 
        ...base, 
        tableWidth: block.table?.table_width,
        hasColumnHeader: block.table?.has_column_header,
        hasRowHeader: block.table?.has_row_header
      };
    case 'table_row':
      return {
        ...base,
        cells: block.table_row?.cells?.map(cell => extractBlockText(cell)) || []
      };
    case 'code':
      return {
        ...base,
        text: extractBlockText(block.code?.rich_text),
        language: block.code?.language
      };
    case 'image':
      return {
        ...base,
        url: block.image?.type === 'file' 
          ? block.image.file?.url 
          : block.image?.external?.url,
        caption: extractBlockText(block.image?.caption)
      };
    case 'pdf':
      return {
        ...base,
        url: block.pdf?.type === 'file'
          ? block.pdf.file?.url
          : block.pdf?.external?.url,
        caption: extractBlockText(block.pdf?.caption)
      };
    case 'file':
      return {
        ...base,
        url: block.file?.type === 'file'
          ? block.file.file?.url
          : block.file?.external?.url,
        name: block.file?.name,
        caption: extractBlockText(block.file?.caption)
      };
    case 'bookmark':
      return {
        ...base,
        url: block.bookmark?.url,
        caption: extractBlockText(block.bookmark?.caption)
      };
    case 'embed':
      return {
        ...base,
        url: block.embed?.url,
        caption: extractBlockText(block.embed?.caption)
      };
    case 'video':
      return {
        ...base,
        url: block.video?.type === 'file'
          ? block.video.file?.url
          : block.video?.external?.url,
        caption: extractBlockText(block.video?.caption)
      };
    case 'child_page':
      return { ...base, title: block.child_page?.title };
    case 'child_database':
      return { ...base, title: block.child_database?.title };
    case 'synced_block':
      return { ...base, syncedFrom: block.synced_block?.synced_from?.block_id };
    case 'column_list':
    case 'column':
      return { ...base };
    default:
      return { ...base, raw: block[block.type] };
  }
}

// Build property update payload for Notion API
function buildPropertyPayload(propertyName, propertyType, value) {
  switch (propertyType) {
    case 'title':
      return { [propertyName]: { title: [{ text: { content: value || '' } }] } };
    case 'rich_text':
      return { [propertyName]: { rich_text: [{ text: { content: value || '' } }] } };
    case 'number':
      return { [propertyName]: { number: value === '' || value === null ? null : Number(value) } };
    case 'select':
      return { [propertyName]: { select: value ? { name: value } : null } };
    case 'multi_select':
      return { [propertyName]: { multi_select: (value || []).map(v => ({ name: v })) } };
    case 'status':
      return { [propertyName]: { status: value ? { name: value } : null } };
    case 'date':
      if (!value || (!value.start && !value)) return { [propertyName]: { date: null } };
      const dateVal = typeof value === 'string' ? { start: value } : value;
      return { [propertyName]: { date: dateVal } };
    case 'checkbox':
      return { [propertyName]: { checkbox: Boolean(value) } };
    case 'url':
      return { [propertyName]: { url: value || null } };
    case 'email':
      return { [propertyName]: { email: value || null } };
    case 'phone_number':
      return { [propertyName]: { phone_number: value || null } };
    case 'relation':
      return { [propertyName]: { relation: (value || []).map(v => ({ id: v.id || v })) } };
    case 'people':
      return { [propertyName]: { people: (value || []).map(v => ({ id: v.id || v })) } };
    default:
      return null;
  }
}

export function useCustomerProfile(gateway, pageId) {
  const [loading, setLoading] = useState(false);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  
  // Page data
  const [pageData, setPageData] = useState(null);
  const [properties, setProperties] = useState({});
  const [propertySchema, setPropertySchema] = useState({});
  const [blocks, setBlocks] = useState([]);
  
  // Parent database info
  const [databaseId, setDatabaseId] = useState(null);
  const [databaseSchema, setDatabaseSchema] = useState(null);

  const clearError = useCallback(() => setError(null), []);
  const clearSuccess = useCallback(() => setSuccess(null), []);

  // Load page data
  const loadPage = useCallback(async () => {
    if (!pageId) return;
    
    setLoading(true);
    setError(null);
    
    try {
      // Try gateway first, fallback to direct Notion API
      let result;
      try {
        if (gateway?.sendReq) {
          // `notion.get` proxies GET /pages/{pageId} (raw Notion page).
          result = await gateway.sendReq('notion.get', { pageId });
        }
      } catch {
        // Gateway method may not exist
      }
      
      // Fallback to direct API
      if (!result) {
        result = await NotionApi.getPage(pageId);
      }
      
      if (!result || result.object === 'error') {
        throw new Error(result?.message || 'Failed to load page');
      }
      
      setPageData(result);
      
      // Extract database ID for schema
      const dbId = result.parent?.database_id || result.parent?.data_source_id;
      setDatabaseId(dbId);
      
      // Parse properties
      const parsedProps = {};
      const schema = {};
      
      for (const [name, prop] of Object.entries(result.properties || {})) {
        schema[name] = {
          id: prop.id,
          type: prop.type,
          name: name,
        };
        
        // Extract options for select/multi_select/status
        if (prop.type === 'select' && prop.select) {
          schema[name].options = []; // Will be loaded from database schema
        }
        if (prop.type === 'multi_select' && prop.multi_select) {
          schema[name].options = [];
        }
        if (prop.type === 'status' && prop.status) {
          schema[name].options = [];
          schema[name].groups = [];
        }
        
        parsedProps[name] = {
          type: prop.type,
          value: extractPropertyValue(prop),
          raw: prop,
        };
      }
      
      setProperties(parsedProps);
      setPropertySchema(schema);
      
      // Load database schema for select options
      if (dbId) {
        loadDatabaseSchema(dbId);
      }
      
    } catch (err) {
      console.error('Failed to load page:', err);
      setError(err.message || 'Failed to load customer profile');
    } finally {
      setLoading(false);
    }
  }, [pageId, gateway]);

  // Load database schema for property options
  const loadDatabaseSchema = useCallback(async (dbId) => {
    if (!dbId) return;
    
    try {
      // Try gateway first, fallback to direct Notion API
      let result;
      try {
        if (gateway?.sendReq) {
          // No raw "retrieve database" RPC exists. Databases connected in the
          // Notion Database Manager carry their schema on `notion.db.list`.
          const list = await gateway.sendReq('notion.db.list', {});
          const wanted = String(dbId).replace(/-/g, '').toLowerCase();
          const entry = (list?.databases || []).find(
            (d) => String(d.databaseId || '').replace(/-/g, '').toLowerCase() === wanted,
          );
          if (entry?.schema?.properties) result = managerSchemaToDatabase(entry.schema);
        }
      } catch {
        // Not connected / gateway unavailable — try the direct API below
      }
      
      // Fallback to direct API
      if (!result) {
        result = await NotionApi.getDatabase(dbId);
      }
      
      if (result && result.properties) {
        setDatabaseSchema(result);
        
        // Update property schema with options
        setPropertySchema(prev => {
          const updated = { ...prev };
          
          for (const [name, prop] of Object.entries(result.properties)) {
            if (updated[name]) {
              if (prop.type === 'select' && prop.select?.options) {
                updated[name].options = prop.select.options;
              }
              if (prop.type === 'multi_select' && prop.multi_select?.options) {
                updated[name].options = prop.multi_select.options;
              }
              if (prop.type === 'status' && prop.status) {
                updated[name].options = prop.status.options || [];
                updated[name].groups = prop.status.groups || [];
              }
            }
          }
          
          return updated;
        });
      }
    } catch (err) {
      console.log('Failed to load database schema:', err.message);
    }
  }, [gateway]);

  // Load page blocks (nested content)
  const loadBlocks = useCallback(async (parentId = null, cursor = null) => {
    const blockId = parentId || pageId;
    if (!blockId) return [];
    
    if (!parentId) {
      setBlocksLoading(true);
    }
    
    try {
      // Try gateway first, fallback to direct Notion API
      let result;
      try {
        // `notion.db.pages.blocks` returns the whole (already recursive) block
        // tree for a page in one call, so only the top-level load uses it.
        if (gateway?.sendReq && !parentId && !cursor) {
          const tree = await gateway.sendReq('notion.db.pages.blocks', { pageId: blockId });
          if (Array.isArray(tree?.blocks)) {
            const parsedTree = tree.blocks.map(parseGatewayBlock);
            setBlocks(parsedTree);
            return parsedTree;
          }
        }
      } catch {
        // Gateway unavailable — try the direct API below
      }
      
      // Fallback to direct API
      if (!result) {
        result = await NotionApi.getBlockChildren(blockId, cursor, 100);
      }
      
      if (!result || result.object === 'error') {
        throw new Error(result?.message || 'Failed to load blocks');
      }
      
      const parsedBlocks = [];
      
      for (const block of (result.results || [])) {
        const parsed = parseBlock(block);
        
        // Recursively load children if needed
        if (block.has_children && !['child_page', 'child_database'].includes(block.type)) {
          parsed.children = await loadBlocks(block.id);
        }
        
        parsedBlocks.push(parsed);
      }
      
      // Handle pagination
      if (result.has_more && result.next_cursor) {
        const moreBlocks = await loadBlocks(blockId, result.next_cursor);
        parsedBlocks.push(...moreBlocks);
      }
      
      if (!parentId) {
        setBlocks(parsedBlocks);
      }
      
      return parsedBlocks;
      
    } catch (err) {
      console.error('Failed to load blocks:', err);
      if (!parentId) {
        setError(err.message || 'Failed to load page content');
      }
      return [];
    } finally {
      if (!parentId) {
        setBlocksLoading(false);
      }
    }
  }, [pageId, gateway]);

  // Update a property
  const updateProperty = useCallback(async (propertyName, value) => {
    if (!pageId) return false;
    
    const propSchema = propertySchema[propertyName];
    if (!propSchema) {
      setError(`Unknown property: ${propertyName}`);
      return false;
    }
    
    if (!EDITABLE_PROPERTY_TYPES.includes(propSchema.type)) {
      setError(`Property type ${propSchema.type} is not editable`);
      return false;
    }
    
    setSaving(true);
    setError(null);
    
    try {
      const payload = buildPropertyPayload(propertyName, propSchema.type, value);
      
      if (!payload) {
        throw new Error('Failed to build update payload');
      }
      
      // Try gateway first, fallback to direct Notion API
      let result;
      try {
        if (gateway?.sendReq) {
          // `notion.update` proxies PATCH /pages/{pageId}.
          result = await gateway.sendReq('notion.update', {
            pageId,
            properties: payload,
          });
        }
      } catch {
        // Gateway method may not exist
      }
      
      // Fallback to direct API
      if (!result) {
        result = await NotionApi.updatePage(pageId, payload);
      }
      
      if (result.object === 'error') {
        throw new Error(result.message || 'Update failed');
      }
      
      // Update local state
      setProperties(prev => ({
        ...prev,
        [propertyName]: {
          ...prev[propertyName],
          value,
        },
      }));
      
      setSuccess(`Updated ${propertyName}`);
      setTimeout(() => setSuccess(null), 2000);
      
      return true;
      
    } catch (err) {
      console.error('Failed to update property:', err);
      setError(err.message || 'Failed to update property');
      return false;
    } finally {
      setSaving(false);
    }
  }, [pageId, propertySchema, gateway]);

  // Bulk update multiple properties
  const updateProperties = useCallback(async (updates) => {
    if (!pageId || !updates || Object.keys(updates).length === 0) {
      return false;
    }
    
    setSaving(true);
    setError(null);
    
    try {
      const payload = {};
      
      for (const [name, value] of Object.entries(updates)) {
        const propSchema = propertySchema[name];
        if (propSchema && EDITABLE_PROPERTY_TYPES.includes(propSchema.type)) {
          const propPayload = buildPropertyPayload(name, propSchema.type, value);
          if (propPayload) {
            Object.assign(payload, propPayload);
          }
        }
      }
      
      if (Object.keys(payload).length === 0) {
        throw new Error('No valid properties to update');
      }
      
      // Try gateway first, fallback to direct Notion API
      let result;
      try {
        if (gateway?.sendReq) {
          // `notion.update` proxies PATCH /pages/{pageId}.
          result = await gateway.sendReq('notion.update', {
            pageId,
            properties: payload,
          });
        }
      } catch {
        // Gateway method may not exist
      }
      
      // Fallback to direct API
      if (!result) {
        result = await NotionApi.updatePage(pageId, payload);
      }
      
      if (result.object === 'error') {
        throw new Error(result.message || 'Update failed');
      }
      
      // Update local state
      setProperties(prev => {
        const updated = { ...prev };
        for (const [name, value] of Object.entries(updates)) {
          if (updated[name]) {
            updated[name] = { ...updated[name], value };
          }
        }
        return updated;
      });
      
      setSuccess('Profile updated');
      setTimeout(() => setSuccess(null), 2000);
      
      return true;
      
    } catch (err) {
      console.error('Failed to update properties:', err);
      setError(err.message || 'Failed to update profile');
      return false;
    } finally {
      setSaving(false);
    }
  }, [pageId, propertySchema, gateway]);

  // Refresh everything
  const refresh = useCallback(async () => {
    // Independent: slow page content must not hold up the properties.
    await Promise.all([loadPage(), loadBlocks()]);
  }, [loadPage, loadBlocks]);

  // Initial load
  useEffect(() => {
    if (pageId) {
      loadPage();
      loadBlocks();
    }
  }, [pageId, loadPage, loadBlocks]);

  // Get property display name (title property)
  const displayName = properties.Name?.value || 
    Object.values(properties).find(p => p.type === 'title')?.value || 
    'Unnamed';

  // Get icon
  const icon = pageData?.icon?.emoji || pageData?.icon?.external?.url || null;

  // Check if property is editable
  const isEditable = useCallback((propertyName) => {
    const prop = propertySchema[propertyName];
    return prop && EDITABLE_PROPERTY_TYPES.includes(prop.type);
  }, [propertySchema]);

  // Group properties by category
  const groupedProperties = useCallback(() => {
    const groups = {
      identity: [],      // title, name fields
      contact: [],       // email, phone, url
      status: [],        // status, select fields
      details: [],       // rich_text, number
      dates: [],         // date, created_time, etc
      relations: [],     // relation, people
      files: [],         // files
      computed: [],      // formula, rollup
      other: [],
    };
    
    for (const [name, prop] of Object.entries(properties)) {
      const type = prop.type;
      const nameLower = name.toLowerCase();
      
      if (type === 'title') {
        groups.identity.push({ name, ...prop, schema: propertySchema[name] });
      } else if (['email', 'phone_number'].includes(type) || 
                 (type === 'url' && (nameLower.includes('website') || nameLower.includes('social')))) {
        groups.contact.push({ name, ...prop, schema: propertySchema[name] });
      } else if (['status', 'select', 'multi_select'].includes(type)) {
        groups.status.push({ name, ...prop, schema: propertySchema[name] });
      } else if (['rich_text', 'number', 'checkbox'].includes(type)) {
        groups.details.push({ name, ...prop, schema: propertySchema[name] });
      } else if (['date', 'created_time', 'last_edited_time', 'created_by', 'last_edited_by'].includes(type)) {
        groups.dates.push({ name, ...prop, schema: propertySchema[name] });
      } else if (['relation', 'people'].includes(type)) {
        groups.relations.push({ name, ...prop, schema: propertySchema[name] });
      } else if (type === 'files') {
        groups.files.push({ name, ...prop, schema: propertySchema[name] });
      } else if (['formula', 'rollup'].includes(type)) {
        groups.computed.push({ name, ...prop, schema: propertySchema[name] });
      } else if (type === 'url') {
        groups.contact.push({ name, ...prop, schema: propertySchema[name] });
      } else {
        groups.other.push({ name, ...prop, schema: propertySchema[name] });
      }
    }
    
    return groups;
  }, [properties, propertySchema]);

  return {
    // State
    loading,
    blocksLoading,
    saving,
    error,
    success,
    
    // Page data
    pageData,
    properties,
    propertySchema,
    blocks,
    displayName,
    icon,
    
    // Database info
    databaseId,
    databaseSchema,
    
    // Helpers
    isEditable,
    groupedProperties,
    
    // Actions
    loadPage,
    loadBlocks,
    updateProperty,
    updateProperties,
    refresh,
    clearError,
    clearSuccess,
  };
}

export default useCustomerProfile;
