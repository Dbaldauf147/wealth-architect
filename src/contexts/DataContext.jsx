import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { fetchTransactions, fetchBalances, computeAnalytics } from '../utils/sheets';

const DataContext = createContext(null);

function loadHiddenIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem('hiddenTransactionIds') || '[]'));
  } catch { return new Set(); }
}

function saveHiddenIds(ids) {
  localStorage.setItem('hiddenTransactionIds', JSON.stringify([...ids]));
}

function loadCategoryRules() {
  try {
    return JSON.parse(localStorage.getItem('categoryRules') || '[]');
  } catch { return []; }
}

function saveCategoryRules(rules) {
  localStorage.setItem('categoryRules', JSON.stringify(rules));
}

function loadCategoryOverrides() {
  try {
    return JSON.parse(localStorage.getItem('categoryOverrides') || '{}');
  } catch { return {}; }
}

function saveCategoryOverrides(overrides) {
  localStorage.setItem('categoryOverrides', JSON.stringify(overrides));
}

function applyOverrides(txns, overrides) {
  if (!Object.keys(overrides).length) return txns;
  return txns.map(t => overrides[t.transactionId] ? { ...t, category: overrides[t.transactionId] } : t);
}

function ruleMatches(rule, t) {
  const descMatch = t.description.toLowerCase().trim() === rule.description.toLowerCase().trim();
  if (!descMatch) return false;
  if (rule.amount != null) return Math.abs(t.amount) === Math.abs(rule.amount);
  return true;
}

function applyRulesToTransactions(txns, rules) {
  if (!rules.length) return txns;
  return txns.map(t => {
    for (const rule of rules) {
      if (ruleMatches(rule, t)) return { ...t, category: rule.category };
    }
    return t;
  });
}

export function DataProvider({ children }) {
  const [allTransactions, setAllTransactions] = useState([]);
  const [hiddenIds, setHiddenIds] = useState(loadHiddenIds);
  const [categoryRules, setCategoryRules] = useState(loadCategoryRules);
  const [categoryOverrides, setCategoryOverrides] = useState(loadCategoryOverrides);
  const [balances, setBalances] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastSync, setLastSync] = useState(null);

  const transactions = useMemo(
    () => allTransactions.filter(t => !hiddenIds.has(t.transactionId)),
    [allTransactions, hiddenIds],
  );

  const analytics = useMemo(
    () => transactions.length ? computeAnalytics(transactions) : null,
    [transactions],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [txns, bal] = await Promise.all([
        fetchTransactions(),
        fetchBalances(),
      ]);
      const rules = loadCategoryRules();
      const overrides = loadCategoryOverrides();
      const withRules = applyRulesToTransactions(txns, rules);
      setAllTransactions(applyOverrides(withRules, overrides));
      setBalances(bal);
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

  const updateTransactionCategory = useCallback((transactionId, index, newCategory) => {
    setAllTransactions(prev => prev.map((t, i) => {
      if (transactionId && t.transactionId === transactionId) return { ...t, category: newCategory };
      if (!transactionId && i === index) return { ...t, category: newCategory };
      return t;
    }));
    if (transactionId) {
      setCategoryOverrides(prev => {
        const next = { ...prev, [transactionId]: newCategory };
        saveCategoryOverrides(next);
        return next;
      });
    }
  }, []);

  const bulkUpdateCategory = useCallback((description, amount, newCategory) => {
    setAllTransactions(prev => prev.map(t => {
      const descMatch = t.description.toLowerCase().trim() === description.toLowerCase().trim();
      const amtMatch = amount != null ? Math.abs(t.amount) === Math.abs(amount) : true;
      if (descMatch && amtMatch) return { ...t, category: newCategory };
      return t;
    }));
  }, []);

  const addCategoryRule = useCallback((description, amount, category) => {
    setCategoryRules(prev => {
      // Replace existing rule for same vendor+amount
      const filtered = prev.filter(r =>
        !(r.description.toLowerCase().trim() === description.toLowerCase().trim() &&
          (amount != null ? Math.abs(r.amount) === Math.abs(amount) : r.amount == null))
      );
      const next = [...filtered, { description, amount: amount != null ? Math.abs(amount) : null, category }];
      saveCategoryRules(next);
      return next;
    });
    bulkUpdateCategory(description, amount, category);
  }, [bulkUpdateCategory]);

  const removeCategoryRule = useCallback((index) => {
    setCategoryRules(prev => {
      const next = prev.filter((_, i) => i !== index);
      saveCategoryRules(next);
      return next;
    });
  }, []);

  const bulkUpdateCategoryByIds = useCallback((transactionIds, newCategory) => {
    const idSet = new Set(transactionIds);
    setAllTransactions(prev => prev.map(t =>
      idSet.has(t.transactionId) ? { ...t, category: newCategory } : t
    ));
    setCategoryOverrides(prev => {
      const next = { ...prev };
      for (const id of transactionIds) {
        if (id) next[id] = newCategory;
      }
      saveCategoryOverrides(next);
      return next;
    });
  }, []);

  const getMatchCount = useCallback((description, amount) => {
    return allTransactions.filter(t => {
      const descMatch = t.description.toLowerCase().trim() === description.toLowerCase().trim();
      const amtMatch = amount != null ? Math.abs(t.amount) === Math.abs(amount) : true;
      return descMatch && amtMatch;
    }).length;
  }, [allTransactions]);

  const toggleHideTransaction = useCallback((transactionId) => {
    if (!transactionId) return;
    setHiddenIds(prev => {
      const next = new Set(prev);
      if (next.has(transactionId)) next.delete(transactionId);
      else next.add(transactionId);
      saveHiddenIds(next);
      return next;
    });
  }, []);

  const hiddenTransactions = useMemo(
    () => allTransactions.filter(t => hiddenIds.has(t.transactionId)),
    [allTransactions, hiddenIds],
  );

  return (
    <DataContext.Provider value={{
      transactions,
      balances,
      analytics,
      loading,
      error,
      lastSync,
      refresh: loadData,
      updateTransactionCategory,
      bulkUpdateCategoryByIds,
      addCategoryRule,
      removeCategoryRule,
      categoryRules,
      getMatchCount,
      toggleHideTransaction,
      hiddenTransactions,
      hiddenCount: hiddenIds.size,
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
