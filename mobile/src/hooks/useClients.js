/**
 * useClients — CRM clients management hook
 */
import { useState, useCallback, useEffect, useMemo } from 'react';

export function useClients(gateway) {
  const [clients, setClients] = useState([]);
  const [schema, setSchema] = useState(null);
  const [selectedClient, setSelectedClient] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  
  // View state
  const [viewMode, setViewMode] = useState('grid'); // grid | table | kanban
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [sortBy, setSortBy] = useState('updated_at');
  const [sortDir, setSortDir] = useState('desc');
  const [kanbanGroupBy, setKanbanGroupBy] = useState('');
  
  // Notion integration
  const [notionDbId, setNotionDbId] = useState('');
  const [notionSyncing, setNotionSyncing] = useState(false);

  const loadClients = useCallback(async () => {
    if (!gateway?.sendReq) return;
    setLoading(true);
    setError(null);
    try {
      // Use business.clients.list (same as web UI)
      const res = await gateway.sendReq('business.clients.list', {});
      
      if (res?.clients) {
        // Ensure clients have notionId for profile navigation
        const clientsWithIds = res.clients.map(c => ({
          ...c,
          notionId: c.notionId || c.notion_id || c.id,
        }));
        setClients(clientsWithIds);
      }
      if (res?.schema) {
        setSchema(res.schema);
      }
      
      // Also load Notion sync status
      try {
        const syncRes = await gateway.sendReq('business.clients.notion.status', {});
        if (syncRes?.databaseId) {
          setNotionDbId(syncRes.databaseId);
        }
      } catch { /* non-fatal */ }
      
      // If no schema yet, try to load it separately
      if (!res?.schema) {
        try {
          const schemaRes = await gateway.sendReq('business.clients.notion.schema', {});
          if (schemaRes?.schema) setSchema(schemaRes.schema);
        } catch { /* non-fatal */ }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  const createClient = useCallback(async (data) => {
    if (!gateway?.sendReq) return null;
    setLoading(true);
    try {
      // Use business.clients.create (same as web UI)
      const res = await gateway.sendReq('business.clients.create', { data });
      if (res?.client) {
        setClients(prev => [res.client, ...prev]);
        setSuccess('Client created successfully');
        return res.client;
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
    return null;
  }, [gateway]);

  const updateClient = useCallback(async (id, data) => {
    if (!gateway?.sendReq) return null;
    setLoading(true);
    try {
      // Use business.clients.update (same as web UI)
      const res = await gateway.sendReq('business.clients.update', { id, data });
      if (res?.client) {
        setClients(prev => prev.map(c => c.id === id ? res.client : c));
        if (selectedClient?.id === id) {
          setSelectedClient(res.client);
        }
      }
      setSuccess('Client updated');
      return true;
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
    return null;
  }, [gateway, selectedClient]);

  const deleteClient = useCallback(async (id) => {
    if (!gateway?.sendReq) return false;
    setLoading(true);
    try {
      // Use business.clients.delete (same as web UI)
      await gateway.sendReq('business.clients.delete', { id });
      setClients(prev => prev.filter(c => c.id !== id));
      if (selectedClient?.id === id) setSelectedClient(null);
      setSuccess('Client deleted');
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setLoading(false);
    }
  }, [gateway, selectedClient]);

  // Filter & sort clients
  const filteredClients = useMemo(() => {
    let result = [...clients];
    
    // Search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(c => {
        const name = getClientName(c, schema);
        return name.toLowerCase().includes(q) ||
          Object.values(c.data || {}).some(v => 
            String(v).toLowerCase().includes(q)
          );
      });
    }
    
    // Status filter
    if (filterStatus && schema) {
      const statusProp = Object.entries(schema.properties || {})
        .find(([_, p]) => p.type === 'status' || p.type === 'select')?.[0];
      if (statusProp) {
        result = result.filter(c => c.data?.[statusProp] === filterStatus);
      }
    }
    
    // Sort
    result.sort((a, b) => {
      let aVal = a[sortBy] || a.data?.[sortBy] || '';
      let bVal = b[sortBy] || b.data?.[sortBy] || '';
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      if (sortDir === 'asc') return aVal < bVal ? -1 : 1;
      return aVal > bVal ? -1 : 1;
    });
    
    return result;
  }, [clients, searchQuery, filterStatus, sortBy, sortDir, schema]);

  // Group by for kanban
  const clientsByGroup = useMemo(() => {
    if (!kanbanGroupBy || !schema) return {};
    const groups = {};
    filteredClients.forEach(c => {
      const val = c.data?.[kanbanGroupBy] || '—';
      if (!groups[val]) groups[val] = [];
      groups[val].push(c);
    });
    return groups;
  }, [filteredClients, kanbanGroupBy, schema]);

  // Load clients when gateway connects
  useEffect(() => {
    if (gateway?.status === 'connected') {
      loadClients();
    }
  }, [gateway?.status, loadClients]);

  return {
    clients: filteredClients,
    allClients: clients,
    schema,
    selectedClient,
    setSelectedClient,
    loading,
    error,
    success,
    viewMode,
    setViewMode,
    searchQuery,
    setSearchQuery,
    filterStatus,
    setFilterStatus,
    sortBy,
    setSortBy,
    sortDir,
    setSortDir,
    kanbanGroupBy,
    setKanbanGroupBy,
    notionDbId,
    setNotionDbId,
    notionSyncing,
    clientsByGroup,
    loadClients,
    createClient,
    updateClient,
    deleteClient,
    clearError: () => setError(null),
    clearSuccess: () => setSuccess(null),
  };
}

// Helper to extract Notion properties
function extractNotionProperties(properties) {
  const data = {};
  Object.entries(properties || {}).forEach(([name, prop]) => {
    const type = prop.type;
    switch (type) {
      case 'title':
        data[name] = prop.title?.[0]?.plain_text || '';
        break;
      case 'rich_text':
        data[name] = prop.rich_text?.[0]?.plain_text || '';
        break;
      case 'select':
        data[name] = prop.select?.name || '';
        break;
      case 'status':
        data[name] = prop.status?.name || '';
        break;
      case 'multi_select':
        data[name] = prop.multi_select?.map(s => s.name) || [];
        break;
      case 'email':
        data[name] = prop.email || '';
        break;
      case 'phone_number':
        data[name] = prop.phone_number || '';
        break;
      case 'url':
        data[name] = prop.url || '';
        break;
      case 'number':
        data[name] = prop.number;
        break;
      case 'checkbox':
        data[name] = prop.checkbox || false;
        break;
      case 'date':
        data[name] = prop.date?.start || '';
        break;
      default:
        data[name] = prop[type];
    }
  });
  return data;
}

// Helper to get client name from title property
export function getClientName(client, schema) {
  // The schema's title property names the client; when the gateway sends no
  // schema (local store, no Notion database) fall back to the usual fields
  // instead of labelling every client "Unknown".
  const data = client?.data || {};
  const titleProp = Object.entries(schema?.properties || {})
    .find(([_, p]) => p.type === 'title')?.[0];
  return (
    (titleProp && data[titleProp]) ||
    client?.name || data.Name || data.name || data.Title || data.Company || client?.legalName ||
    'Unnamed client'
  );
}
