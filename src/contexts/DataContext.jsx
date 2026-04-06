import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { fetchTransactions, fetchBalances, computeAnalytics } from '../utils/sheets';

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const [transactions, setTransactions] = useState([]);
  const [balances, setBalances] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastSync, setLastSync] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [txns, bal] = await Promise.all([
        fetchTransactions(),
        fetchBalances(),
      ]);
      setTransactions(txns);
      setBalances(bal);
      setAnalytics(computeAnalytics(txns));
      setLastSync(new Date());
    } catch (err) {
      console.error('Failed to load sheet data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <DataContext.Provider value={{
      transactions,
      balances,
      analytics,
      loading,
      error,
      lastSync,
      refresh: loadData,
    }}>
      {children}
    </DataContext.Provider>
  );
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within DataProvider');
  return ctx;
}
