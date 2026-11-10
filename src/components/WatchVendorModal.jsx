import { useMemo, useState } from 'react';
import { newWatchRule, watchRuleHasFilter, matchingWatchRules } from '../lib/watchedVendors';
import { ruleMatches } from '../lib/categorize';
import styles from './WatchVendorModal.module.css';

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
}

function fmtDate(d) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  const date = iso ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : new Date(d);
  return Number.isNaN(date.getTime()) ? String(d || '') : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const toItem = r => ({
  id: r.id,
  createdAt: r.createdAt,
  pattern: r.description || '',
  sign: r.sign || '',
  min: r.minAmount != null ? String(r.minAmount) : '',
  max: r.maxAmount != null ? String(r.maxAmount) : '',
  note: r.note || '',
});

const toRule = it => newWatchRule({
  id: it.id,
  createdAt: it.createdAt,
  description: it.pattern,
  sign: it.sign,
  minAmount: it.min,
  maxAmount: it.max,
  note: it.note,
});

/**
 * Flag a vendor to watch, from a transaction.
 *
 * Shows the transaction, every watch rule it already trips (editable), and —
 * when it trips none — a new rule prefilled from its merchant name. The filters
 * are the auto-categorization ones (pattern contains, sign, min/max |amount|),
 * matched by the same ruleMatches, so the live counts here are what the
 * Flagged tab will show.
 */
export default function WatchVendorModal({ txn, rules, transactions, onSave, onClose }) {
  const existing = useMemo(() => matchingWatchRules(txn, rules), [txn, rules]);
  const [items, setItems] = useState(() => (
    existing.length
      ? existing.map(toItem)
      : [{ id: null, pattern: txn.description || '', sign: '', min: '', max: '', note: '' }]
  ));

  const update = (i, patch) => setItems(prev => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const remove = i => setItems(prev => prev.filter((_, idx) => idx !== i));
  const add = () => setItems(prev => [...prev, { id: null, pattern: txn.description || '', sign: '', min: '', max: '', note: '' }]);

  const counts = useMemo(() => items.map(it => {
    const r = toRule(it);
    if (!watchRuleHasFilter(r)) return { total: 0, includesThis: false };
    let total = 0;
    for (const t of transactions || []) if (ruleMatches(r, t)) total += 1;
    return { total, includesThis: ruleMatches(r, txn) };
  }), [items, transactions, txn]);

  const valid = items.every(it => watchRuleHasFilter(toRule(it)));
  const changed = existing.length > 0 || items.length > 0;

  function save() {
    if (!valid) return;
    const keptIds = new Set(items.map(it => it.id).filter(Boolean));
    const removedIds = new Set(existing.map(r => r.id).filter(id => !keptIds.has(id)));
    const edited = new Map(items.filter(it => it.id).map(it => [it.id, toRule(it)]));
    const next = (rules || [])
      .filter(r => !removedIds.has(r.id))
      .map(r => edited.get(r.id) || r);
    for (const it of items) if (!it.id) next.push(toRule(it));
    onSave(next);
  }

  const amt = Number(txn.amount);

  return (
    <div className={styles.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="watch-vendor-title">
        <div className={styles.head}>
          <span className={`material-symbols-outlined ${styles.headIcon}`}>flag</span>
          <div style={{ minWidth: 0 }}>
            <div id="watch-vendor-title" className={styles.title}>
              {existing.length ? 'Watched vendor' : 'Flag vendor to watch'}
            </div>
            <div className={styles.sub}>
              Transactions matching these filters are flagged and listed under the Flagged tab.
            </div>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className={styles.txn}>
          <div className={styles.txnMain}>
            <div className={styles.txnName}>{txn.description}</div>
            {txn.fullDescription && txn.fullDescription !== txn.description && (
              <div className={styles.txnFull}>{txn.fullDescription}</div>
            )}
            <div className={styles.txnMeta}>
              {fmtDate(txn.date)}
              {txn.account ? ` · ${txn.account}` : ''}
              {txn.category ? ` · ${txn.category}` : ''}
            </div>
          </div>
          <div className={styles.txnAmt} style={{ color: amt > 0 ? '#15803d' : undefined }}>{fmtMoney(amt)}</div>
        </div>

        {items.length === 0 && (
          <div className={styles.empty}>No watch rules — saving will unflag this vendor.</div>
        )}

        {items.map((it, i) => {
          const c = counts[i];
          const hasFilter = watchRuleHasFilter(toRule(it));
          return (
            <div key={it.id || `new-${i}`} className={styles.rule}>
              <div className={styles.ruleHead}>
                <span>{it.id ? `Watch rule ${i + 1}` : 'New watch rule'}</span>
                <button type="button" className={styles.removeBtn} onClick={() => remove(i)} title={it.id ? 'Stop watching (remove this rule)' : 'Discard'}>
                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>delete</span>
                  {it.id ? 'Unflag' : 'Discard'}
                </button>
              </div>
              <label className={styles.field}>
                <span>Pattern (contains)</span>
                <input type="text" value={it.pattern} onChange={e => update(i, { pattern: e.target.value })} autoFocus={i === 0} />
              </label>
              <div className={styles.row3}>
                <label className={styles.field}>
                  <span>Sign</span>
                  <select value={it.sign} onChange={e => update(i, { sign: e.target.value })}>
                    <option value="">Any</option>
                    <option value="positive">Positive (+)</option>
                    <option value="negative">Negative (−)</option>
                  </select>
                </label>
                <label className={styles.field}>
                  <span>Min |amt|</span>
                  <input type="number" placeholder="—" value={it.min} onChange={e => update(i, { min: e.target.value })} />
                </label>
                <label className={styles.field}>
                  <span>Max |amt|</span>
                  <input type="number" placeholder="—" value={it.max} onChange={e => update(i, { max: e.target.value })} />
                </label>
              </div>
              <label className={styles.field}>
                <span>Note (optional)</span>
                <input type="text" placeholder="Why are you watching this?" value={it.note} onChange={e => update(i, { note: e.target.value })} />
              </label>
              <div className={styles.count} data-testid="watch-match-count">
                {hasFilter ? (
                  <>
                    <strong>{c.total}</strong> transaction{c.total === 1 ? '' : 's'} match
                    {!c.includesThis && <span className={styles.warn}> · doesn&apos;t include this one</span>}
                  </>
                ) : <span className={styles.warn}>Add at least one filter</span>}
              </div>
            </div>
          );
        })}

        <button type="button" className={styles.addBtn} onClick={add}>
          <span className="material-symbols-outlined" style={{ fontSize: 15 }}>add</span>
          Add another filter
        </button>

        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onClose}>Cancel</button>
          <button type="button" className={styles.primary} onClick={save} disabled={!valid || !changed}>
            {existing.length ? 'Save' : 'Flag vendor'}
          </button>
        </div>
      </div>
    </div>
  );
}
