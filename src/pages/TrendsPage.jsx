import { useMemo, useState } from 'react';
import { useData } from '../contexts/DataContext';
import styles from './TrendsPage.module.css';

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(n));
}

function fmtSigned(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return sign + fmt(n);
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return sign + Math.round(n * 100) + '%';
}

const WINDOW_OPTIONS = [
  { id: '3v3', label: '3 vs prior 3', recent: 3, baseline: 3 },
  { id: '1v3', label: '1 vs prior 3', recent: 1, baseline: 3 },
  { id: '1v6', label: '1 vs prior 6', recent: 1, baseline: 6 },
  { id: '6v6', label: '6 vs prior 6', recent: 6, baseline: 6 },
];

// A category is flagged when its monthly spend is both materially higher
// (>= 25%) AND at least $50/month more than the baseline window.
const FLAG_PCT = 0.25;
const FLAG_ABS = 50;

function Sparkline({ series, flagged }) {
  if (!series.length) return null;
  const max = Math.max(...series, 1);
  const w = 90;
  const h = 24;
  const bw = w / series.length;
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      {series.map((v, i) => {
        const bh = Math.max(1, (v / max) * (h - 2));
        return (
          <rect
            key={i}
            x={i * bw + 1}
            y={h - bh}
            width={bw - 2}
            height={bh}
            fill={flagged ? '#ba1a1a' : 'var(--color-text-tertiary)'}
            opacity={flagged ? 0.85 : 0.55}
            rx={1}
          />
        );
      })}
    </svg>
  );
}

export function TrendsPage() {
  const { transactions, loading } = useData();
  const [windowId, setWindowId] = useState('3v3');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [sort, setSort] = useState({ col: 'deltaAbs', dir: 'desc' });

  const opts = WINDOW_OPTIONS.find(w => w.id === windowId) || WINDOW_OPTIONS[0];

  const data = useMemo(() => {
    if (!transactions || !transactions.length) return { rows: [], months: [] };

    const byCatMonth = new Map();
    const monthSet = new Set();
    for (const t of transactions) {
      if (!t.date) continue;
      const amt = Number(t.amount) || 0;
      if (amt >= 0) continue; // expense-only
      const catLower = (t.category || '').toLowerCase();
      if (catLower === 'transfer' || catLower === 'credit card payments' || catLower === 'credit card payment') continue;
      const d = new Date(t.date);
      if (isNaN(d)) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthSet.add(key);
      const cat = t.category || 'Uncategorized';
      if (!byCatMonth.has(cat)) byCatMonth.set(cat, new Map());
      const m = byCatMonth.get(cat);
      m.set(key, (m.get(key) || 0) + Math.abs(amt));
    }

    const sorted = [...monthSet].sort();
    if (!sorted.length) return { rows: [], months: [] };
    const [sy, sm] = sorted[0].split('-').map(Number);
    const [ey, em] = sorted[sorted.length - 1].split('-').map(Number);
    const allMonths = [];
    let cy = sy, cm = sm;
    while (cy < ey || (cy === ey && cm <= em)) {
      allMonths.push(`${cy}-${String(cm).padStart(2, '0')}`);
      cm++;
      if (cm > 12) { cm = 1; cy++; }
    }

    const needed = opts.recent + opts.baseline;
    if (allMonths.length < needed) {
      return { rows: [], months: allMonths, insufficient: true, needed };
    }
    const analysisMonths = allMonths.slice(-needed);
    const recentMonths = analysisMonths.slice(-opts.recent);
    const baselineMonths = analysisMonths.slice(0, opts.baseline);

    const sparkWindow = allMonths.slice(-Math.max(12, needed));

    const rows = [];
    for (const [cat, m] of byCatMonth) {
      const recentSum = recentMonths.reduce((s, k) => s + (m.get(k) || 0), 0);
      const baselineSum = baselineMonths.reduce((s, k) => s + (m.get(k) || 0), 0);
      const recent = recentSum / opts.recent;
      const baseline = baselineSum / opts.baseline;
      const deltaAbs = recent - baseline;
      const deltaPct = baseline > 0 ? deltaAbs / baseline : (recent > 0 ? Number.POSITIVE_INFINITY : 0);
      const series = sparkWindow.map(k => m.get(k) || 0);
      const totalEverSpent = [...m.values()].reduce((s, v) => s + v, 0);
      // Only flag INCREASES that are both material ($) and significant (%)
      const flagged = deltaAbs >= FLAG_ABS && deltaPct >= FLAG_PCT;
      rows.push({ cat, recent, baseline, deltaAbs, deltaPct, series, flagged, totalEverSpent });
    }
    rows.sort((a, b) => b.deltaAbs - a.deltaAbs);
    return { rows, months: sparkWindow };
  }, [transactions, opts]);

  const filteredRows = useMemo(() => {
    let list = data.rows || [];
    if (flaggedOnly) list = list.filter(r => r.flagged);
    list = list.slice().sort((a, b) => {
      const dir = sort.dir === 'asc' ? 1 : -1;
      const av = a[sort.col];
      const bv = b[sort.col];
      if (sort.col === 'cat') return (av || '').localeCompare(bv || '') * dir;
      const an = Number.isFinite(av) ? av : -Infinity;
      const bn = Number.isFinite(bv) ? bv : -Infinity;
      return (an - bn) * dir;
    });
    return list;
  }, [data.rows, flaggedOnly, sort]);

  function toggleSort(col, defaultDir) {
    setSort(prev => {
      if (prev.col === col) return { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      return { col, dir: defaultDir || 'desc' };
    });
  }

  function sortArrow(col) {
    return (
      <span className={styles.sortArrow} style={{ opacity: sort.col === col ? 1 : 0 }}>
        {sort.dir === 'asc' ? '\u25B2' : '\u25BC'}
      </span>
    );
  }

  const flaggedCount = (data.rows || []).filter(r => r.flagged).length;
  const topMover = (data.rows || []).filter(r => r.flagged).sort((a, b) => b.deltaAbs - a.deltaAbs)[0];
  const totalIncreaseMo = (data.rows || []).filter(r => r.flagged).reduce((s, r) => s + r.deltaAbs, 0);

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div className={styles.heroLabel}>Spending Trends</div>
        <div className={styles.heroTitle}>Which categories are driving higher spending?</div>
        <div className={styles.heroSubtitle}>
          Compares a recent window of monthly spend against a prior baseline window and flags
          categories whose spend is up by at least {Math.round(FLAG_PCT * 100)}% and {fmt(FLAG_ABS)}/mo.
        </div>
        <div className={styles.heroStats}>
          <div className={styles.heroStat}>
            <div className={styles.heroStatValue} style={{ color: flaggedCount > 0 ? '#ffb4a9' : '#fff' }}>{flaggedCount}</div>
            <div className={styles.heroStatLabel}>Flagged Categories</div>
          </div>
          <div className={styles.heroStat}>
            <div className={styles.heroStatValue}>{fmtSigned(totalIncreaseMo)}</div>
            <div className={styles.heroStatLabel}>Total Increase / Mo</div>
          </div>
          {topMover && (
            <div className={styles.heroStat}>
              <div className={styles.heroStatValue}>{topMover.cat}</div>
              <div className={styles.heroStatLabel}>Top Mover · {fmtSigned(topMover.deltaAbs)}/mo</div>
            </div>
          )}
        </div>
      </div>

      <div className={styles.controls}>
        <div className={styles.pillGroup}>
          {WINDOW_OPTIONS.map(o => (
            <button
              key={o.id}
              type="button"
              className={`${styles.pill} ${windowId === o.id ? styles.pillActive : ''}`}
              onClick={() => setWindowId(o.id)}
              title={`Compare last ${o.recent} ${o.recent === 1 ? 'month' : 'months'} to the ${o.baseline} ${o.baseline === 1 ? 'month' : 'months'} before that`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`${styles.toggleBtn} ${flaggedOnly ? styles.toggleBtnActive : ''}`}
          onClick={() => setFlaggedOnly(v => !v)}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
            {flaggedOnly ? 'check_box' : 'check_box_outline_blank'}
          </span>
          Flagged only
        </button>
      </div>

      {loading ? (
        <div className={styles.emptyState}>Loading transactions...</div>
      ) : data.insufficient ? (
        <div className={styles.emptyState}>
          Not enough history for this window — need at least {data.needed} months of data.
        </div>
      ) : filteredRows.length === 0 ? (
        <div className={styles.emptyState}>
          {flaggedOnly ? 'No categories are currently flagged as increasing.' : 'No spending data available.'}
        </div>
      ) : (
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: 34, textAlign: 'center' }}>Flag</th>
                <th className={styles.sortableTh} onClick={() => toggleSort('cat', 'asc')}>
                  Category{sortArrow('cat')}
                </th>
                <th style={{ width: 100 }}>Trend</th>
                <th className={styles.sortableTh} style={{ textAlign: 'right' }} onClick={() => toggleSort('baseline', 'desc')}>
                  Baseline / Mo{sortArrow('baseline')}
                </th>
                <th className={styles.sortableTh} style={{ textAlign: 'right' }} onClick={() => toggleSort('recent', 'desc')}>
                  Recent / Mo{sortArrow('recent')}
                </th>
                <th className={styles.sortableTh} style={{ textAlign: 'right' }} onClick={() => toggleSort('deltaAbs', 'desc')}>
                  Δ $ / Mo{sortArrow('deltaAbs')}
                </th>
                <th className={styles.sortableTh} style={{ textAlign: 'right' }} onClick={() => toggleSort('deltaPct', 'desc')}>
                  Δ %{sortArrow('deltaPct')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(r => {
                const deltaClass = r.deltaAbs > 0 ? styles.deltaUp : r.deltaAbs < 0 ? styles.deltaDown : styles.deltaFlat;
                return (
                  <tr key={r.cat}>
                    <td style={{ textAlign: 'center' }}>
                      {r.flagged ? (
                        <span className={styles.flagBadge} title="Materially increasing — consider investigating">
                          <span className="material-symbols-outlined" style={{ fontSize: 13 }}>priority_high</span>
                        </span>
                      ) : (
                        <span className={styles.flagMuted}>·</span>
                      )}
                    </td>
                    <td><div className={styles.catName}>{r.cat}</div></td>
                    <td>
                      <Sparkline series={r.series} flagged={r.flagged} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className={styles.amountMain}>{fmt(r.baseline)}</div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className={styles.amountMain}>{fmt(r.recent)}</div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className={deltaClass}>{fmtSigned(r.deltaAbs)}</div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className={deltaClass}>{Number.isFinite(r.deltaPct) ? fmtPct(r.deltaPct) : 'new'}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
