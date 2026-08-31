import { useState, useMemo, useDeferredValue } from 'react';
import { useData } from '../contexts/DataContext';
import { getCategoryIcon, catColor, catBg } from '../lib/categories';
import { summarizeSearch } from '../lib/searchSummary';
import { fmt, fmtCompact, fmtRelative, parseDate } from './format';
import styles from './MobileApp.module.css';

/* Search everything, then see the shape of it.

   The Filed tab searches what you have categorized recently; this searches the
   whole ledger and answers the question that usually follows — "so how much is
   that?" — by rolling the matches up into a chart. Grouping by merchant is the
   half the desktop app makes you build a pivot for: "what do I actually spend
   at Whole Foods" is one search and one toggle here. */

const RANGES = [
  { id: '30d', label: '30d', days: 30, sub: 'Last 30 days' },
  { id: '3m', label: '3 mo', days: 91, sub: 'Last 3 months' },
  { id: '12m', label: '12 mo', days: 365, sub: 'Last 12 months' },
  { id: 'all', label: 'All', days: null, sub: 'All time' },
];

const MAX_ROWS = 60;   // transactions listed under an opened group
const MAX_BARS = 40;   // groups charted before "show the rest" appears

export function SearchTab() {
  const { transactions, categoryColors } = useData();
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState('category'); // 'category' | 'merchant'
  const [rangeId, setRangeId] = useState('12m');
  const [openGroup, setOpenGroup] = useState(null);
  const [showAllBars, setShowAllBars] = useState(false);
  const [includeNonSpend, setIncludeNonSpend] = useState(false);

  // Typing re-groups thousands of rows; let the field stay responsive and let
  // the chart catch up a frame later.
  const deferredQuery = useDeferredValue(query);
  // Pinned at mount so "last 30 days" means one fixed window for as long as the
  // screen is open — a boundary that slid between renders would quietly change
  // the totals underneath you.
  const [now] = useState(() => Date.now());

  const range = RANGES.find(r => r.id === rangeId) || RANGES[2];

  const view = useMemo(() => summarizeSearch({
    transactions,
    query: deferredQuery,
    days: range.days,
    groupBy,
    includeNonSpend,
    now,
  }), [transactions, deferredQuery, range, groupBy, includeNonSpend, now]);

  const colorFor = (name) => (categoryColors && categoryColors[name]) || catColor(name);
  const shownBars = showAllBars ? view.bars : view.bars.slice(0, MAX_BARS);

  return (
    <>
      <div className={styles.search} style={{ marginTop: 'var(--space-4)' }}>
        <span className="material-symbols-outlined" style={{ fontSize: 20 }}>search</span>
        <input
          className={styles.searchInput}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpenGroup(null); setShowAllBars(false); }}
          placeholder="Search every transaction"
          autoComplete="off"
        />
        {query && (
          <button
            className={styles.iconBtn}
            style={{ width: 28, height: 28 }}
            onClick={() => { setQuery(''); setOpenGroup(null); setShowAllBars(false); }}
            aria-label="Clear"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>cancel</span>
          </button>
        )}
      </div>

      <div className={styles.segmented} style={{ marginTop: 0 }}>
        {RANGES.map(r => (
          <button
            key={r.id}
            className={`${styles.segment} ${rangeId === r.id ? styles.segmentOn : ''}`}
            onClick={() => { setRangeId(r.id); setOpenGroup(null); setShowAllBars(false); }}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className={styles.segmented}>
        {[
          { id: 'category', label: 'By category', icon: 'donut_small' },
          { id: 'merchant', label: 'By name', icon: 'storefront' },
        ].map(g => (
          <button
            key={g.id}
            className={`${styles.segment} ${groupBy === g.id ? styles.segmentOn : ''}`}
            onClick={() => { setGroupBy(g.id); setOpenGroup(null); setShowAllBars(false); }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>{g.icon}</span>
            {g.label}
          </button>
        ))}
      </div>

      <div className={styles.statGrid}>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Spent</div>
          <div className={styles.statValue}>{fmtCompact(view.spend)}</div>
          <div className={styles.statSub}>
            {view.matches.length} transaction{view.matches.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Came in</div>
          <div className={styles.statValue} style={{ color: 'var(--color-success)' }}>
            {fmtCompact(view.income)}
          </div>
          <div className={styles.statSub}>{range.sub}</div>
        </div>
      </div>

      {(view.hiddenSpend > 0 || includeNonSpend) && (
        <button
          className={styles.install}
          style={{ width: 'calc(100% - 2 * var(--space-4))', textAlign: 'left', border: 'none', cursor: 'pointer' }}
          onClick={() => { setIncludeNonSpend(v => !v); setOpenGroup(null); }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 19 }}>swap_horiz</span>
          <span>
            {includeNonSpend
              ? 'Transfers, income and investments are included'
              : `${fmtCompact(view.hiddenSpend)} of transfers, income and investments hidden`}
          </span>
          <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{includeNonSpend ? 'Hide' : 'Show'}</span>
        </button>
      )}

      <div className={styles.sectionLabel}>
        {groupBy === 'merchant' ? 'By name' : 'By category'}
        {view.bars.length > 0 && ` · ${view.bars.length} ${groupBy === 'merchant' ? 'merchants' : 'categories'}`}
      </div>

      {view.bars.length === 0 ? (
        <div className={styles.empty} style={{ padding: '40px var(--space-6)' }}>
          <span className={`material-symbols-outlined ${styles.emptyIcon}`} style={{ color: 'var(--color-text-muted)' }}>
            search_off
          </span>
          <div className={styles.emptyText}>
            {view.matches.length === 0
              ? 'No transaction matches that.'
              : 'Those matches net out to no spending — try a wider range.'}
          </div>
        </div>
      ) : (
        <div className={styles.list}>
          {shownBars.map((bar) => {
            const open = openGroup === bar.key;
            return (
              <div key={bar.key}>
                <button
                  className={styles.barBtn}
                  onClick={() => setOpenGroup(open ? null : bar.key)}
                  aria-expanded={open}
                >
                  <div className={styles.barTop}>
                    <span className={styles.barName}>
                      <span
                        className="material-symbols-outlined"
                        style={{ fontSize: 15, verticalAlign: '-3px', marginRight: 6, color: colorFor(bar.category) }}
                      >
                        {getCategoryIcon(bar.category)}
                      </span>
                      {bar.label}
                    </span>
                    <span className={styles.barValue}>{fmtCompact(bar.amount)}</span>
                  </div>
                  <div className={styles.barTrack}>
                    <div
                      className={styles.barFill}
                      style={{
                        width: `${view.max ? Math.max(2, (bar.amount / view.max) * 100) : 0}%`,
                        background: bar.category === 'Uncategorized' ? 'var(--color-text-muted)' : colorFor(bar.category),
                      }}
                    />
                  </div>
                  <div className={styles.barMeta}>
                    {bar.count} transaction{bar.count === 1 ? '' : 's'}
                    {bar.count > 1 ? ` · ${fmtCompact(bar.amount / bar.count)} avg` : ''}
                    <span className="material-symbols-outlined" style={{ fontSize: 16, marginLeft: 'auto' }}>
                      {open ? 'expand_less' : 'expand_more'}
                    </span>
                  </div>
                </button>

                {open && (
                  <div className={styles.drill}>
                    {bar.items
                      .slice()
                      .sort((a, b) => (parseDate(b.date) || 0) - (parseDate(a.date) || 0))
                      .slice(0, MAX_ROWS)
                      .map((t, i) => (
                        <div
                          key={t.transactionId || `${t.date}|${t.description}|${t.amount}|${i}`}
                          className={styles.drillRow}
                        >
                          <span
                            className={styles.suggestIcon}
                            style={{ background: catBg(t.category, 0.12), color: colorFor(t.category), width: 28, height: 28 }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
                              {getCategoryIcon(t.category)}
                            </span>
                          </span>
                          <span className={styles.listMain}>
                            <span className={styles.listDesc}>{t.description}</span>
                            <span className={styles.listMeta}>
                              {groupBy === 'merchant' ? (t.category || 'Uncategorized') : (t.account || '')}
                              {' · '}{fmtRelative(t.date)}
                            </span>
                          </span>
                          <span
                            className={styles.listAmount}
                            style={{ color: t.amount > 0 ? 'var(--color-success)' : 'var(--color-text-primary)' }}
                          >
                            {t.amount > 0 ? '+' : ''}{fmt(t.amount)}
                          </span>
                        </div>
                      ))}
                    {bar.items.length > MAX_ROWS && (
                      <div className={styles.drillMore}>
                        + {bar.items.length - MAX_ROWS} more
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {view.bars.length > shownBars.length && (
            <button className={styles.skipBtn} onClick={() => setShowAllBars(true)}>
              Show {view.bars.length - shownBars.length} more
            </button>
          )}
        </div>
      )}
    </>
  );
}
