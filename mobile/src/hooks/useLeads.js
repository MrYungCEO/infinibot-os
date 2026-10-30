/**
 * useLeads — Lead generation management hook
 */
import { useState, useCallback, useEffect } from 'react';

export function useLeads(gateway) {
  const [leads, setLeads] = useState([]);
  const [sources, setSources] = useState([]);
  const [selectedLeads, setSelectedLeads] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [savingToCRM, setSavingToCRM] = useState(false);
  const [error, setError] = useState(null);
  
  // Search params
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLocation, setSearchLocation] = useState('');
  const [searchType, setSearchType] = useState('business');
  const [searchLimit, setSearchLimit] = useState(20);
  const [filterHasEmail, setFilterHasEmail] = useState(false);
  const [filterHasPhone, setFilterHasPhone] = useState(false);
  
  // Settings
  const [showSettings, setShowSettings] = useState(false);
  const [crmDatabaseId, setCrmDatabaseId] = useState('');
  const [lastSearchTotal, setLastSearchTotal] = useState(0);

  const loadSources = useCallback(async () => {
    if (!gateway?.sendReq) return;
    try {
      const res = await gateway.sendReq('leads.sources', {});
      if (res.sources) setSources(res.sources);
    } catch (e) {
      console.error('Failed to load lead sources:', e);
    }
  }, [gateway]);

  const searchLeads = useCallback(async () => {
    if (!gateway?.sendReq || !searchQuery.trim()) {
      setError('Please enter a search query');
      return;
    }
    
    setSearching(true);
    setError(null);
    try {
      const params = {
        query: searchQuery,
        limit: searchLimit,
        type: searchType || undefined,
        location: searchLocation || undefined,
        hasEmail: filterHasEmail || undefined,
        hasPhone: filterHasPhone || undefined,
      };
      
      const res = await gateway.sendReq('leads.search', params);
      if (res.leads) {
        setLeads(res.leads);
        setLastSearchTotal(res.total || res.leads.length);
        setSelectedLeads(new Set());
      }
      if (res.errors?.length) setError(res.errors.join('\n'));
    } catch (e) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  }, [gateway, searchQuery, searchLimit, searchType, searchLocation, filterHasEmail, filterHasPhone]);

  const saveToCRM = useCallback(async (leadId) => {
    if (!gateway?.sendReq) return;
    setSavingToCRM(true);
    setError(null);
    try {
      const res = await gateway.sendReq('leads.saveToCRM', {
        id: leadId,
        databaseId: crmDatabaseId,
      });
      if (res.lead) {
        setLeads(prev => prev.map(l => l.id === leadId ? res.lead : l));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingToCRM(false);
    }
  }, [gateway, crmDatabaseId]);

  const bulkSaveToCRM = useCallback(async () => {
    if (!gateway?.sendReq || selectedLeads.size === 0) {
      setError('No leads selected');
      return;
    }
    
    setSavingToCRM(true);
    setError(null);
    try {
      const res = await gateway.sendReq('leads.bulkSaveToCRM', {
        ids: Array.from(selectedLeads),
        databaseId: crmDatabaseId,
      });
      if (res.failed > 0) {
        setError(`Saved ${res.success} leads, ${res.failed} failed`);
      }
      setSelectedLeads(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingToCRM(false);
    }
  }, [gateway, selectedLeads, crmDatabaseId]);

  const toggleSelectLead = useCallback((id) => {
    setSelectedLeads(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllLeads = useCallback(() => {
    if (selectedLeads.size === leads.length) {
      setSelectedLeads(new Set());
    } else {
      setSelectedLeads(new Set(leads.map(l => l.id)));
    }
  }, [selectedLeads, leads]);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  return {
    leads,
    sources,
    selectedLeads,
    loading,
    searching,
    savingToCRM,
    error,
    searchQuery,
    setSearchQuery,
    searchLocation,
    setSearchLocation,
    searchType,
    setSearchType,
    searchLimit,
    setSearchLimit,
    filterHasEmail,
    setFilterHasEmail,
    filterHasPhone,
    setFilterHasPhone,
    showSettings,
    setShowSettings,
    crmDatabaseId,
    setCrmDatabaseId,
    lastSearchTotal,
    loadSources,
    searchLeads,
    saveToCRM,
    bulkSaveToCRM,
    toggleSelectLead,
    selectAllLeads,
    clearError: () => setError(null),
  };
}
