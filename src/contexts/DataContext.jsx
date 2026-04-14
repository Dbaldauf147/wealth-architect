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

function loadSubcategoryRules() {
  try {
    return JSON.parse(localStorage.getItem('subcategoryRules') || '[]');
  } catch { return []; }
}

function saveSubcategoryRules(rules) {
  localStorage.setItem('subcategoryRules', JSON.stringify(rules));
}

function loadCategoryOverrides() {
  try {
    return JSON.parse(localStorage.getItem('categoryOverrides') || '{}');
  } catch { return {}; }
}

function saveCategoryOverrides(overrides) {
  localStorage.setItem('categoryOverrides', JSON.stringify(overrides));
}

function loadSubcategoryOverrides() {
  try {
    return JSON.parse(localStorage.getItem('subcategoryOverrides') || '{}');
  } catch { return {}; }
}

function saveSubcategoryOverrides(overrides) {
  localStorage.setItem('subcategoryOverrides', JSON.stringify(overrides));
}

function applyOverrides(txns, overrides, subOverrides) {
  const hasCat = Object.keys(overrides).length > 0;
  const hasSub = Object.keys(subOverrides).length > 0;
  if (!hasCat && !hasSub) return txns;
  return txns.map(t => {
    let updated = t;
    if (overrides[t.transactionId]) updated = { ...updated, category: overrides[t.transactionId] };
    if (subOverrides[t.transactionId]) updated = { ...updated, subcategory: subOverrides[t.transactionId] };
    return updated;
  });
}

function loadCustomCategories() {
  try {
    return JSON.parse(localStorage.getItem('customCategories') || '[]');
  } catch { return []; }
}

function saveCustomCategories(cats) {
  localStorage.setItem('customCategories', JSON.stringify(cats));
}

function normalizeDesc(s) {
  return (s || '').toLowerCase().trim().replace(/[\s\-–—]+/g, ' ');
}

function ruleMatches(rule, t) {
  const ruleDesc = normalizeDesc(rule.description);
  const txnDesc = normalizeDesc(t.description);
  if (!ruleDesc || !txnDesc) return false;
  // Match if either contains the other (handles truncation, slight variations)
  return txnDesc.includes(ruleDesc) || ruleDesc.includes(txnDesc);
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

function applySubcategoryRulesToTransactions(txns, rules) {
  if (!rules.length) return txns;
  return txns.map(t => {
    for (const rule of rules) {
      if (ruleMatches(rule, t)) return { ...t, subcategory: rule.subcategory };
    }
    return t;
  });
}

export function DataProvider({ children }) {
  const [allTransactions, setAllTransactions] = useState([]);
  const [hiddenIds, setHiddenIds] = useState(loadHiddenIds);
  const [categoryRules, setCategoryRules] = useState(loadCategoryRules);
  const [subcategoryRules, setSubcategoryRules] = useState(loadSubcategoryRules);
  const [categoryOverrides, setCategoryOverrides] = useState(loadCategoryOverrides);
  const [subcategoryOverrides, setSubcategoryOverrides] = useState(loadSubcategoryOverrides);
  const [customCategories, setCustomCategories] = useState(loadCustomCategories);
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
      const subRules = loadSubcategoryRules();
      const overrides = loadCategoryOverrides();
      const subOverrides = loadSubcategoryOverrides();
      const withRules = applyRulesToTransactions(txns, rules);
      const withSubRules = applySubcategoryRulesToTransactions(withRules, subRules);
      setAllTransactions(applyOverrides(withSubRules, overrides, subOverrides));
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

  const updateTransactionSubcategory = useCallback((transactionId, newSubcategory) => {
    setAllTransactions(prev => prev.map(t =>
      t.transactionId === transactionId ? { ...t, subcategory: newSubcategory } : t
    ));
    if (transactionId) {
      setSubcategoryOverrides(prev => {
        const next = { ...prev, [transactionId]: newSubcategory };
        saveSubcategoryOverrides(next);
        return next;
      });
    }
  }, []);

  const bulkUpdateCategory = useCallback((description, amount, newCategory) => {
    const ruleDesc = normalizeDesc(description);
    setAllTransactions(prev => prev.map(t => {
      const txnDesc = normalizeDesc(t.description);
      if (txnDesc.includes(ruleDesc) || ruleDesc.includes(txnDesc)) {
        return { ...t, category: newCategory };
      }
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

  const bulkUpdateSubcategory = useCallback((description, newSubcategory) => {
    const ruleDesc = normalizeDesc(description);
    setAllTransactions(prev => prev.map(t => {
      const txnDesc = normalizeDesc(t.description);
      if (txnDesc.includes(ruleDesc) || ruleDesc.includes(txnDesc)) {
        return { ...t, subcategory: newSubcategory };
      }
      return t;
    }));
  }, []);

  const addSubcategoryRule = useCallback((description, subcategory) => {
    setSubcategoryRules(prev => {
      const filtered = prev.filter(r =>
        normalizeDesc(r.description) !== normalizeDesc(description)
      );
      const next = [...filtered, { description, subcategory }];
      saveSubcategoryRules(next);
      return next;
    });
    bulkUpdateSubcategory(description, subcategory);
  }, [bulkUpdateSubcategory]);

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

  const addCustomCategory = useCallback((category) => {
    setCustomCategories(prev => {
      if (prev.includes(category)) return prev;
      const next = [...prev, category];
      saveCustomCategories(next);
      return next;
    });
  }, []);

  const getMatchCount = useCallback((description) => {
    const ruleDesc = normalizeDesc(description);
    return allTransactions.filter(t => {
      const txnDesc = normalizeDesc(t.description);
      return txnDesc.includes(ruleDesc) || ruleDesc.includes(txnDesc);
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
      updateTransactionSubcategory,
      bulkUpdateCategoryByIds,
      addCategoryRule,
      removeCategoryRule,
      categoryRules,
      addSubcategoryRule,
      subcategoryRules,
      customCategories,
      addCustomCategory,
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
