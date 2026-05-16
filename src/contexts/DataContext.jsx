import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { fetchTransactions, fetchBalances, computeAnalytics } from '../utils/sheets';
import { db } from '../firebase';
import {
  normalizeDesc,
  txnFallbackKey,
  ruleMatches,
  sameFilters,
  applyRulesToTransactions,
  applySubcategoryRulesToTransactions,
  applyOverrides,
} from '../lib/categorize';

const CONFIG_DOC_PATH = ['config', 'default'];

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

  // ── Firestore sync of category rules + overrides ──────────────────────
  // The Vercel weekly-summary Function reads this same doc so the email
  // applies the user's rules. localStorage stays the fast read source on
  // the client; Firestore is the cross-process source of truth.
  const syncHydrated = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ref = doc(db, ...CONFIG_DOC_PATH);
        const snap = await getDoc(ref);
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data() || {};
          if (Array.isArray(data.categoryRules)) {
            setCategoryRules(data.categoryRules);
            saveCategoryRules(data.categoryRules);
          }
          if (Array.isArray(data.subcategoryRules)) {
            setSubcategoryRules(data.subcategoryRules);
            saveSubcategoryRules(data.subcategoryRules);
          }
          if (data.categoryOverrides && typeof data.categoryOverrides === 'object') {
            setCategoryOverrides(data.categoryOverrides);
            saveCategoryOverrides(data.categoryOverrides);
          }
          if (data.subcategoryOverrides && typeof data.subcategoryOverrides === 'object') {
            setSubcategoryOverrides(data.subcategoryOverrides);
            saveSubcategoryOverrides(data.subcategoryOverrides);
          }
        } else {
          // First-time migration: push current localStorage values up.
          await setDoc(ref, {
            categoryRules: loadCategoryRules(),
            subcategoryRules: loadSubcategoryRules(),
            categoryOverrides: loadCategoryOverrides(),
            subcategoryOverrides: loadSubcategoryOverrides(),
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.warn('Firestore config sync (read) failed:', err);
      } finally {
        if (!cancelled) syncHydrated.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!syncHydrated.current) return;
    const handle = setTimeout(() => {
      setDoc(doc(db, ...CONFIG_DOC_PATH), {
        categoryRules,
        subcategoryRules,
        categoryOverrides,
        subcategoryOverrides,
        updatedAt: new Date().toISOString(),
      }).catch(err => console.warn('Firestore config sync (write) failed:', err));
    }, 500);
    return () => clearTimeout(handle);
  }, [categoryRules, subcategoryRules, categoryOverrides, subcategoryOverrides]);

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
      const matches = (transactionId && t.transactionId === transactionId)
        || (!transactionId && fallbackKey && txnFallbackKey(t) === fallbackKey);
      if (!matches) return t;
      // Preserve the very first observed date so we can show it on hover even after
      // multiple edits (don't overwrite originalDate if it's already set).
      const originalDate = t.originalDate || t.date;
      return { ...t, originalDate, date: newDate };
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
