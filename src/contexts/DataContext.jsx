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

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const loadHiddenIds = () => new Set(loadJSON('hiddenTransactionIds', []));
const saveHiddenIds = (ids) => saveJSON('hiddenTransactionIds', [...ids]);
const loadCategoryRules = () => loadJSON('categoryRules', []);
const saveCategoryRules = (v) => saveJSON('categoryRules', v);
const loadSubcategoryRules = () => loadJSON('subcategoryRules', []);
const saveSubcategoryRules = (v) => saveJSON('subcategoryRules', v);
const loadCategoryOverrides = () => loadJSON('categoryOverrides', {});
const saveCategoryOverrides = (v) => saveJSON('categoryOverrides', v);
const loadSubcategoryOverrides = () => loadJSON('subcategoryOverrides', {});
const saveSubcategoryOverrides = (v) => saveJSON('subcategoryOverrides', v);
const loadDateOverrides = () => loadJSON('dateOverrides', {});
const saveDateOverrides = (v) => saveJSON('dateOverrides', v);
const loadNotes = () => loadJSON('transactionNotes', {});
const saveNotes = (v) => saveJSON('transactionNotes', v);
const loadAccountNicknames = () => {
  // One-time migration: the Assets/Overview pages historically wrote to
  // 'wa-account-nicknames' (localStorage only, no Firestore sync). Pull any
  // existing data into the synced 'accountNicknames' store the first time we
  // see it.
  const current = loadJSON('accountNicknames', null);
  if (current && Object.keys(current).length > 0) return current;
  const legacy = loadJSON('wa-account-nicknames', null);
  if (legacy && Object.keys(legacy).length > 0) {
    saveJSON('accountNicknames', legacy);
    try { localStorage.removeItem('wa-account-nicknames'); } catch { /* ignore */ }
    return legacy;
  }
  return current || {};
};
const saveAccountNicknames = (v) => saveJSON('accountNicknames', v);
const loadCustomCategories = () => loadJSON('customCategories', []);
const saveCustomCategories = (v) => saveJSON('customCategories', v);
const loadHiddenCategories = () => new Set(loadJSON('hiddenCategories', []));
const saveHiddenCategories = (cats) => saveJSON('hiddenCategories', [...cats]);

// ── Union-merge helpers for two-way cross-device sync ────────────────────
function ruleKey(r) {
  return JSON.stringify([
    normalizeDesc(r.description || ''),
    r.sign || null,
    r.minAmount != null && r.minAmount !== '' ? Number(r.minAmount) : null,
    r.maxAmount != null && r.maxAmount !== '' ? Number(r.maxAmount) : null,
  ]);
}

function unionRules(local, remote) {
  const seen = new Set();
  const out = [];
  // Remote first so on duplicate filters remote's category target wins.
  for (const rule of remote || []) {
    const k = ruleKey(rule);
    if (seen.has(k)) continue;
    seen.add(k); out.push(rule);
  }
  for (const rule of local || []) {
    const k = ruleKey(rule);
    if (seen.has(k)) continue;
    seen.add(k); out.push(rule);
  }
  return out;
}

function unionMap(local, remote) {
  // Remote wins on overlapping keys (most recently synced).
  return { ...(local || {}), ...(remote || {}) };
}

function unionStringArray(local, remote) {
  const set = new Set();
  for (const s of remote || []) set.add(s);
  for (const s of local || []) set.add(s);
  return [...set];
}

function unionSet(localSet, remoteArray) {
  const out = new Set(localSet);
  for (const s of remoteArray || []) out.add(s);
  return out;
}

function mergedDiffersFromRemote(merged, remote) {
  const checks = [
    [merged.categoryRules, remote.categoryRules],
    [merged.subcategoryRules, remote.subcategoryRules],
    [merged.customCategories, remote.customCategories],
    [[...merged.hiddenCategories], remote.hiddenCategories],
    [[...merged.hiddenTransactionIds], remote.hiddenTransactionIds],
  ];
  for (const [a, b] of checks) {
    if (!Array.isArray(b) || a.length !== b.length) return true;
  }
  const maps = [
    [merged.categoryOverrides, remote.categoryOverrides],
    [merged.subcategoryOverrides, remote.subcategoryOverrides],
    [merged.dateOverrides, remote.dateOverrides],
    [merged.transactionNotes, remote.transactionNotes],
    [merged.accountNicknames, remote.accountNicknames],
  ];
  for (const [a, b] of maps) {
    const bObj = b && typeof b === 'object' ? b : {};
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return true;
    for (const k of aKeys) {
      if (a[k] !== bObj[k]) return true;
    }
  }
  return false;
}

export function DataProvider({ children }) {
  const [rawTransactions, setRawTransactions] = useState([]);
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
  const [dataLoading, setDataLoading] = useState(true);
  const [configHydrated, setConfigHydrated] = useState(false);
  const [error, setError] = useState(null);
  const [lastSync, setLastSync] = useState(null);

  // ── Firestore sync of all per-user categorization state ───────────────
  // The Vercel weekly-summary Function reads this same doc so the email
  // applies the user's rules/overrides. localStorage is the fast read
  // source on the client; Firestore is the cross-device source of truth.
  //
  // Hydration uses a *union merge* between localStorage and Firestore so a
  // device opening with empty localStorage can't accidentally overwrite
  // another device's data via Firestore. Deletes don't propagate
  // cross-device, but no data is ever lost.
  const syncHydrated = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ref = doc(db, ...CONFIG_DOC_PATH);
        const snap = await getDoc(ref);
        if (cancelled) return;
        const remote = snap.exists() ? (snap.data() || {}) : {};

        const localRules = loadCategoryRules();
        const localSubRules = loadSubcategoryRules();
        const localCatOv = loadCategoryOverrides();
        const localSubOv = loadSubcategoryOverrides();
        const localDateOv = loadDateOverrides();
        const localNotes = loadNotes();
        const localNicks = loadAccountNicknames();
        const localCustomCats = loadCustomCategories();
        const localHiddenCats = loadHiddenCategories();
        const localHiddenIds = loadHiddenIds();

        const merged = {
          categoryRules: unionRules(localRules, Array.isArray(remote.categoryRules) ? remote.categoryRules : []),
          subcategoryRules: unionRules(localSubRules, Array.isArray(remote.subcategoryRules) ? remote.subcategoryRules : []),
          categoryOverrides: unionMap(localCatOv, remote.categoryOverrides),
          subcategoryOverrides: unionMap(localSubOv, remote.subcategoryOverrides),
          dateOverrides: unionMap(localDateOv, remote.dateOverrides),
          transactionNotes: unionMap(localNotes, remote.transactionNotes),
          accountNicknames: unionMap(localNicks, remote.accountNicknames),
          customCategories: unionStringArray(localCustomCats, remote.customCategories),
          hiddenCategories: unionSet(localHiddenCats, remote.hiddenCategories),
          hiddenTransactionIds: unionSet(localHiddenIds, remote.hiddenTransactionIds),
        };

        // Push merged state into React + localStorage.
        setCategoryRules(merged.categoryRules); saveCategoryRules(merged.categoryRules);
        setSubcategoryRules(merged.subcategoryRules); saveSubcategoryRules(merged.subcategoryRules);
        setCategoryOverrides(merged.categoryOverrides); saveCategoryOverrides(merged.categoryOverrides);
        setSubcategoryOverrides(merged.subcategoryOverrides); saveSubcategoryOverrides(merged.subcategoryOverrides);
        setDateOverrides(merged.dateOverrides); saveDateOverrides(merged.dateOverrides);
        setTransactionNotes(merged.transactionNotes); saveNotes(merged.transactionNotes);
        setAccountNicknames(merged.accountNicknames); saveAccountNicknames(merged.accountNicknames);
        setCustomCategories(merged.customCategories); saveCustomCategories(merged.customCategories);
        setHiddenCategories(merged.hiddenCategories); saveHiddenCategories(merged.hiddenCategories);
        setHiddenIds(merged.hiddenTransactionIds); saveHiddenIds(merged.hiddenTransactionIds);

        // If the union added anything that wasn't in the remote, push it
        // back immediately so other devices see the restored data on next
        // load. This self-heals the case where a fresh device clobbered
        // Firestore with empty values before the primary device synced.
        if (mergedDiffersFromRemote(merged, remote)) {
          await setDoc(ref, {
            categoryRules: merged.categoryRules,
            subcategoryRules: merged.subcategoryRules,
            categoryOverrides: merged.categoryOverrides,
            subcategoryOverrides: merged.subcategoryOverrides,
            dateOverrides: merged.dateOverrides,
            transactionNotes: merged.transactionNotes,
            accountNicknames: merged.accountNicknames,
            customCategories: merged.customCategories,
            hiddenCategories: [...merged.hiddenCategories],
            hiddenTransactionIds: [...merged.hiddenTransactionIds],
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.warn('Firestore config sync (read) failed:', err);
      } finally {
        if (!cancelled) {
          syncHydrated.current = true;
          setConfigHydrated(true);
        }
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
        dateOverrides,
        transactionNotes,
        accountNicknames,
        customCategories,
        hiddenCategories: [...hiddenCategories],
        hiddenTransactionIds: [...hiddenIds],
        updatedAt: new Date().toISOString(),
      }).catch(err => console.warn('Firestore config sync (write) failed:', err));
    }, 500);
    return () => clearTimeout(handle);
  }, [
    categoryRules,
    subcategoryRules,
    categoryOverrides,
    subcategoryOverrides,
    dateOverrides,
    transactionNotes,
    accountNicknames,
    customCategories,
    hiddenCategories,
    hiddenIds,
  ]);

  // Derive the categorized transaction list from raw data + current rules
  // and overrides. This makes late-arriving Firestore hydration re-apply
  // categorization automatically, instead of being stuck with whatever was
  // in localStorage when loadData() ran.
  const allTransactions = useMemo(() => {
    if (!rawTransactions.length) return rawTransactions;
    const withRules = applyRulesToTransactions(rawTransactions, categoryRules);
    const withSubRules = applySubcategoryRulesToTransactions(withRules, subcategoryRules);
    return applyOverrides(withSubRules, categoryOverrides, subcategoryOverrides, dateOverrides);
  }, [rawTransactions, categoryRules, subcategoryRules, categoryOverrides, subcategoryOverrides, dateOverrides]);

  const transactions = useMemo(
    () => allTransactions.filter(t => !hiddenIds.has(t.transactionId)),
    [allTransactions, hiddenIds],
  );

  const analytics = useMemo(
    () => transactions.length ? computeAnalytics(transactions) : null,
    [transactions],
  );

  const loadData = useCallback(async () => {
    setDataLoading(true);
    setError(null);
    try {
      const [txns, bal] = await Promise.all([
        fetchTransactions(),
        fetchBalances(),
      ]);
      setRawTransactions(txns);
      setBalances(bal);
      setLastSync(new Date());
    } catch (err) {
      console.error('Failed to load sheet data:', err);
      setError(err.message);
    } finally {
      setDataLoading(false);
    }
  }, []);

  // Gate the "ready" state on both the sheet fetch and the Firestore
  // hydration so consumers don't render uncategorized data on a fresh
  // device while Firestore is still in flight.
  const loading = dataLoading || !configHydrated;

  useEffect(() => {
    loadData();
  }, [loadData]);

  const updateTransactionCategory = useCallback((transactionId, _index, newCategory) => {
    if (!transactionId) return;
    setCategoryOverrides(prev => {
      const next = { ...prev, [transactionId]: newCategory };
      saveCategoryOverrides(next);
      return next;
    });
  }, []);

  const updateTransactionSubcategory = useCallback((transactionId, newSubcategory) => {
    if (!transactionId) return;
    setSubcategoryOverrides(prev => {
      const next = { ...prev, [transactionId]: newSubcategory };
      saveSubcategoryOverrides(next);
      return next;
    });
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
  }, []);

  const updateTransactionDate = useCallback((transactionId, newDate, fallbackKey) => {
    const key = transactionId || fallbackKey;
    if (!key) return;
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
  }, []);

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
  }, []);

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
  }, []);

  const bulkUpdateCategoryByIds = useCallback((transactionIds, newCategory) => {
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
