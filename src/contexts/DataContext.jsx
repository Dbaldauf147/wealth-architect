import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { fetchTransactions, fetchBalances, fetchBalanceHistory, computeAnalytics } from '../utils/sheets';
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
import { normalizeEmailSections } from '../lib/renderWeeklyEmail';

const CONFIG_DOC_PATH = ['config', 'default'];

const DataContext = createContext(null);
const DataActionsContext = createContext(null);

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
const loadAccountGroups = () => loadJSON('accountGroups', {});
const saveAccountGroups = (v) => saveJSON('accountGroups', v);
const loadAssetClasses = () => loadJSON('assetClasses', {});
const saveAssetClasses = (v) => saveJSON('assetClasses', v);

// Custom user-entered assets and liabilities — for things Tiller doesn't
// see (real estate, vehicles, private holdings, etc.). The values used to
// live on AssetsPage in localStorage only ('wa-custom-assets' /
// 'wa-custom-liabilities'); we now sync them through Firestore so they
// follow the user across devices, and migrate the legacy keys on first
// hydration if the user has anything stored there.
const loadCustomAssets = () => {
  const current = loadJSON('customAssets', null);
  if (Array.isArray(current) && current.length > 0) return current;
  const legacy = loadJSON('wa-custom-assets', null);
  if (Array.isArray(legacy) && legacy.length > 0) {
    saveJSON('customAssets', legacy);
    try { localStorage.removeItem('wa-custom-assets'); } catch { /* ignore */ }
    return legacy;
  }
  return Array.isArray(current) ? current : [];
};
const saveCustomAssets = (v) => saveJSON('customAssets', v);
const loadCustomLiabilities = () => {
  const current = loadJSON('customLiabilities', null);
  if (Array.isArray(current) && current.length > 0) return current;
  const legacy = loadJSON('wa-custom-liabilities', null);
  if (Array.isArray(legacy) && legacy.length > 0) {
    saveJSON('customLiabilities', legacy);
    try { localStorage.removeItem('wa-custom-liabilities'); } catch { /* ignore */ }
    return legacy;
  }
  return Array.isArray(current) ? current : [];
};
const saveCustomLiabilities = (v) => saveJSON('customLiabilities', v);
const loadCustomAssetClasses = () => loadJSON('customAssetClasses', []);
const saveCustomAssetClasses = (v) => saveJSON('customAssetClasses', v);

// Cards the user has marked hidden on the Cards Optimizer / Schedule
// pages. Synced via Firestore so the server-side payment-reminder cron
// respects the same hide list. Legacy 'wa-hidden-cards' is migrated.
const loadHiddenCards = () => {
  const current = loadJSON('hiddenCards', null);
  if (Array.isArray(current) && current.length > 0) return current;
  const legacy = loadJSON('wa-hidden-cards', null);
  if (Array.isArray(legacy) && legacy.length > 0) {
    saveJSON('hiddenCards', legacy);
    try { localStorage.removeItem('wa-hidden-cards'); } catch { /* ignore */ }
    return legacy;
  }
  return Array.isArray(current) ? current : [];
};
const saveHiddenCards = (v) => saveJSON('hiddenCards', v);

// Card payment reminder preferences — synced via Firestore so the
// server cron honors enable/disable and paying-account changes.
const DEFAULT_PAYMENT_REMINDER_PREFS = { enabled: true, payingAccountLast4: '1118' };
const loadPaymentReminderPrefs = () => {
  const stored = loadJSON('paymentReminderPrefs', null);
  return { ...DEFAULT_PAYMENT_REMINDER_PREFS, ...(stored || {}) };
};
const savePaymentReminderPrefs = (v) => saveJSON('paymentReminderPrefs', v);
// Weekly-email section order + visibility — synced via Firestore so the server
// cron renders sections in the user's chosen order. Stored as [{id, enabled}];
// normalizeEmailSections fills in defaults / drops unknown ids.
const loadWeeklyEmailSections = () => normalizeEmailSections(loadJSON('weeklyEmailSections', null));
const saveWeeklyEmailSections = (v) => saveJSON('weeklyEmailSections', v);
const loadCustomCategories = () => loadJSON('customCategories', []);
const saveCustomCategories = (v) => saveJSON('customCategories', v);
const loadHiddenCategories = () => new Set(loadJSON('hiddenCategories', []));
const saveHiddenCategories = (cats) => saveJSON('hiddenCategories', [...cats]);

// ── Stale-while-revalidate cache for sheet data ─────────────────────────
// The Google Sheets fetch is the slowest part of a cold load. We persist
// the last successful result here so subsequent visits render instantly
// from disk while a fresh fetch runs in the background. Stored as a
// single blob so reads/writes stay atomic across the three datasets.
const SHEET_CACHE_KEY = 'sheetDataCache:v1';
function loadSheetCache() {
  const raw = loadJSON(SHEET_CACHE_KEY, null);
  if (!raw || typeof raw !== 'object') return null;
  return {
    transactions: Array.isArray(raw.transactions) ? raw.transactions : [],
    balances: raw.balances || null,
    balanceHistory: Array.isArray(raw.balanceHistory) ? raw.balanceHistory : [],
    lastSync: raw.lastSync || null,
  };
}
function saveSheetCache(payload) {
  try {
    saveJSON(SHEET_CACHE_KEY, {
      transactions: payload.transactions,
      balances: payload.balances,
      balanceHistory: payload.balanceHistory,
      lastSync: payload.lastSync,
    });
  } catch (err) {
    // localStorage can throw on quota; cache is a best-effort optimization.
    console.warn('Failed to cache sheet data:', err.message);
  }
}

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

// Merge arrays of objects keyed by `name`. Local entries win on conflict —
// the assumption is that any edit happened on the device with the more
// recent local copy. Used for customAssets / customLiabilities.
function unionByName(local, remote) {
  const byName = new Map();
  for (const item of remote || []) {
    if (item && item.name) byName.set(item.name, item);
  }
  for (const item of local || []) {
    if (item && item.name) byName.set(item.name, item);
  }
  return Array.from(byName.values());
}

function mergedDiffersFromRemote(merged, remote) {
  const checks = [
    [merged.categoryRules, remote.categoryRules],
    [merged.subcategoryRules, remote.subcategoryRules],
    [merged.customCategories, remote.customCategories],
    [merged.customAssets, remote.customAssets],
    [merged.customLiabilities, remote.customLiabilities],
    [merged.customAssetClasses, remote.customAssetClasses],
    [merged.hiddenCards, remote.hiddenCards],
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
    [merged.accountGroups, remote.accountGroups],
    [merged.assetClasses, remote.assetClasses],
    [merged.paymentReminderPrefs, remote.paymentReminderPrefs],
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
  // Ordered email-section config — compare by serialized order + enabled flags.
  if (JSON.stringify(merged.weeklyEmailSections) !== JSON.stringify(Array.isArray(remote.weeklyEmailSections) ? remote.weeklyEmailSections : null)) {
    return true;
  }
  return false;
}

export function DataProvider({ children }) {
  // Synchronously hydrate sheet data from the SWR cache so the first paint
  // can render real numbers instead of "Loading…". The background fetch
  // started below will overwrite this with fresh data when it returns.
  const initialCache = loadSheetCache();
  // Whether localStorage already contains the user's categorization rules
  // and overrides. If yes, we can paint with them immediately and let
  // Firestore reconcile in the background. If no (fresh device), we still
  // need to block on Firestore so the user doesn't see uncategorized data
  // flash in before the cross-device sync arrives.
  const hasLocalConfigRef = useRef(
    (loadCategoryRules().length + loadSubcategoryRules().length) > 0
    || Object.keys(loadCategoryOverrides()).length > 0
    || Object.keys(loadSubcategoryOverrides()).length > 0,
  );
  const [rawTransactions, setRawTransactions] = useState(initialCache?.transactions || []);
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
  const [accountGroups, setAccountGroups] = useState(loadAccountGroups);
  const [assetClasses, setAssetClasses] = useState(loadAssetClasses);
  const [customAssets, setCustomAssets] = useState(loadCustomAssets);
  const [customLiabilities, setCustomLiabilities] = useState(loadCustomLiabilities);
  const [customAssetClasses, setCustomAssetClasses] = useState(loadCustomAssetClasses);
  const [hiddenCards, setHiddenCards] = useState(loadHiddenCards);
  const [paymentReminderPrefs, setPaymentReminderPrefs] = useState(loadPaymentReminderPrefs);
  const [weeklyEmailSections, setWeeklyEmailSections] = useState(loadWeeklyEmailSections);
  const [rawBalances, setRawBalances] = useState(initialCache?.balances || null);
  const [balanceHistory, setBalanceHistory] = useState(initialCache?.balanceHistory || []);
  // Only true on the first cold load when we have nothing on disk to show.
  // Subsequent refreshes flip `syncing` instead so consumers can render the
  // cached data immediately and reflect "Syncing…" in the chrome.
  const [dataLoading, setDataLoading] = useState(!initialCache);
  const [syncing, setSyncing] = useState(false);
  const [configHydrated, setConfigHydrated] = useState(false);
  const [error, setError] = useState(null);
  const [lastSync, setLastSync] = useState(initialCache?.lastSync ? new Date(initialCache.lastSync) : null);

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
        const localGroups = loadAccountGroups();
        const localAssetClasses = loadAssetClasses();
        const localCustomAssets = loadCustomAssets();
        const localCustomLiabilities = loadCustomLiabilities();
        const localCustomAssetClasses = loadCustomAssetClasses();
        const localHiddenCards = loadHiddenCards();
        const localPaymentReminderPrefs = loadPaymentReminderPrefs();
        const localWeeklyEmailSections = loadJSON('weeklyEmailSections', null);
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
          accountGroups: unionMap(localGroups, remote.accountGroups),
          assetClasses: unionMap(localAssetClasses, remote.assetClasses),
          customAssets: unionByName(localCustomAssets, Array.isArray(remote.customAssets) ? remote.customAssets : []),
          customLiabilities: unionByName(localCustomLiabilities, Array.isArray(remote.customLiabilities) ? remote.customLiabilities : []),
          customAssetClasses: unionStringArray(localCustomAssetClasses, remote.customAssetClasses),
          hiddenCards: unionStringArray(localHiddenCards, remote.hiddenCards),
          paymentReminderPrefs: { ...DEFAULT_PAYMENT_REMINDER_PREFS, ...(remote.paymentReminderPrefs || {}), ...localPaymentReminderPrefs },
          // Ordered list — prefer this device's choice, else remote, else default.
          weeklyEmailSections: normalizeEmailSections(localWeeklyEmailSections || remote.weeklyEmailSections),
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
        setAccountGroups(merged.accountGroups); saveAccountGroups(merged.accountGroups);
        setAssetClasses(merged.assetClasses); saveAssetClasses(merged.assetClasses);
        setCustomAssets(merged.customAssets); saveCustomAssets(merged.customAssets);
        setCustomLiabilities(merged.customLiabilities); saveCustomLiabilities(merged.customLiabilities);
        setCustomAssetClasses(merged.customAssetClasses); saveCustomAssetClasses(merged.customAssetClasses);
        setHiddenCards(merged.hiddenCards); saveHiddenCards(merged.hiddenCards);
        setPaymentReminderPrefs(merged.paymentReminderPrefs); savePaymentReminderPrefs(merged.paymentReminderPrefs);
        setWeeklyEmailSections(merged.weeklyEmailSections); saveWeeklyEmailSections(merged.weeklyEmailSections);
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
            accountGroups: merged.accountGroups,
            assetClasses: merged.assetClasses,
            customAssets: merged.customAssets,
            customLiabilities: merged.customLiabilities,
            customAssetClasses: merged.customAssetClasses,
            hiddenCards: merged.hiddenCards,
            paymentReminderPrefs: merged.paymentReminderPrefs,
            weeklyEmailSections: merged.weeklyEmailSections,
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
        accountGroups,
        assetClasses,
        customAssets,
        customLiabilities,
        customAssetClasses,
        hiddenCards,
        paymentReminderPrefs,
        weeklyEmailSections,
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
    accountGroups,
    assetClasses,
    customAssets,
    customLiabilities,
    customAssetClasses,
    hiddenCards,
    paymentReminderPrefs,
    weeklyEmailSections,
    customCategories,
    hiddenCategories,
    hiddenIds,
  ]);

  // Apply the categorization *rules* to the raw data. This is the expensive
  // pass — O(transactions × rules) with regex normalization per comparison —
  // so it is memoized separately and only re-runs when the raw data or the
  // rules themselves change. Crucially it does NOT depend on the per-txn
  // overrides, so recategorizing a single transaction (which only touches
  // overrides) skips this work entirely.
  const ruledTransactions = useMemo(() => {
    if (!rawTransactions.length) return rawTransactions;
    const withRules = applyRulesToTransactions(rawTransactions, categoryRules);
    return applySubcategoryRulesToTransactions(withRules, subcategoryRules);
  }, [rawTransactions, categoryRules, subcategoryRules]);

  // Layer the per-transaction overrides on top. This is the cheap pass (O(n)
  // map lookups), and it's the only thing that re-runs when the user edits a
  // single category/subcategory/date. Keeping it split from the rule pass is
  // what makes recategorization feel instant. Late-arriving Firestore
  // hydration still re-applies everything automatically via the deps.
  const allTransactions = useMemo(
    () => applyOverrides(ruledTransactions, categoryOverrides, subcategoryOverrides, dateOverrides),
    [ruledTransactions, categoryOverrides, subcategoryOverrides, dateOverrides],
  );

  const transactions = useMemo(
    () => allTransactions.filter(t => !hiddenIds.has(t.transactionId)),
    [allTransactions, hiddenIds],
  );

  const analytics = useMemo(
    () => transactions.length ? computeAnalytics(transactions) : null,
    [transactions],
  );

  // Map of accountName → raw account number string (e.g. "1118" or
  // "XXXX1118"), derived from the transaction stream. Used to show the
  // underlying account / card number in hover tooltips on nicknamed
  // accounts, so the user can always recover what's behind a rename.
  // Picks the most recent non-empty `accountNum` per account so a clean
  // value beats an empty one from earlier rows.
  const accountNumbers = useMemo(() => {
    const out = {};
    for (const t of transactions || []) {
      if (!t.account || !t.accountNum) continue;
      // Latest-write-wins; transactions arrive newest-first in most cases,
      // but we explicitly compare so order doesn't matter.
      if (!out[t.account]) out[t.account] = t.accountNum;
    }
    return out;
  }, [transactions]);

  // Stable handle on the latest `allTransactions` so action callbacks that
  // need to inspect transactions (renameCategory, removeCategory,
  // getMatchCount) don't have to list it in their deps. Without this, those
  // callbacks would change identity on every transaction update, defeating
  // the point of the stable actions context.
  const allTransactionsRef = useRef(allTransactions);
  allTransactionsRef.current = allTransactions;

  // Merge user-entered customs into the sheet-derived balances so every
  // consumer (Overview Net Worth, Asset Allocation, etc.) sees them
  // automatically. Recomputes totals + netWorth so custom entries are
  // first-class instead of a separate sidecar.
  const balances = useMemo(() => {
    if (!rawBalances) return rawBalances;
    const assets = [...(rawBalances.assets || []), ...(customAssets || [])];
    const liabilities = [...(rawBalances.liabilities || []), ...(customLiabilities || [])];
    const totalAssets = assets.reduce((s, a) => s + (a.balance || 0), 0);
    const totalLiabilities = liabilities.reduce((s, l) => s + (l.balance || 0), 0);
    return {
      ...rawBalances,
      assets,
      liabilities,
      totalAssets,
      totalLiabilities,
      netWorth: totalAssets - totalLiabilities,
    };
  }, [rawBalances, customAssets, customLiabilities]);

  // Used inside loadData() so we can suppress the error surface when the
  // background refresh fails but cached data is still on screen — better
  // UX than blowing away the cached numbers with an error page.
  const hasUsableDataRef = useRef(rawTransactions.length > 0 || !!rawBalances);
  useEffect(() => {
    hasUsableDataRef.current = rawTransactions.length > 0 || !!rawBalances;
  }, [rawTransactions, rawBalances]);

  const loadData = useCallback(async () => {
    // If we already have data in memory (from cache), prefer a non-blocking
    // refresh so the UI stays interactive. The "loading" gate is reserved
    // for truly cold loads with nothing to show.
    setSyncing(true);
    setError(null);
    try {
      const [txns, bal, hist] = await Promise.all([
        fetchTransactions(),
        fetchBalances(),
        fetchBalanceHistory(),
      ]);
      const syncedAt = new Date();
      setRawTransactions(txns);
      setRawBalances(bal);
      setBalanceHistory(hist || []);
      setLastSync(syncedAt);
      saveSheetCache({
        transactions: txns,
        balances: bal,
        balanceHistory: hist || [],
        lastSync: syncedAt.toISOString(),
      });
    } catch (err) {
      console.error('Failed to load sheet data:', err);
      // Only surface the error to consumers when we have nothing else to
      // show. With SWR cached data already on screen, a transient sync
      // failure shouldn't replace real numbers with an error page.
      if (!hasUsableDataRef.current) setError(err.message);
    } finally {
      setDataLoading(false);
      setSyncing(false);
    }
  }, []);

  // Block first paint on the Firestore config hydration *only* when
  // localStorage had no rules to render with — that's the case where a
  // fresh device could otherwise flash uncategorized data. When local
  // config exists we paint with it immediately and let Firestore reconcile
  // in the background; the SWR sheet cache uses the same principle.
  const loading = dataLoading || (!configHydrated && !hasLocalConfigRef.current);

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

  // ── Custom assets / liabilities — user-entered items that aren't pulled
  // from the sheet feed. Used for things like real estate, vehicles,
  // private holdings, etc. Each entry is { name, balance, updated, custom: true }.
  const addCustomAsset = useCallback(({ name, balance, className }) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    const item = { name: trimmed, balance: Number(balance) || 0, updated: 'Manual', custom: true };
    setCustomAssets(prev => {
      // Replace by name if it already exists, else append.
      const idx = prev.findIndex(a => a.name === trimmed);
      const next = idx === -1 ? [...prev, item] : prev.map((a, i) => i === idx ? { ...a, ...item } : a);
      saveCustomAssets(next);
      return next;
    });
    if (className) {
      setAssetClasses(prev => {
        const next = { ...prev, [trimmed]: className };
        saveAssetClasses(next);
        return next;
      });
    }
  }, []);

  const updateCustomAsset = useCallback((name, patch) => {
    if (!name) return;
    setCustomAssets(prev => {
      const next = prev.map(a => a.name === name ? { ...a, ...patch, balance: patch.balance != null ? Number(patch.balance) || 0 : a.balance } : a);
      saveCustomAssets(next);
      return next;
    });
    if (patch && patch.name && patch.name !== name) {
      setAssetClasses(prev => {
        if (!prev[name]) return prev;
        const next = { ...prev, [patch.name]: prev[name] };
        delete next[name];
        saveAssetClasses(next);
        return next;
      });
    }
  }, []);

  const removeCustomAsset = useCallback((name) => {
    if (!name) return;
    setCustomAssets(prev => {
      const next = prev.filter(a => a.name !== name);
      saveCustomAssets(next);
      return next;
    });
    setAssetClasses(prev => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      saveAssetClasses(next);
      return next;
    });
  }, []);

  const addCustomLiability = useCallback(({ name, balance }) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    const item = { name: trimmed, balance: Number(balance) || 0, updated: 'Manual', custom: true };
    setCustomLiabilities(prev => {
      const idx = prev.findIndex(a => a.name === trimmed);
      const next = idx === -1 ? [...prev, item] : prev.map((a, i) => i === idx ? { ...a, ...item } : a);
      saveCustomLiabilities(next);
      return next;
    });
  }, []);

  const updateCustomLiability = useCallback((name, patch) => {
    if (!name) return;
    setCustomLiabilities(prev => {
      const next = prev.map(a => a.name === name ? { ...a, ...patch, balance: patch.balance != null ? Number(patch.balance) || 0 : a.balance } : a);
      saveCustomLiabilities(next);
      return next;
    });
  }, []);

  const removeCustomLiability = useCallback((name) => {
    if (!name) return;
    setCustomLiabilities(prev => {
      const next = prev.filter(a => a.name !== name);
      saveCustomLiabilities(next);
      return next;
    });
  }, []);

  const updatePaymentReminderPrefs = useCallback((patch) => {
    setPaymentReminderPrefs(prev => {
      const next = { ...prev, ...(patch || {}) };
      savePaymentReminderPrefs(next);
      return next;
    });
  }, []);

  // Replace the full ordered email-section config (order + enabled). Always
  // normalized so a bad input can't desync from the canonical section list.
  const updateWeeklyEmailSections = useCallback((nextSections) => {
    const normalized = normalizeEmailSections(nextSections);
    setWeeklyEmailSections(normalized);
    saveWeeklyEmailSections(normalized);
  }, []);

  const toggleHideCard = useCallback((cardName) => {
    if (!cardName) return;
    setHiddenCards(prev => {
      const next = prev.includes(cardName)
        ? prev.filter(n => n !== cardName)
        : [...prev, cardName];
      saveHiddenCards(next);
      return next;
    });
  }, []);

  const addCustomAssetClass = useCallback((className) => {
    const trimmed = (className || '').trim();
    if (!trimmed) return;
    setCustomAssetClasses(prev => {
      if (prev.includes(trimmed)) return prev;
      const next = [...prev, trimmed];
      saveCustomAssetClasses(next);
      return next;
    });
  }, []);

  const removeCustomAssetClass = useCallback((className) => {
    if (!className) return;
    setCustomAssetClasses(prev => {
      const next = prev.filter(c => c !== className);
      saveCustomAssetClasses(next);
      return next;
    });
    // Also clear any account assignments to that class.
    setAssetClasses(prev => {
      const next = {};
      let changed = false;
      for (const [k, v] of Object.entries(prev)) {
        if (v === className) { changed = true; continue; }
        next[k] = v;
      }
      if (!changed) return prev;
      saveAssetClasses(next);
      return next;
    });
  }, []);

  // Assign `accountName` to an asset class (Cash / Stocks / Retirement), or
  // remove the assignment when className is falsy.
  const setAssetClass = useCallback((accountName, className) => {
    setAssetClasses(prev => {
      const next = { ...prev };
      const trimmed = (className || '').trim();
      if (trimmed) next[accountName] = trimmed;
      else delete next[accountName];
      saveAssetClasses(next);
      return next;
    });
  }, []);

  // Assign `accountName` to `groupName`, or remove from any group when null.
  const setAccountGroup = useCallback((accountName, groupName) => {
    setAccountGroups(prev => {
      const next = { ...prev };
      const trimmed = (groupName || '').trim();
      if (trimmed) next[accountName] = trimmed;
      else delete next[accountName];
      saveAccountGroups(next);
      return next;
    });
  }, []);

  // Rename a group: every account that points at oldName now points at newName.
  const renameGroup = useCallback((oldName, newName) => {
    const trimmed = (newName || '').trim();
    if (!trimmed || trimmed === oldName) return;
    setAccountGroups(prev => {
      const next = {};
      for (const [acct, g] of Object.entries(prev)) {
        next[acct] = g === oldName ? trimmed : g;
      }
      saveAccountGroups(next);
      return next;
    });
  }, []);

  // Disband a group: clear membership for every member.
  const deleteGroup = useCallback((groupName) => {
    setAccountGroups(prev => {
      const next = {};
      for (const [acct, g] of Object.entries(prev)) {
        if (g !== groupName) next[acct] = g;
      }
      saveAccountGroups(next);
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
    const affectedIds = allTransactionsRef.current
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
  }, []);

  const removeCategory = useCallback((name, reassignTo = '') => {
    const affectedIds = allTransactionsRef.current
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
  }, []);

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
    return allTransactionsRef.current.filter(t => ruleMatches(ruleLike, t)).length;
  }, []);

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

  // Stable bag of action callbacks. Every callback is wrapped in useCallback
  // with [] deps (or reads state via refs), so this object's identity never
  // changes after mount. Components that only need to write can subscribe to
  // DataActionsContext via useDataActions() and skip re-renders entirely
  // when reads (transactions, overrides, etc.) change.
  const actions = useMemo(() => ({
    refresh: loadData,
    updateTransactionCategory,
    updateTransactionSubcategory,
    updateTransactionDate,
    bulkUpdateCategoryByIds,
    addCategoryRule,
    removeCategoryRule,
    updateCategoryRule,
    addSubcategoryRule,
    removeSubcategoryRule,
    updateSubcategoryRule,
    addCustomCategory,
    renameCategory,
    removeCategory,
    unhideCategory,
    updateTransactionNote,
    setAccountNickname,
    setAccountGroup,
    setAssetClass,
    addCustomAsset,
    updateCustomAsset,
    removeCustomAsset,
    addCustomLiability,
    updateCustomLiability,
    removeCustomLiability,
    addCustomAssetClass,
    removeCustomAssetClass,
    toggleHideCard,
    updatePaymentReminderPrefs,
    updateWeeklyEmailSections,
    renameGroup,
    deleteGroup,
    toggleHideTransaction,
    getMatchCount,
  }), [
    loadData,
    updateTransactionCategory,
    updateTransactionSubcategory,
    updateTransactionDate,
    bulkUpdateCategoryByIds,
    addCategoryRule,
    removeCategoryRule,
    updateCategoryRule,
    addSubcategoryRule,
    removeSubcategoryRule,
    updateSubcategoryRule,
    addCustomCategory,
    renameCategory,
    removeCategory,
    unhideCategory,
    updateTransactionNote,
    setAccountNickname,
    setAccountGroup,
    setAssetClass,
    addCustomAsset,
    updateCustomAsset,
    removeCustomAsset,
    addCustomLiability,
    updateCustomLiability,
    removeCustomLiability,
    addCustomAssetClass,
    removeCustomAssetClass,
    toggleHideCard,
    updatePaymentReminderPrefs,
    updateWeeklyEmailSections,
    renameGroup,
    deleteGroup,
    toggleHideTransaction,
    getMatchCount,
  ]);

  // Read-side value also memoized so consumers don't see a new object
  // identity unless something they actually depend on changed.
  const reads = useMemo(() => ({
    transactions,
    balances,
    balanceHistory,
    analytics,
    loading,
    syncing,
    error,
    lastSync,
    categoryRules,
    subcategoryRules,
    customCategories,
    hiddenCategories,
    transactionNotes,
    accountNicknames,
    accountNumbers,
    accountGroups,
    assetClasses,
    customAssets,
    customLiabilities,
    customAssetClasses,
    hiddenCards,
    paymentReminderPrefs,
    weeklyEmailSections,
    hiddenTransactions,
    hiddenCount: hiddenIds.size,
  }), [
    transactions,
    balances,
    balanceHistory,
    analytics,
    loading,
    syncing,
    error,
    lastSync,
    categoryRules,
    subcategoryRules,
    customCategories,
    hiddenCategories,
    transactionNotes,
    accountNicknames,
    accountNumbers,
    accountGroups,
    assetClasses,
    customAssets,
    customLiabilities,
    customAssetClasses,
    hiddenCards,
    paymentReminderPrefs,
    weeklyEmailSections,
    hiddenTransactions,
    hiddenIds,
  ]);

  return (
    <DataActionsContext.Provider value={actions}>
      <DataContext.Provider value={reads}>
        {children}
      </DataContext.Provider>
    </DataActionsContext.Provider>
  );
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within DataProvider');
  return ctx;
}

export function useDataActions() {
  const ctx = useContext(DataActionsContext);
  if (!ctx) throw new Error('useDataActions must be used within DataProvider');
  return ctx;
}
