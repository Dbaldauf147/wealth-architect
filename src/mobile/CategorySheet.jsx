import { useState, useMemo, useEffect } from 'react';
import { getCategoryIcon, catColor, catBg, SUBCATEGORIES } from '../lib/categories';
import styles from './MobileApp.module.css';

/* The full category list, as a bottom sheet.

   Used both when a suggestion is wrong and when the user wants to set a
   subcategory. Search is there because the list is longer than a phone screen
   once custom categories accumulate — but the most-used ones float to the top
   so most picks need no typing at all. */
export function CategorySheet({
  title = 'Choose a category',
  categories,
  usage,
  active,
  onPick,
  onCreate,
  onClose,
}) {
  const [query, setQuery] = useState('');

  // Callers mount the sheet only while it is open, so the search box starts
  // empty every time without an effect having to clear it.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ranked = useMemo(() => {
    const counts = usage || {};
    const list = (categories || []).filter(c => c !== 'Uncategorized');
    return [...list].sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b));
  }, [categories, usage]);

  const q = query.trim().toLowerCase();
  const shown = q ? ranked.filter(c => c.toLowerCase().includes(q)) : ranked;
  // Offer to create only when the typed name isn't already a category.
  const canCreate = !!onCreate && q.length >= 2
    && !ranked.some(c => c.toLowerCase() === q);

  return (
    <>
      <div className={styles.sheetBackdrop} onClick={onClose} />
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.sheetGrip} />
        <div className={styles.sheetHead}>
          <div className={styles.sheetTitle}>{title}</div>
          <button className={styles.iconBtn} onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className={styles.search}>
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>search</span>
          <input
            className={styles.searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search categories"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {query && (
            <button className={styles.iconBtn} style={{ width: 28, height: 28 }} onClick={() => setQuery('')} aria-label="Clear">
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>cancel</span>
            </button>
          )}
        </div>

        <div className={styles.sheetList}>
          {shown.map((cat) => {
            const count = usage?.[cat] || 0;
            return (
              <button
                key={cat}
                className={`${styles.catRow} ${cat === active ? styles.catRowActive : ''}`}
                onClick={() => onPick(cat)}
              >
                <span className={styles.suggestIcon} style={{ background: catBg(cat, 0.12), color: catColor(cat) }}>
                  <span className="material-symbols-outlined">{getCategoryIcon(cat)}</span>
                </span>
                {cat}
                {count > 0 && <span className={styles.catCount}>{count}</span>}
              </button>
            );
          })}

          {canCreate && (
            <button className={`${styles.catRow} ${styles.newCatRow}`} onClick={() => onCreate(query.trim())}>
              <span className={styles.suggestIcon} style={{ background: 'rgba(0,88,190,0.1)', color: 'var(--color-secondary)' }}>
                <span className="material-symbols-outlined">add</span>
              </span>
              Create “{query.trim()}”
            </button>
          )}

          {!shown.length && !canCreate && (
            <div className={styles.empty} style={{ padding: '32px 0' }}>
              <div className={styles.emptyText}>No category matches “{query}”.</div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* The subcategory sheet is the same shape with a different list — separate
   component so the caller doesn't have to thread a mode flag through. */
export function SubcategorySheet({ category, active, onPick, onClose, extra }) {
  const options = useMemo(() => {
    const base = SUBCATEGORIES[category] || [];
    const seen = new Set(base);
    const more = (extra || []).filter(s => s && !seen.has(s));
    return [...base, ...more];
  }, [category, extra]);

  return (
    <>
      <div className={styles.sheetBackdrop} onClick={onClose} />
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Choose a subcategory">
        <div className={styles.sheetGrip} />
        <div className={styles.sheetHead}>
          <div className={styles.sheetTitle}>{category} detail</div>
          <button className={styles.iconBtn} onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className={styles.sheetList}>
          {options.length === 0 && (
            <div className={styles.empty} style={{ padding: '28px 0' }}>
              <div className={styles.emptyText}>No subcategories for {category}.</div>
            </div>
          )}
          {options.map((sub) => (
            <button
              key={sub}
              className={`${styles.catRow} ${sub === active ? styles.catRowActive : ''}`}
              onClick={() => onPick(sub)}
            >
              <span className={styles.suggestIcon} style={{ background: catBg(sub, 0.12), color: catColor(sub) }}>
                <span className="material-symbols-outlined">label</span>
              </span>
              {sub}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
