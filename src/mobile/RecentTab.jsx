import { useState, useMemo, useCallback } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { recentlyCategorized } from '../lib/reviewQueue';
import { ALL_CATEGORIES, getCategoryIcon, catColor, catBg } from '../lib/categories';
import { CategorySheet } from './CategorySheet';
import { fmt, fmtRelative } from './format';
import styles from './MobileApp.module.css';

/* What was filed recently, and a way to change your mind.

   Categorizing fast only works if correcting is just as fast — this is where
   a mis-tap gets fixed, so every row opens straight into the picker. */
export function RecentTab() {
  const { transactions, customCategories, hiddenCategories, categoryColors } = useData();
  const { updateTransactionCategory, addCustomCategory } = useDataActions();
  const [editing, setEditing] = useState(null);
  const [query, setQuery] = useState('');

  const overrides = useMemo(() => {
    // recentlyCategorized only needs to know *which* ids the user has decided
    // themselves, so it can float those above whatever the sheet supplied.
    const map = {};
    for (const t of transactions || []) {
      if (t.transactionId && t.category && t.category !== 'Uncategorized') map[t.transactionId] = t.category;
    }
    return map;
  }, [transactions]);

  const rows = useMemo(() => {
    const list = recentlyCategorized(transactions, overrides, 120);
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(t =>
      (t.description || '').toLowerCase().includes(q)
      || (t.category || '').toLowerCase().includes(q)
      || (t.account || '').toLowerCase().includes(q));
  }, [transactions, overrides, query]);

  const usage = useMemo(() => {
    const counts = {};
    for (const t of transactions || []) {
      if (t.category && t.category !== 'Uncategorized') counts[t.category] = (counts[t.category] || 0) + 1;
    }
    return counts;
  }, [transactions]);

  const categoryOptions = useMemo(() => {
    const set = new Set([...ALL_CATEGORIES, ...(customCategories || []), ...Object.keys(usage)]);
    for (const hidden of hiddenCategories || []) set.delete(hidden);
    return [...set];
  }, [customCategories, hiddenCategories, usage]);

  const recategorize = useCallback((cat) => {
    if (!editing) return;
    if (!categoryOptions.includes(cat)) addCustomCategory(cat);
    updateTransactionCategory(editing.transactionId, null, cat);
    setEditing(null);
  }, [editing, categoryOptions, addCustomCategory, updateTransactionCategory]);

  const colorFor = (name) => (categoryColors && categoryColors[name]) || catColor(name);

  return (
    <>
      <div className={styles.search} style={{ marginTop: 'var(--space-4)' }}>
        <span className="material-symbols-outlined" style={{ fontSize: 20 }}>search</span>
        <input
          className={styles.searchInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search filed transactions"
          autoComplete="off"
        />
        {query && (
          <button className={styles.iconBtn} style={{ width: 28, height: 28 }} onClick={() => setQuery('')} aria-label="Clear">
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>cancel</span>
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className={styles.empty}>
          <span className={`material-symbols-outlined ${styles.emptyIcon}`} style={{ color: 'var(--color-text-muted)' }}>
            search_off
          </span>
          <div className={styles.emptyTitle}>Nothing here yet</div>
          <div className={styles.emptyText}>
            {query ? 'No filed transaction matches that.' : 'Categorize a few and they show up here.'}
          </div>
        </div>
      ) : (
        <div className={styles.list}>
          {rows.map((t) => (
            <button
              key={t.transactionId || `${t.date}|${t.description}|${t.amount}`}
              className={styles.listRow}
              onClick={() => t.transactionId && setEditing(t)}
            >
              <span
                className={styles.suggestIcon}
                style={{ background: catBg(t.category, 0.12), color: colorFor(t.category) }}
              >
                <span className="material-symbols-outlined">{getCategoryIcon(t.category)}</span>
              </span>
              <span className={styles.listMain}>
                <span className={styles.listDesc}>{t.description}</span>
                <span className={styles.listMeta}>
                  {t.category}
                  {t.subcategory ? ` · ${t.subcategory}` : ''}
                  {' · '}{fmtRelative(t.date)}
                </span>
              </span>
              <span
                className={styles.listAmount}
                style={{ color: t.amount > 0 ? 'var(--color-success)' : 'var(--color-text-primary)' }}
              >
                {t.amount > 0 ? '+' : ''}{fmt(t.amount)}
              </span>
            </button>
          ))}
        </div>
      )}

      {editing && (
      <CategorySheet
        title={editing.description || 'Change category'}
        categories={categoryOptions}
        usage={usage}
        active={editing.category}
        onPick={recategorize}
        onCreate={recategorize}
        onClose={() => setEditing(null)}
      />
      )}
    </>
  );
}
