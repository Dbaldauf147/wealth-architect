import { useState, useMemo, useCallback } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { ruleMatches } from '../lib/categorize';
import { ALL_CATEGORIES, SUBCATEGORIES, getCategoryIcon, catColor, catBg } from '../lib/categories';
import { CategorySheet, SubcategorySheet } from './CategorySheet';
import styles from './MobileApp.module.css';

/* Managing the rules themselves.

   A rule saved from the review deck is a guess made in two seconds; this is
   where it gets corrected. Both kinds live here — a rule that files a merchant
   under a category and one that files it under a detail — because from the
   user's side they are the same idea and keeping them on separate screens
   would only make you remember which is which.

   Every row shows how many transactions the rule currently matches, so an
   over-broad filter ("uber" catching Uber Eats *and* Uber rides) is visible
   before it has quietly mis-filed a year of spending. */

const KINDS = {
  category: {
    id: 'category',
    label: 'Category',
    empty: 'No category rules yet. Tick “Remember” when you file a card and one lands here.',
  },
  subcategory: {
    id: 'subcategory',
    label: 'Detail',
    empty: 'No detail rules yet. They come from the detail question after you pick a category.',
  },
};

export function RulesTab({ askSub, onAskSubChange }) {
  const { categoryRules, subcategoryRules, transactions, customCategories, hiddenCategories, categoryColors } = useData();
  const {
    updateCategoryRule, removeCategoryRule, addCategoryRule,
    updateSubcategoryRule, removeSubcategoryRule, addSubcategoryRule,
    addCustomCategory,
  } = useDataActions();

  const [kind, setKind] = useState('category');
  const [editing, setEditing] = useState(null); // { index, description, target, isNew }
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');

  const isCat = kind === 'category';
  const rules = useMemo(
    () => (isCat ? (categoryRules || []) : (subcategoryRules || [])),
    [isCat, categoryRules, subcategoryRules],
  );

  // Match counts for every rule in one pass over the transactions, rather
  // than one pass per rule — with a few hundred rules that difference is the
  // screen opening instantly or visibly hanging.
  const counts = useMemo(() => {
    const out = new Array(rules.length).fill(0);
    for (const t of transactions || []) {
      for (let i = 0; i < rules.length; i++) {
        if (ruleMatches(rules[i], t)) out[i] += 1;
      }
    }
    return out;
  }, [rules, transactions]);

  const usage = useMemo(() => {
    const c = {};
    for (const t of transactions || []) {
      if (t.category && t.category !== 'Uncategorized') c[t.category] = (c[t.category] || 0) + 1;
    }
    return c;
  }, [transactions]);

  const categoryOptions = useMemo(() => {
    const set = new Set([...ALL_CATEGORIES, ...(customCategories || []), ...Object.keys(usage)]);
    for (const h of hiddenCategories || []) set.delete(h);
    return [...set];
  }, [customCategories, hiddenCategories, usage]);

  const allSubcategories = useMemo(() => {
    const set = new Set();
    for (const list of Object.values(SUBCATEGORIES)) for (const sub of list) set.add(sub);
    for (const t of transactions || []) if (t.subcategory) set.add(t.subcategory);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [transactions]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = rules.map((r, index) => ({ rule: r, index, count: counts[index] || 0 }));
    if (!q) return rows;
    return rows.filter(({ rule }) =>
      (rule.description || '').toLowerCase().includes(q)
      || String(rule.category || rule.subcategory || '').toLowerCase().includes(q));
  }, [rules, counts, query]);

  const targetOf = (rule) => (isCat ? rule.category : rule.subcategory);

  const save = useCallback(() => {
    if (!editing) return;
    const desc = editing.description.trim();
    const target = editing.target;
    if (!desc || !target) return;
    if (isCat) {
      if (!categoryOptions.includes(target)) addCustomCategory(target);
      if (editing.isNew) addCategoryRule(desc, null, target);
      else updateCategoryRule(editing.index, desc, target);
    } else if (editing.isNew) {
      addSubcategoryRule(desc, target);
    } else {
      updateSubcategoryRule(editing.index, desc, target);
    }
    setEditing(null);
  }, [editing, isCat, categoryOptions, addCustomCategory, addCategoryRule,
      updateCategoryRule, addSubcategoryRule, updateSubcategoryRule]);

  const remove = useCallback((index) => {
    if (isCat) removeCategoryRule(index);
    else removeSubcategoryRule(index);
    setEditing(null);
  }, [isCat, removeCategoryRule, removeSubcategoryRule]);

  const colorFor = (name) => (categoryColors && categoryColors[name]) || catColor(name);

  // Live count for the rule being edited, so a too-broad filter shows itself
  // before it is saved rather than after.
  const editingDesc = editing ? editing.description : '';
  const editingReach = useMemo(() => {
    const probe = editingDesc.trim();
    if (!probe) return null;
    const ruleLike = { description: probe, sign: null, minAmount: null, maxAmount: null };
    let n = 0;
    for (const t of transactions || []) if (ruleMatches(ruleLike, t)) n += 1;
    return n;
  }, [editingDesc, transactions]);

  return (
    <>
      <div className={styles.segmented}>
        {Object.values(KINDS).map(k => (
          <button
            key={k.id}
            className={`${styles.segment} ${kind === k.id ? styles.segmentOn : ''}`}
            onClick={() => { setKind(k.id); setQuery(''); }}
          >
            {k.label} rules
            <span className={styles.segmentCount}>
              {(k.id === 'category' ? categoryRules : subcategoryRules)?.length || 0}
            </span>
          </button>
        ))}
      </div>

      <label className={styles.rememberRow} style={{ marginTop: 'var(--space-3)' }}>
        <input type="checkbox" checked={askSub} onChange={(e) => onAskSubChange(e.target.checked)} />
        <span>Ask for a <strong>detail</strong> after each category</span>
      </label>

      {rules.length > 6 && (
        <div className={styles.search}>
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>search</span>
          <input
            className={styles.searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search rules"
            autoComplete="off"
          />
        </div>
      )}

      <button
        className={`${styles.actionBtn} ${styles.actionPrimary}`}
        style={{ margin: '0 var(--space-4) var(--space-2)', width: 'calc(100% - 2 * var(--space-4))' }}
        onClick={() => setEditing({ index: -1, description: '', target: '', isNew: true })}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 19 }}>add</span>
        New {KINDS[kind].label.toLowerCase()} rule
      </button>

      {shown.length === 0 ? (
        <div className={styles.empty}>
          <span className={`material-symbols-outlined ${styles.emptyIcon}`} style={{ color: 'var(--color-text-muted)' }}>
            rule
          </span>
          <div className={styles.emptyText}>{query ? `No rule matches “${query}”.` : KINDS[kind].empty}</div>
        </div>
      ) : (
        <div className={styles.list}>
          {shown.map(({ rule, index, count }) => {
            const target = targetOf(rule);
            return (
              <button
                key={`${index}-${rule.description}`}
                className={styles.listRow}
                onClick={() => setEditing({ index, description: rule.description || '', target: target || '', isNew: false })}
              >
                <span
                  className={styles.suggestIcon}
                  style={{ background: catBg(target || 'Uncategorized', 0.12), color: colorFor(target || 'Uncategorized') }}
                >
                  <span className="material-symbols-outlined">
                    {isCat ? getCategoryIcon(target) : 'label'}
                  </span>
                </span>
                <span className={styles.listMain}>
                  <span className={styles.listDesc}>“{rule.description}”</span>
                  <span className={styles.listMeta}>
                    → {target}
                    {' · '}
                    {count === 0
                      ? 'matches nothing right now'
                      : `${count} transaction${count === 1 ? '' : 's'}`}
                  </span>
                </span>
                <span className="material-symbols-outlined" style={{ color: 'var(--color-text-muted)' }}>
                  chevron_right
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Editor ─────────────────────────────────────── */}
      {editing && (
        <>
          <div className={styles.sheetBackdrop} onClick={() => setEditing(null)} />
          <div className={styles.sheet} role="dialog" aria-modal="true">
            <div className={styles.sheetGrip} />
            <div className={styles.sheetHead}>
              <div className={styles.sheetTitle}>
                {editing.isNew ? `New ${KINDS[kind].label.toLowerCase()} rule` : 'Edit rule'}
              </div>
              <button className={styles.iconBtn} onClick={() => setEditing(null)} aria-label="Close">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
              <div className={styles.fieldLabel}>When the description contains</div>
              <input
                className={styles.textField}
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                placeholder="e.g. blue bottle"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
              {editingReach != null && (
                <div className={styles.fieldHint}>
                  {editingReach === 0
                    ? 'Matches nothing in your history — check the spelling.'
                    : `Matches ${editingReach} transaction${editingReach === 1 ? '' : 's'} you already have.`}
                </div>
              )}

              <div className={styles.fieldLabel} style={{ marginTop: 'var(--space-4)' }}>
                File it as
              </div>
              <button className={styles.textField} style={{ textAlign: 'left' }} onClick={() => setPicker(true)}>
                {editing.target || <span style={{ color: 'var(--color-text-tertiary)' }}>Choose…</span>}
              </button>

              <div className={styles.actions} style={{ padding: 'var(--space-4) 0 0' }}>
                {!editing.isNew && (
                  <button
                    className={styles.actionBtn}
                    style={{ color: 'var(--color-error)', borderColor: 'rgba(186,26,26,0.3)' }}
                    onClick={() => remove(editing.index)}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 19 }}>delete</span>
                    Delete
                  </button>
                )}
                <button
                  className={`${styles.actionBtn} ${styles.actionPrimary}`}
                  onClick={save}
                  disabled={!editing.description.trim() || !editing.target}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {picker && isCat && (
        <CategorySheet
          title="File it as"
          categories={categoryOptions}
          usage={usage}
          active={editing?.target}
          onPick={(cat) => { setEditing(e => ({ ...e, target: cat })); setPicker(false); }}
          onCreate={(cat) => { setEditing(e => ({ ...e, target: cat })); setPicker(false); }}
          onClose={() => setPicker(false)}
        />
      )}

      {picker && !isCat && (
        <SubcategorySheet
          category="Detail"
          extra={allSubcategories}
          active={editing?.target}
          onPick={(sub) => { setEditing(e => ({ ...e, target: sub })); setPicker(false); }}
          onClose={() => setPicker(false)}
        />
      )}
    </>
  );
}
