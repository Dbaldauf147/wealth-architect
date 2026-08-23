import { useState, useMemo } from 'react';
import { useData } from '../contexts/DataContext';
import { getCategoryIcon, catColor, NON_SPEND_CATEGORIES } from '../lib/categories';
import { reviewStats } from '../lib/reviewQueue';
import { fmtCompact, monthKey, monthLabel } from './format';
import styles from './MobileApp.module.css';

/* The payoff screen.

   Categorizing is chore-shaped; this is what the chore buys — a month's
   spending broken out by category, and an honest note about how much of the
   month is still unaccounted for, so a tidy-looking chart can't quietly hide
   a pile of uncategorized charges. */
export function InsightsTab({ onGoReview }) {
  const { transactions, categoryColors } = useData();

  const months = useMemo(() => {
    const set = new Set();
    for (const t of transactions || []) {
      const k = monthKey(t.date);
      if (k) set.add(k);
    }
    return [...set].sort().reverse();
  }, [transactions]);

  const [offset, setOffset] = useState(0);
  const current = months[offset] || monthKey(new Date().toISOString().slice(0, 10));

  const view = useMemo(() => {
    const inMonth = (transactions || []).filter(t => monthKey(t.date) === current);
    const byCat = new Map();
    let spend = 0;
    let income = 0;
    let unreviewed = 0;

    for (const t of inMonth) {
      const cat = t.category && t.category !== 'Uncategorized' ? t.category : 'Uncategorized';
      if (cat === 'Uncategorized') unreviewed += Math.abs(t.amount);
      if (t.amount > 0) income += t.amount;
      // Income and internal transfers aren't spending; leaving them in would
      // make the biggest bar of the month a paycheck.
      if (NON_SPEND_CATEGORIES.has(cat)) continue;
      // Signed, so a refund shrinks its category's bar instead of growing it.
      byCat.set(cat, (byCat.get(cat) || 0) + -t.amount);
    }
    for (const net of byCat.values()) if (net > 0) spend += net;

    const bars = [...byCat.entries()]
      .filter(([, amount]) => amount > 0)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);
    const max = bars.length ? bars[0].amount : 0;

    return { count: inMonth.length, bars, max, spend, income, unreviewed, stats: reviewStats(inMonth) };
  }, [transactions, current]);

  const colorFor = (name) => (categoryColors && categoryColors[name]) || catColor(name);

  return (
    <>
      <div className={styles.monthSwitch}>
        <button
          className={styles.iconBtn}
          onClick={() => setOffset(o => Math.min(months.length - 1, o + 1))}
          disabled={offset >= months.length - 1}
          aria-label="Previous month"
        >
          <span className="material-symbols-outlined">chevron_left</span>
        </button>
        <div className={styles.monthName}>{monthLabel(current)}</div>
        <button
          className={styles.iconBtn}
          onClick={() => setOffset(o => Math.max(0, o - 1))}
          disabled={offset <= 0}
          aria-label="Next month"
        >
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      </div>

      <div className={styles.statGrid}>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Spent</div>
          <div className={styles.statValue}>{fmtCompact(view.spend)}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Came in</div>
          <div className={styles.statValue} style={{ color: 'var(--color-success)' }}>
            {fmtCompact(view.income)}
          </div>
        </div>
      </div>

      {view.stats.count > 0 && (
        <button
          className={styles.install}
          style={{ width: 'calc(100% - 2 * var(--space-4))', textAlign: 'left', border: 'none', cursor: 'pointer' }}
          onClick={onGoReview}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 19 }}>error</span>
          <span>
            {fmtCompact(view.unreviewed)} of this month is uncategorized
            {' '}({view.stats.count} transaction{view.stats.count === 1 ? '' : 's'})
          </span>
          <span className="material-symbols-outlined" style={{ fontSize: 18, marginLeft: 'auto' }}>chevron_right</span>
        </button>
      )}

      <div className={styles.sectionLabel}>Where it went</div>

      {view.bars.length === 0 ? (
        <div className={styles.empty} style={{ padding: '40px var(--space-6)' }}>
          <div className={styles.emptyText}>No spending recorded in {monthLabel(current)}.</div>
        </div>
      ) : (
        <div className={styles.list}>
          {view.bars.map(({ category, amount }) => (
            <div key={category} className={styles.barRow}>
              <div className={styles.barTop}>
                <span className={styles.barName}>
                  <span
                    className="material-symbols-outlined"
                    style={{ fontSize: 15, verticalAlign: '-3px', marginRight: 6, color: colorFor(category) }}
                  >
                    {getCategoryIcon(category)}
                  </span>
                  {category}
                </span>
                <span className={styles.barValue}>{fmtCompact(amount)}</span>
              </div>
              <div className={styles.barTrack}>
                <div
                  className={styles.barFill}
                  style={{
                    width: `${view.max ? Math.max(2, (amount / view.max) * 100) : 0}%`,
                    background: category === 'Uncategorized' ? 'var(--color-text-muted)' : colorFor(category),
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
