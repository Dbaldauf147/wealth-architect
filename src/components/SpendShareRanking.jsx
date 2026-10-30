import { useMemo, useState } from 'react';
import { rankSpendShare, isRentCategory, addMonths } from '../lib/spendShare';
import { historyMonths, periodLabel } from '../lib/categoryDrilldown';
import styles from './SpendShareRanking.module.css';

/* Spending Trends › Share of spending: categories ranked by their share of
   everything spent over a period you pick, against the same-length period
   before it. Rent is left out until you show it; any other category can be
   hidden the same way. Clicking a category opens its drill-down. */

const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const pct = n => `${(Math.round((n || 0) * 1000) / 10).toFixed(1)}%`;
const pts = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${(Math.abs(Math.round(n * 1000) / 10)).toFixed(1)} pts`;

// The period and the hidden list are view preferences, kept in this browser.
const PREF_KEY = 'wa-trends-share';
function loadPref() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
    return p && typeof p === 'object' ? p : {};
  } catch { return {}; }
}
function savePref(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

const MONTH_RE = /^\d{4}-\d{2}$/;

export function SpendShareRanking({ transactions, onOpenCategory }) {
  const history = useMemo(() => historyMonths(transactions), [transactions]);
  const first = history[0];
  const current = history[history.length - 1];
  const lastComplete = history.length > 1 ? history[history.length - 2] : current;

  const presets = useMemo(() => {
    const y = Number(current.slice(0, 4));
    const clamp = k => (k < first ? first : k);
    return [
      { id: '3m', label: 'Last 3 months', from: clamp(addMonths(lastComplete, -2)), to: lastComplete },
      { id: '6m', label: '6 months', from: clamp(addMonths(lastComplete, -5)), to: lastComplete },
      { id: '12m', label: '12 months', from: clamp(addMonths(lastComplete, -11)), to: lastComplete },
      { id: 'ytd', label: 'This year', from: clamp(`${y}-01`), to: current },
      { id: 'ly', label: String(y - 1), from: clamp(`${y - 1}-01`), to: `${y - 1}-12` < first ? first : `${y - 1}-12` },
      { id: 'all', label: 'All', from: first, to: current },
    ];
  }, [first, current, lastComplete]);

  const [pref, setPref] = useState(loadPref);
  const update = next => setPref(prev => { const p = { ...prev, ...next }; savePref(p); return p; });

  const preset = presets.find(p => p.id === (pref.preset || '12m'));
  const from = pref.preset === 'custom' && MONTH_RE.test(pref.from || '') ? pref.from : (preset || presets[2]).from;
  const to = pref.preset === 'custom' && MONTH_RE.test(pref.to || '') ? pref.to : (preset || presets[2]).to;
  const [lo, hi] = from <= to ? [from, to] : [to, from];

  // Rent stays hidden until you show it: the default list is every rent-like
  // category in the ledger; after any change the saved list is used as is.
  const allCats = useMemo(() => {
    const s = new Set();
    for (const t of transactions || []) if (Number(t.amount) < 0) s.add(t.category || 'Uncategorized');
    return [...s];
  }, [transactions]);
  const hidden = useMemo(
    () => new Set(Array.isArray(pref.hidden) ? pref.hidden : allCats.filter(isRentCategory)),
    [pref.hidden, allCats],
  );
  const toggleHidden = cat => {
    const next = new Set(hidden);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    update({ hidden: [...next] });
  };

  const r = useMemo(() => rankSpendShare({ transactions, from: lo, to: hi, hidden }), [transactions, lo, hi, hidden]);
  const maxShare = r.rows[0]?.share || 1;
  const prevStart = r.prev.from < first ? first : r.prev.from;
  const hasPrev = r.prev.total > 0;

  return (
    <div className={styles.wrap} data-testid="spend-share">
      <div className={styles.card}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Share of spending</div>
            <div className={styles.sub}>
              {periodLabel(lo)} – {periodLabel(hi)} · {r.months} month{r.months === 1 ? '' : 's'}
              {' · '}<b>{money(r.total)}</b> spent{r.months ? `, ${money(r.total / r.months)}/mo` : ''}
              {hidden.size > 0 && r.hiddenTotal > 0 && <> · not counting {money(r.hiddenTotal)} hidden</>}
              <br />
              {hasPrev
                ? <>Compared with the {r.months} month{r.months === 1 ? '' : 's'} before: {periodLabel(prevStart)} – {periodLabel(r.prev.to)}, {money(r.prev.total)}.</>
                : <>No spending in the {r.months} month{r.months === 1 ? '' : 's'} before to compare with.</>}
            </div>
          </div>
        </div>

        <div className={styles.controls}>
          <div className={styles.pillGroup} role="group" aria-label="Period">
            {presets.map(p => (
              <button
                key={p.id}
                type="button"
                className={`${styles.pill} ${(pref.preset || '12m') === p.id ? styles.pillActive : ''}`}
                onClick={() => update({ preset: p.id })}
                title={`${periodLabel(p.from)} – ${periodLabel(p.to)}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className={`${styles.range} ${pref.preset === 'custom' ? styles.rangeActive : ''}`}>
            <label>
              From
              <input
                type="month"
                value={from}
                min={first}
                max={current}
                onChange={e => MONTH_RE.test(e.target.value) && update({ preset: 'custom', from: e.target.value, to })}
                aria-label="Period starts"
              />
            </label>
            <label>
              to
              <input
                type="month"
                value={to}
                min={first}
                max={current}
                onChange={e => MONTH_RE.test(e.target.value) && update({ preset: 'custom', from, to: e.target.value })}
                aria-label="Period ends"
              />
            </label>
          </div>
        </div>

        {hidden.size > 0 && (
          <div className={styles.hiddenBar} data-testid="spend-share-hidden">
            <span className={styles.muted}>Hidden:</span>
            {[...hidden].sort().map(cat => {
              const amt = r.hiddenCats.find(h => h.cat === cat)?.amount || 0;
              return (
                <button key={cat} type="button" className={styles.hiddenChip} onClick={() => toggleHidden(cat)} title={`Show ${cat} and count it in the total`}>
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>visibility</span>
                  {cat}{amt ? ` · ${money(amt)}` : ''}
                </button>
              );
            })}
          </div>
        )}

        {r.rows.length === 0 ? (
          <div className={styles.empty}>No spending in this period.</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.rank}>#</th>
                  <th>Category</th>
                  <th>Share of spending</th>
                  <th className={styles.num}>Cumulative</th>
                  <th className={styles.num}>Total</th>
                  <th className={styles.num}>Per month</th>
                  <th className={styles.num}>Share before</th>
                  <th className={styles.num}>Change</th>
                  <th aria-label="Hide" />
                </tr>
              </thead>
              <tbody>
                {r.rows.map(row => {
                  const delta = row.prevShare == null ? null : row.share - row.prevShare;
                  return (
                    <tr key={row.cat}>
                      <td className={styles.rank}>{row.rank}</td>
                      <td>
                        <button type="button" className={styles.catLink} onClick={() => onOpenCategory(row.cat)} title={`${row.cat}: month by month and the places behind it`}>
                          {row.cat}
                        </button>
                        <div className={styles.muted}>{row.count} charge{row.count === 1 ? '' : 's'}</div>
                      </td>
                      <td className={styles.shareCell}>
                        <div className={styles.shareBar}><div style={{ width: `${Math.max(1, (row.share / maxShare) * 100)}%` }} /></div>
                        <span className={styles.sharePct}>{pct(row.share)}</span>
                      </td>
                      <td className={`${styles.num} ${styles.muted}`}>{pct(row.cumShare)}</td>
                      <td className={styles.num}>{money(row.amount)}</td>
                      <td className={styles.num}>{money(row.perMonth)}</td>
                      <td className={`${styles.num} ${styles.muted}`}>{row.prevShare == null ? '—' : pct(row.prevShare)}</td>
                      <td className={`${styles.num} ${delta == null ? styles.muted : delta > 0.0005 ? styles.up : delta < -0.0005 ? styles.down : styles.muted}`}>
                        {delta == null ? '—' : row.prevAmount === 0 ? 'new' : pts(delta)}
                      </td>
                      <td>
                        <button type="button" className={styles.hideBtn} onClick={() => toggleHidden(row.cat)} title={`Hide ${row.cat} and leave it out of the total`} aria-label={`Hide ${row.cat}`}>
                          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>visibility_off</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className={styles.foot}>
          Shares are of all spending in the period except hidden categories; transfers and card payments never count.
          “Change” is the move in share, in percentage points, from the period before.
        </div>
      </div>
    </div>
  );
}
