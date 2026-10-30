/**
 * useIncome — Real-time income tracking with Notion sync
 * Integrates with Whop, Stripe, and manual entries
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// Notion Database IDs
const NOTION_INCOME_STREAMS_DB = '279f4bdd-9bcf-801e-91f1-c6a06540f167';
const NOTION_INCOME_LOG_DB = null; // Will create if doesn't exist

// Income stream sources
export const INCOME_SOURCES = {
  WHOP: 'whop',
  STRIPE: 'stripe',
  PAYPAL: 'paypal',
  CASH: 'cash',
  CRYPTO: 'crypto',
  OTHER: 'other',
};

export function useIncome(gateway) {
  const { sendReq, status } = gateway || {};
  const connected = status === 'connected';
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({
    today: 0,
    week: 0,
    month: 0,
    year: 0,
    allTime: 0,
  });
  const [recentTransactions, setRecentTransactions] = useState([]);
  const [incomeStreams, setIncomeStreams] = useState([]);
  const [dailyData, setDailyData] = useState([]);
  const [monthlyData, setMonthlyData] = useState([]);
  
  const pollRef = useRef(null);

  // Load all income data
  const loadIncomeData = useCallback(async () => {
    if (!connected || !sendReq) return;
    
    try {
      setError(null);
      
      // Fetch income stats from gateway
      const result = await sendReq('business.income.stats', {});
      
      if (result) {
        setStats({
          today: result.today || 0,
          week: result.week || 0,
          month: result.month || 0,
          year: result.year || 0,
          allTime: result.allTime || 0,
        });
        
        if (result.recentTransactions) {
          setRecentTransactions(result.recentTransactions);
        }
        
        if (result.incomeStreams) {
          setIncomeStreams(result.incomeStreams);
        }
        
        if (result.dailyData) {
          setDailyData(result.dailyData);
        }
        
        if (result.monthlyData) {
          setMonthlyData(result.monthlyData);
        }
      }
    } catch (err) {
      console.error('Failed to load income data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [connected, sendReq]);

  // Log a manual income entry
  const logIncome = useCallback(async ({
    amount,
    source,
    description,
    streamId,
    date,
    metadata,
  }) => {
    if (!connected || !sendReq) {
      throw new Error('Not connected');
    }
    
    const result = await sendReq('business.income.log', {
      amount,
      source: source || INCOME_SOURCES.OTHER,
      description,
      streamId,
      date: date || new Date().toISOString(),
      metadata,
      syncToNotion: true,
    });
    
    // Refresh data after logging
    await loadIncomeData();
    
    return result;
  }, [connected, sendReq, loadIncomeData]);

  // Sync with Whop
  const syncWhop = useCallback(async () => {
    if (!connected || !sendReq) return;
    
    try {
      const result = await sendReq('business.income.syncWhop', {});
      await loadIncomeData();
      return result;
    } catch (err) {
      console.error('Whop sync failed:', err);
      throw err;
    }
  }, [connected, sendReq, loadIncomeData]);

  // Sync with Stripe
  const syncStripe = useCallback(async () => {
    if (!connected || !sendReq) return;
    
    try {
      const result = await sendReq('business.income.syncStripe', {});
      await loadIncomeData();
      return result;
    } catch (err) {
      console.error('Stripe sync failed:', err);
      throw err;
    }
  }, [connected, sendReq, loadIncomeData]);

  // Create or update income stream
  const upsertIncomeStream = useCallback(async ({
    id,
    name,
    type,
    source,
    expectedMonthly,
    isActive,
    webhookUrl,
    apiKey,
  }) => {
    if (!connected || !sendReq) {
      throw new Error('Not connected');
    }
    
    const result = await sendReq('business.income.upsertStream', {
      id,
      name,
      type,
      source,
      expectedMonthly,
      isActive,
      webhookUrl,
      apiKey,
    });
    
    await loadIncomeData();
    return result;
  }, [connected, sendReq, loadIncomeData]);

  // Get daily breakdown
  const getDailyBreakdown = useCallback(async (startDate, endDate) => {
    if (!connected || !sendReq) return [];
    
    try {
      const result = await sendReq('business.income.daily', {
        startDate,
        endDate,
      });
      return result?.data || [];
    } catch (err) {
      console.error('Failed to get daily breakdown:', err);
      return [];
    }
  }, [connected, sendReq]);

  // Initial load
  useEffect(() => {
    if (connected) {
      loadIncomeData();
    }
  }, [connected, loadIncomeData]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    if (connected) {
      pollRef.current = setInterval(loadIncomeData, 5 * 60 * 1000);
      return () => clearInterval(pollRef.current);
    }
  }, [connected, loadIncomeData]);

  return {
    loading,
    error,
    stats,
    recentTransactions,
    incomeStreams,
    dailyData,
    monthlyData,
    // Actions
    refresh: loadIncomeData,
    logIncome,
    syncWhop,
    syncStripe,
    upsertIncomeStream,
    getDailyBreakdown,
  };
}

export default useIncome;
