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

function loadDateOverrides() {
  try {
    return JSON.parse(localStorage.getItem('dateOverrides') || '{}');
  } catch { return {}; }
}

function saveDateOverrides(overrides) {
  localStorage.setItem('dateOverrides', JSON.stringify(overrides));
}

function loadNotes() {
  try {
    return JSON.parse(localStorage.getItem('transactionNotes') || '{}');
  } catch { return {}; }
}

function saveNotes(notes) {
  localStorage.setItem('transactionNotes', JSON.stringify(notes));
}

function loadAccountNicknames() {
  try {
    return JSON.parse(localStorage.getItem('accountNicknames') || '{}');
  } catch { return {}; }
}

function saveAccountNicknames(nicknames) {
  localStorage.setItem('accountNicknames', JSON.stringify(nicknames));
}

/* Build a composite key for transactions without a stable transactionId */
function txnFallbackKey(t) {
  return `${t.date || ''}|${(t.description || '').trim()}|${t.amount}`;
}

function applyOverrides(txns, overrides, subOverrides, dateOverrides) {
  const hasCat = Object.keys(overrides).length > 0;
  const hasSub = Object.keys(subOverrides).length > 0;
  const hasDate = dateOverrides && Object.keys(dateOverrides).length > 0;
  if (!hasCat && !hasSub && !hasDate) return txns;
  return txns.map(t => {
    let updated = t;
    const id = t.transactionId;
    const fb = txnFallbackKey(t);
    if (id && overrides[id]) updated = { ...updated, category: overrides[id] };
    else if (overrides[fb]) updated = { ...updated, category: overrides[fb] };
    if (id && subOverrides[id]) updated = { ...updated, subcategory: subOverrides[id] };
    else if (subOverrides[fb]) updated = { ...updated, subcategory: subOverrides[fb] };
    if (hasDate) {
      if (id && dateOverrides[id]) updated = { ...updated, date: dateOverrides[id] };
      else if (dateOverrides[fb]) updated = { ...updated, date: dateOverrides[fb] };
    }
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

function loadHiddenCategories() {
  try {
    return new Set(JSON.parse(localStorage.getItem('hiddenCategories') || '[]'));
  } catch { return new Set(); }
}

function saveHiddenCategories(cats) {
  localStorage.setItem('hiddenCategories', JSON.stringify([...cats]));
}

function normalizeDesc(s) {
  return (s || '').toLowerCase().trim().replace(/[\s\-–—]+/g, ' ');
}

function ruleMatches(rule, t) {
  const ruleDesc = normalizeDesc(rule.description);
  const hasDesc = !!ruleDesc;
  const hasSign = rule.sign === 'positive' || rule.sign === 'negative';
  const hasMin = rule.minAmount != null && !Number.isNaN(Number(rule.minAmount));
  const hasMax = rule.maxAmount != null && !Number.isNaN(Number(rule.maxAmount));
  // A rule with zero filters would match every transaction — reject to be safe.
  if (!hasDesc && !hasSign && !hasMin && !hasMax) return false;

  if (hasDesc) {
    const txnDesc = normalizeDesc(t.description);
    const txnFull = normalizeDesc(t.fullDescription);
    let descMatch = false;
    if (txnDesc && (txnDesc.includes(ruleDesc) || ruleDesc.includes(txnDesc))) descMatch = true;
    if (!descMatch && txnFull && txnFull.includes(ruleDesc)) descMatch = true;
    if (!descMatch) return false;
  }

  const amt = typeof t.amount === 'number' ? t.amount : parseFloat(t.amount);
  if (hasSign) {
    if (rule.sign === 'positive' && !(amt > 0)) return false;
    if (rule.sign === 'negative' && !(amt < 0)) return false;
  }
  const absAmt = Math.abs(amt);
  if (hasMin && absAmt < Number(rule.minAmount)) return false;
  if (hasMax && absAmt > Number(rule.maxAmount)) return false;

  return true;
}

function sameFilters(a, b) {
  return (
    normalizeDesc(a.description) === normalizeDesc(b.description) &&
    (a.sign || null) === (b.sign || null) &&
    (a.minAmount != null ? Number(a.minAmount) : null) === (b.minAmount != null ? Number(b.minAmount) : null) &&
    (a.maxAmount != null ? Number(a.maxAmount) : null) === (b.maxAmount != null ? Number(b.maxAmount) : null)
  );
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
  const [dateOverrides, setDateOverrides] = useState(loadDateOverrides);
  const [customCategories, setCustomCategories] = useState(loadCustomCategories);
  const [hiddenCategories, setHiddenCategories] = useState(loadHiddenCategories);
  const [transactionNotes, setTransactionNotes] = useState(loadNotes);
  const [accountNicknames, setAccountNicknames] = useState(loadAccountNicknames);
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
      const dOverrides = loadDateOverrides();
      const withRules = applyRulesToTransactions(txns, rules);
      const withSubRules = applySubcategoryRulesToTransactions(withRules, subRules);
      setAllTransactions(applyOverrides(withSubRules, overrides, subOverrides, dOverrides));
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

  const bulkUpdateCategoryByRule = useCallback((ruleLike, newCategory) => {
    setAllTransactions(prev => prev.map(t => {
      if (ruleMatches(ruleLike, t)) return { ...t, category: newCategory };
      return t;
    }));
  }, []);

  const addCategoryRule = useCallback((description, amount, category, options) => {
    const opts = options || {};
    const ruleObj = {
      description: description || '',
      amount: amount != null ? Math.abs(amount) : null,
      sign: opts.sign || null,
      minAmount: opts.minAmount != null && opts.minAmount !== '' ? Number(opts.minAmount) : null,
      maxAmount: opts.maxAmount != null && opts.maxAmount !== '' ? Number(opts.maxAmount) : null,
      category,
    };
    setCategoryRules(prev => {
      const filtered = prev.filter(r => !sameFilters(r, ruleObj));
      const next = [...filtered, ruleObj];
      saveCategoryRules(next);
      return next;
    });
    bulkUpdateCategoryByRule(ruleObj, category);
  }, [bulkUpdateCategoryByRule]);

  const updateTransactionDate = useCallback((transactionId, newDate, fallbackKey) => {
    const key = transactionId || fallbackKey;
    if (!key) return;
    setAllTransactions(prev => prev.map(t => {
      if (transactionId && t.transactionId === transactionId) return { ...t, date: newDate };
      if (!transactionId && fallbackKey && txnFallbackKey(t) === fallbackKey) return { ...t, date: newDate };
      return t;
    }));
    setDateOverrides(prev => {
      const next = { ...prev };
      if (newDate) next[key] = newDate;
      else delete next[key];
      saveDateOverrides(next);
      return next;
    });
  }, []);

  const updateTransactionNote = useCallback((transactionId, note) => {
    if (!transactionId) return;
    setTransactionNotes(prev => {
      const next = { ...prev };
      if (note) next[transactionId] = note;
      else delete next[transactionId];
      saveNotes(next);
      return next;
    });
  }, []);

  const setAccountNickname = useCallback((accountName, nickname) => {
    setAccountNicknames(prev => {
      const next = { ...prev };
      if (nickname) next[accountName] = nickname;
      else delete next[accountName];
      saveAccountNicknames(next);
      return next;
    });
  }, []);

  const bulkUpdateSubcategoryByRule = useCallback((ruleLike, newSubcategory) => {
    setAllTransactions(prev => prev.map(t => {
      if (ruleMatches(ruleLike, t)) return { ...t, subcategory: newSubcategory };
      return t;
    }));
  }, []);

  const addSubcategoryRule = useCallback((description, subcategory, options) => {
    const opts = options || {};
    const ruleObj = {
      description: description || '',
      sign: opts.sign || null,
      minAmount: opts.minAmount != null && opts.minAmount !== '' ? Number(opts.minAmount) : null,
      maxAmount: opts.maxAmount != null && opts.maxAmount !== '' ? Number(opts.maxAmount) : null,
      subcategory,
    };
    setSubcategoryRules(prev => {
      const filtered = prev.filter(r => !sameFilters(r, ruleObj));
      const next = [...filtered, ruleObj];
      saveSubcategoryRules(next);
      return next;
    });
    bulkUpdateSubcategoryByRule(ruleObj, subcategory);
  }, [bulkUpdateSubcategoryByRule]);

  const removeCategoryRule = useCallback((index) => {
    setCategoryRules(prev => {
      const next = prev.filter((_, i) => i !== index);
      saveCategoryRules(next);
      return next;
    });
  }, []);

  const removeSubcategoryRule = useCallback((index) => {
    setSubcategoryRules(prev => {
      const next = prev.filter((_, i) => i !== index);
      saveSubcategoryRules(next);
      return next;
    });
  }, []);

  const updateCategoryRule = useCallback((index, newDescription, newCategory, options) => {
    const opts = options || {};
    const patch = {
      description: newDescription || '',
      category: newCategory,
      sign: opts.sign || null,
      minAmount: opts.minAmount != null && opts.minAmount !== '' ? Number(opts.minAmount) : null,
      maxAmount: opts.maxAmount != null && opts.maxAmount !== '' ? Number(opts.maxAmount) : null,
    };
    setCategoryRules(prev => {
      const next = prev.map((r, i) => i === index ? { ...r, ...patch } : r);
      saveCategoryRules(next);
      return next;
    });
    bulkUpdateCategoryByRule(patch, newCategory);
  }, [bulkUpdateCategoryByRule]);

  const updateSubcategoryRule = useCallback((index, newDescription, newSubcategory, options) => {
    const opts = options || {};
    const patch = {
      description: newDescription || '',
      subcategory: newSubcategory,
      sign: opts.sign || null,
      minAmount: opts.minAmount != null && opts.minAmount !== '' ? Number(opts.minAmount) : null,
      maxAmount: opts.maxAmount != null && opts.maxAmount !== '' ? Number(opts.maxAmount) : null,
    };
    setSubcategoryRules(prev => {
      const next = prev.map((r, i) => i === index ? { ...r, ...patch } : r);
      saveSubcategoryRules(next);
      return next;
    });
    bulkUpdateSubcategoryByRule(patch, newSubcategory);
  }, [bulkUpdateSubcategoryByRule]);

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
    setHiddenCategories(prev => {
      if (!prev.has(category)) return prev;
      const next = new Set(prev);
      next.delete(category);
      saveHiddenCategories(next);
      return next;
    });
  }, []);

  const renameCategory = useCallback((oldName, newName) => {
    const trimmed = (newName || '').trim();
    if (!trimmed || trimmed === oldName) return;
    const affectedIds = allTransactions
      .filter(t => (t.category || '') === oldName && t.transactionId)
      .map(t => t.transactionId);

    setAllTransactions(prev => prev.map(t =>
      (t.category || '') === oldName ? { ...t, category: trimmed } : t
    ));

    setCategoryOverrides(prev => {
      const next = { ...prev };
      for (const id of affectedIds) next[id] = trimmed;
      saveCategoryOverrides(next);
      return next;
    });

    setCustomCategories(prev => {
      const withoutOld = prev.filter(c => c !== oldName);
      const next = withoutOld.includes(trimmed) ? withoutOld : [...withoutOld, trimmed];
      saveCustomCategories(next);
      return next;
    });

    setHiddenCategories(prev => {
      const next = new Set(prev);
      next.add(oldName);
      next.delete(trimmed);
      saveHiddenCategories(next);
      return next;
    });

    setCategoryRules(prev => {
      const next = prev.map(r => r.category === oldName ? { ...r, category: trimmed } : r);
      saveCategoryRules(next);
      return next;
    });
  }, [allTransactions]);

  const removeCategory = useCallback((name, reassignTo = '') => {
    const affectedIds = allTransactions
      .filter(t => (t.category || '') === name && t.transactionId)
      .map(t => t.transactionId);

    setAllTransactions(prev => prev.map(t =>
      (t.category || '') === name ? { ...t, category: reassignTo } : t
    ));

    setCategoryOverrides(prev => {
      const next = { ...prev };
      for (const id of affectedIds) next[id] = reassignTo;
      saveCategoryOverrides(next);
      return next;
    });

    setCustomCategories(prev => {
      const next = prev.filter(c => c !== name);
      saveCustomCategories(next);
      return next;
    });

    setHiddenCategories(prev => {
      const next = new Set(prev);
      next.add(name);
      saveHiddenCategories(next);
      return next;
    });

    setCategoryRules(prev => {
      const next = prev.filter(r => r.category !== name);
      saveCategoryRules(next);
      return next;
    });
  }, [allTransactions]);

  const unhideCategory = useCallback((name) => {
    setHiddenCategories(prev => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      saveHiddenCategories(next);
      return next;
    });
  }, []);

  const getMatchCount = useCallback((description, options) => {
    const opts = options || {};
    const ruleLike = {
      description: description || '',
      sign: opts.sign || null,
      minAmount: opts.minAmount != null && opts.minAmount !== '' ? Number(opts.minAmount) : null,
      maxAmount: opts.maxAmount != null && opts.maxAmount !== '' ? Number(opts.maxAmount) : null,
    };
    return allTransactions.filter(t => ruleMatches(ruleLike, t)).length;
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
      updateTransactionDate,
      bulkUpdateCategoryByIds,
      addCategoryRule,
      removeCategoryRule,
      updateCategoryRule,
      removeSubcategoryRule,
      updateSubcategoryRule,
      categoryRules,
      addSubcategoryRule,
      subcategoryRules,
      customCategories,
      addCustomCategory,
      hiddenCategories,
      renameCategory,
      removeCategory,
      unhideCategory,
      transactionNotes,
      updateTransactionNote,
      accountNicknames,
      setAccountNickname,
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
