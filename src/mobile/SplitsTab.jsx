import { useMemo, useState, useCallback } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { getCategoryIcon, catColor, catBg } from '../lib/categories';
import { fmt, fmtCompact, fmtRelative } from './format';
import styles from './MobileApp.module.css';

/* Both halves of splitting: what Splitwise says you are owed, and the charges
   still on their way out to Rally.

   The splitting itself happens in Rally — this screen is the outbox. Its real
   job is the unhappy path: a tag written while the phone had no signal is kept
   locally and shows up here as unsent, with a retry, instead of being silently
   lost between the two apps. */
/* Who is up on whom, per Splitwise. Read-only here — settling up happens in
   Splitwise itself; this is the number you want in your pocket. */
function SplitwiseSummary() {
  const { splitwise } = useData();
  const [open, setOpen] = useState(false);
  if (splitwise.loading && !splitwise.connected) return null;

  if (!splitwise.connected || splitwise.error) {
    // Silent when it was never set up — an unconfigured integration is not a
    // problem to report on a phone. Loud only when a working one broke.
    if (!splitwise.connected && !splitwise.error) return null;
    return (
      <div className={styles.install} style={{ background: 'rgba(232,163,23,0.1)', color: '#a36b00' }}>
        <span className="material-symbols-outlined" style={{ fontSize: 19 }}>link_off</span>
        {splitwise.error || 'Splitwise is not connected'}
      </div>
    );
  }

  const { balances } = splitwise;
  const { byPerson } = balances;
  const shown = open ? byPerson : byPerson.slice(0, 4);

  return (
    <>
      <div className={styles.statGrid}>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Owed to you</div>
          <div className={styles.statValue} style={{ color: 'var(--color-success)' }}>
            {fmtCompact(balances.owedToYou)}
          </div>
          <div className={styles.statSub}>Splitwise</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>You owe</div>
          <div className={styles.statValue} style={{ color: 'var(--color-error)' }}>
            {fmtCompact(balances.youOwe)}
          </div>
          <div className={styles.statSub}>Net {fmtCompact(balances.net)}</div>
        </div>
      </div>

      {byPerson.length > 0 && (
        <>
          <div className={styles.sectionLabel}>Who</div>
          <div className={styles.list}>
            {shown.map(p => {
              const owed = p.amount > 0;
              return (
                <div key={`${p.id}-${p.currency}`} className={styles.listRow} style={{ cursor: 'default' }}>
                  <span className={styles.listMain}>
                    <span className={styles.listDesc}>{p.name}</span>
                    <span className={styles.listMeta}>{owed ? 'owes you' : 'you owe'}</span>
                  </span>
                  <span
                    className={styles.listAmount}
                    style={{ color: owed ? 'var(--color-success)' : 'var(--color-error)' }}
                  >
                    {fmtCompact(Math.abs(p.amount))}
                  </span>
                </div>
              );
            })}
            {byPerson.length > 4 && (
              <button className={styles.skipBtn} onClick={() => setOpen(o => !o)}>
                {open ? 'Show fewer' : `Show ${byPerson.length - 4} more`}
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

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
      <>
        <SplitwiseSummary />
        <div className={styles.empty}>
          <span className={`material-symbols-outlined ${styles.emptyIcon}`} style={{ color: 'var(--color-text-muted)' }}>
            call_split
          </span>
          <div className={styles.emptyTitle}>Nothing queued for Rally</div>
          <div className={styles.emptyText}>
            Tap <strong>Split</strong> on a charge in Review and it shows up here, and in Rally
            under Trip Expenses.
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <SplitwiseSummary />

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
