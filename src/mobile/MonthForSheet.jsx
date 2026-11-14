import { useMemo, useState } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { pendingMonthChoices, monthOptions, dateForMonth, monthForKey, parseTxnDate } from '../lib/monthFor';
import { fmt, monthLabel } from './format';
import styles from './MobileApp.module.css';

/* "Which month is this for?" — asked of every rent payment and every piece of
   income, however it came to be filed (the review deck, the Filed tab, a rule,
   or the sheet's own category).

   There is deliberately no close button and the backdrop does nothing: the
   sheet stays until a month is picked. One tap answers it, and picking the
   month it posted in changes nothing, so it can always be cleared. */
export function MonthForSheet() {
  const { transactions, incomeCategories, loading } = useData();
  const { updateTransactionDate } = useDataActions();
  const [other, setOther] = useState('');

  const pending = useMemo(
    () => (loading ? [] : pendingMonthChoices(transactions, incomeCategories)),
    [transactions, incomeCategories, loading],
  );
  const item = pending[0];
  if (!item) return null;

  const { txn, kind } = item;
  const amount = Number(txn.amount) || 0;
  const paid = amount < 0;
  const options = monthOptions(txn);
  const choose = (key) => {
    const fallback = monthForKey(txn);
    updateTransactionDate(txn.transactionId, dateForMonth(txn, key), fallback);
    setOther('');
  };
  const posted = parseTxnDate(txn.date)?.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const title = kind === 'rent' ? 'Which month is this rent for?' : 'Which month is this income for?';

  return (
    <>
      <div className={styles.sheetBackdrop} style={{ zIndex: 60 }} />
      <div className={styles.sheet} style={{ zIndex: 61 }} role="dialog" aria-modal="true" aria-label={title} data-testid="month-for-sheet">
        <div className={styles.sheetGrip} />
        <div className={styles.sheetHead}>
          <div className={styles.sheetTitle}>{title}</div>
          {pending.length > 1 && <span className={styles.catCount} data-testid="month-for-count">1 of {pending.length}</span>}
        </div>
        <div className={styles.monthForTxn}>
          <div className={styles.monthForDesc}>{txn.description || 'Unnamed transaction'}</div>
          <div className={styles.monthForMeta}>
            <span className={paid ? styles.amountOut : styles.amountIn}>{paid ? '' : '+'}{fmt(amount)}</span>
            {' · '}{paid ? 'paid' : 'received'} {posted}
            {txn.category ? ` · ${txn.category}` : ''}
          </div>
        </div>
        <div className={styles.sheetList}>
          {options.map(o => (
            <button key={o.key} className={`${styles.catRow} ${o.counted ? styles.catRowActive : ''}`} onClick={() => choose(o.key)} data-month={o.key}>
              <span className={styles.suggestIcon} style={{ background: 'rgba(0,88,190,0.1)', color: 'var(--color-secondary)' }}>
                <span className="material-symbols-outlined">calendar_month</span>
              </span>
              {monthLabel(o.key)}
              <span className={styles.catCount}>
                {o.own ? (paid ? 'when it was paid' : 'when it arrived') : ''}
                {o.counted && !o.own ? 'where it counts now' : ''}
              </span>
            </button>
          ))}
          <div className={styles.monthForOther}>
            <label htmlFor="month-for-other">Another month</label>
            <input id="month-for-other" type="month" value={other} onChange={e => setOther(e.target.value)} />
            <button className={styles.installBtn} disabled={!/^\d{4}-\d{2}$/.test(other)} onClick={() => choose(other)}>Use</button>
          </div>
          <div className={styles.monthForNote}>
            Charts and reports count it in the month you pick. It has to be answered to carry on.
          </div>
        </div>
      </div>
    </>
  );
}
