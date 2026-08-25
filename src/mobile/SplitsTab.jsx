import { useMemo, useState, useCallback } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { getCategoryIcon, catColor, catBg } from '../lib/categories';
import { fmt, fmtRelative } from './format';
import styles from './MobileApp.module.css';

/* Charges flagged as "someone owes me a share of this".

   The splitting itself happens in Rally — this screen is the outbox. Its real
   job is the unhappy path: a tag written while the phone had no signal is kept
   locally and shows up here as unsent, with a retry, instead of being silently
   lost between the two apps. */
export function SplitsTab() {
  const { transactions, splitTags, categoryColors } = useData();
  const { tagForSplit, untagSplit } = useDataActions();
  const [busyId, setBusyId] = useState(null);

  const rows = useMemo(() => {
    const tags = splitTags || {};
    const ids = new Set(Object.keys(tags));
    if (!ids.size) return [];
    const byId = new Map();
    for (const t of transactions || []) {
      if (t.transactionId && ids.has(t.transactionId)) byId.set(t.transactionId, t);
    }
    return [...ids].map(id => ({ id, tag: tags[id], txn: byId.get(id) || null }))
      .sort((a, b) => {
        // Anything still unsent floats to the top — that's the only part of
        // this screen that needs a decision.
        const aBad = a.tag?.error ? 0 : 1;
        const bBad = b.tag?.error ? 0 : 1;
        if (aBad !== bBad) return aBad - bBad;
        return String(b.tag?.taggedAt || '').localeCompare(String(a.tag?.taggedAt || ''));
      });
  }, [transactions, splitTags]);

  const unsent = rows.filter(r => r.tag?.error).length;

  const retry = useCallback(async (row) => {
    if (!row.txn) return;
    setBusyId(row.id);
    await tagForSplit(row.txn, { note: row.tag?.note || '' });
    setBusyId(null);
  }, [tagForSplit]);

  const colorFor = (name) => (categoryColors && categoryColors[name]) || catColor(name);

  if (!rows.length) {
    return (
      <div className={styles.empty}>
        <span className={`material-symbols-outlined ${styles.emptyIcon}`} style={{ color: 'var(--color-text-muted)' }}>
          call_split
        </span>
        <div className={styles.emptyTitle}>Nothing to split</div>
        <div className={styles.emptyText}>
          Tap <strong>Split</strong> on a charge in Review and it shows up here, and in Rally
          under Trip Expenses.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={styles.progress}>
        <div className={styles.progressTop}>
          <div className={styles.progressCount}>
            {rows.length} charge{rows.length === 1 ? '' : 's'} to split
          </div>
        </div>
        <div className={styles.progressAmount}>
          {unsent > 0
            ? `${unsent} not sent to Rally yet — tap to retry`
            : 'All sent. Set the shares in Rally under Trip Expenses.'}
        </div>
      </div>

      <div className={styles.list}>
        {rows.map((row) => {
          const { id, tag, txn } = row;
          const failed = !!tag?.error;
          const busy = busyId === id;
          return (
            <div key={id} className={styles.listRow} style={{ cursor: 'default' }}>
              <span
                className={styles.suggestIcon}
                style={{ background: catBg(txn?.category || 'Uncategorized', 0.12), color: colorFor(txn?.category || 'Uncategorized') }}
              >
                <span className="material-symbols-outlined">{getCategoryIcon(txn?.category)}</span>
              </span>
              <span className={styles.listMain}>
                <span className={styles.listDesc}>
                  {txn?.description || 'Transaction no longer in the sheet'}
                </span>
                <span className={styles.listMeta} style={failed ? { color: 'var(--color-warning)' } : undefined}>
                  {failed
                    ? tag.error
                    : tag?.pushedAt ? 'In Rally' : 'Sending…'}
                  {txn?.date ? ` · charged ${fmtRelative(txn.date).toLowerCase()}` : ''}
                </span>
              </span>
              {txn && (
                <span className={styles.listAmount}>{fmt(txn.amount)}</span>
              )}
              {failed && txn && (
                <button className={styles.iconBtn} onClick={() => retry(row)} disabled={busy} aria-label="Retry">
                  <span className={`material-symbols-outlined ${busy ? styles.spin : ''}`}>
                    {busy ? 'progress_activity' : 'refresh'}
                  </span>
                </button>
              )}
              <button className={styles.iconBtn} onClick={() => untagSplit(id)} aria-label="Remove tag">
                <span className="material-symbols-outlined" style={{ fontSize: 19 }}>close</span>
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
