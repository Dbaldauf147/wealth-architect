import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { buildWedgeBands, axisTicks, OTHER_LABEL } from '../lib/wedgeChart';
import { monthLabelShort, monthLabel } from '../lib/netWorthSnapshot';
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

/* How many categories keep their own wedge before the tail rolls into "Other". */
const WEDGE_TOP_N = 8;
const WEDGE_PREF_KEY = 'wa-trends-wedge';

const CHART_H = 300;
const CHART_MIN_W = 320;
/* Roughly what a "Sep 26" tick needs before its neighbour starts touching it. */
const MONTH_LABEL_W = 52;

/* Track the rendered width of an element, so the chart can draw at 1:1 instead
   of scaling a fixed viewBox — a scaled viewBox shrinks the axis text along
   with everything else, and on a phone that lands somewhere around 5px. */
function useMeasuredWidth(initial) {
  const ref = useRef(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setWidth(Math.max(CHART_MIN_W, Math.round(el.clientWidth || initial)));
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [initial]);
  return [ref, width];
}

function fmtAxis(n) {
  if (!n) return '$0';
  if (Math.abs(n) >= 1000) {
    const k = n / 1000;
    return '$' + (Math.abs(k) >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')) + 'k';
  }
  return '$' + Math.round(n);
}

/* Stacked-area ("wedge") view of monthly spend by category.

   Drawn as one polygon per band rather than a line per category: the question
   this answers is how the total splits and how that split moves, and a stack
   shows both at once. Straight edges, not smoothed — the data is monthly, and
   a spline would invent spend between the points that nobody made. */
function WedgeChart({ months, bands, max }) {
  const [wrapRef, chartW] = useMeasuredWidth(760);
  const pad = { top: 12, right: 14, bottom: 34, left: chartW < 480 ? 44 : 60 };
  const innerW = chartW - pad.left - pad.right;
  const innerH = CHART_H - pad.top - pad.bottom;
  const { top, ticks } = axisTicks(max, chartW < 480 ? 3 : 4);

  const x = (i) => months.length === 1
    ? pad.left + innerW / 2
    : pad.left + (i / (months.length - 1)) * innerW;
  const y = (v) => top > 0
    ? pad.top + innerH - (v / top) * innerH
    : pad.top + innerH;

  // A single month has no width to sweep, so give each band a slab instead of
  // a degenerate zero-width polygon.
  const slab = months.length === 1 ? Math.min(120, innerW) / 2 : 0;

  function bandPath(band) {
    if (months.length === 1) {
      const cx = x(0);
      return `M ${cx - slab} ${y(band.lower[0])} L ${cx - slab} ${y(band.upper[0])} L ${cx + slab} ${y(band.upper[0])} L ${cx + slab} ${y(band.lower[0])} Z`;
    }
    const upper = band.upper.map((v, i) => `${x(i)} ${y(v)}`);
    const lower = band.lower.map((v, i) => `${x(i)} ${y(v)}`).reverse();
    return `M ${upper.join(' L ')} L ${lower.join(' L ')} Z`;
  }

  // Every month's full breakdown, for the hover strip's tooltip. Native SVG
  // <title> is what the rest of this app uses for chart detail, and it keeps
  // working on a touch-and-hold where a custom hover layer would not.
  const monthTip = (i) => {
    const lines = bands
      .map(b => ({ cat: b.cat, v: b.values[i] }))
      .filter(b => b.v > 0)
      .sort((a, b) => b.v - a.v)
      .map(b => `${b.cat}: ${fmt(b.v)}`);
    const total = bands.reduce((s, b) => s + b.values[i], 0);
    return [`${monthLabel(months[i])} — ${fmt(total)} total`, ...lines].join('\n');
  };

  // Label every month when there is room, otherwise thin them out evenly —
  // driven by the measured width, so a phone drops to every other month
  // instead of overprinting twelve of them on top of each other.
  const roomFor = Math.max(2, Math.floor(innerW / MONTH_LABEL_W));
  const labelEvery = Math.max(1, Math.ceil(months.length / roomFor));

  return (
    <div ref={wrapRef} className={styles.chartWrap}>
      <svg
        width="100%"
        height={CHART_H}
        viewBox={`0 0 ${chartW} ${CHART_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Stacked monthly spending by category, ${monthLabel(months[0])} to ${monthLabel(months[months.length - 1])}`}
        style={{ display: 'block' }}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={pad.left} y1={y(t)} x2={chartW - pad.right} y2={y(t)}
              stroke="var(--color-text-tertiary)" strokeOpacity={t === 0 ? 0.35 : 0.18} strokeWidth={1}
            />
            <text
              x={pad.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11}
              fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)"
            >
              {fmtAxis(t)}
            </text>
          </g>
        ))}

        {bands.map(band => (
          <path
            key={band.cat}
            d={bandPath(band)}
            fill={band.color}
            fillOpacity={0.82}
            stroke="var(--color-surface)"
            strokeWidth={0.75}
          />
        ))}

        {/* Transparent per-month strips carrying the tooltip and a hover tint. */}
        {months.map((m, i) => {
          const half = months.length === 1 ? slab : innerW / (months.length - 1) / 2;
          const x0 = Math.max(pad.left, x(i) - half);
          const x1 = Math.min(chartW - pad.right, x(i) + half);
          return (
            <rect
              key={m}
              className={styles.monthHover}
              x={x0} y={pad.top} width={Math.max(1, x1 - x0)} height={innerH}
            >
              <title>{monthTip(i)}</title>
            </rect>
          );
        })}

        {months.map((m, i) => (
          i % labelEvery === 0 || i === months.length - 1 ? (
            <text
              key={m}
              x={x(i)} y={CHART_H - 12}
              textAnchor={i === 0 ? 'start' : i === months.length - 1 ? 'end' : 'middle'}
              fontSize={10.5} fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)"
            >
              {monthLabelShort(m)}
            </text>
          ) : null
        ))}
      </svg>
    </div>
  );
}

export function TrendsPage() {
  const { transactions, loading } = useData();
  const [windowId, setWindowId] = useState('3v3');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [sort, setSort] = useState({ col: 'deltaAbs', dir: 'desc' });
  // The chart is a view preference, not account data — it stays in this
  // browser rather than going through the Firestore config everything else
  // syncs with. Remembered so the toggle survives a reload.
  const [showWedge, setShowWedge] = useState(() => {
    try { return localStorage.getItem(WEDGE_PREF_KEY) !== '0'; } catch { return true; }
  });

  function toggleWedge() {
    setShowWedge(v => {
      const next = !v;
      try { localStorage.setItem(WEDGE_PREF_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  }

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

  /* The chart deliberately ignores the "Flagged only" filter: a stack built
     from a subset of categories reads as a total that it isn't. It shows the
     whole spend, and the table below stays the place to narrow things down. */
  const wedge = useMemo(
    () => buildWedgeBands({ months: data.months || [], rows: data.rows || [], topN: WEDGE_TOP_N }),
    [data.months, data.rows],
  );

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
        <div className={styles.controlButtons}>
          <button
            type="button"
            className={`${styles.toggleBtn} ${showWedge ? styles.toggleBtnActive : ''}`}
            onClick={toggleWedge}
            aria-pressed={showWedge}
            title="Show a stacked-area chart of monthly spend by category"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
              {showWedge ? 'check_box' : 'check_box_outline_blank'}
            </span>
            Wedge chart
          </button>
          <button
            type="button"
            className={`${styles.toggleBtn} ${flaggedOnly ? styles.toggleBtnActive : ''}`}
            onClick={() => setFlaggedOnly(v => !v)}
            aria-pressed={flaggedOnly}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
              {flaggedOnly ? 'check_box' : 'check_box_outline_blank'}
            </span>
            Flagged only
          </button>
        </div>
      </div>

      {showWedge && !loading && wedge.bands.length > 0 && (
        <div className={styles.chartCard}>
          <div className={styles.chartHead}>
            <div className={styles.chartTitle}>Spending Over Time by Category</div>
            <div className={styles.chartSub}>
              {monthLabelShort(data.months[0])} – {monthLabelShort(data.months[data.months.length - 1])}
              {' · '}every category, stacked · hover a month for the breakdown
            </div>
          </div>
          <WedgeChart months={data.months} bands={wedge.bands} max={wedge.max} />
          <div className={styles.legend}>
            {wedge.bands.map(b => (
              <div key={b.cat} className={styles.legendItem} title={
                b.cat === OTHER_LABEL
                  ? `${b.rolledUp} smaller categories · ${fmt(b.avg)}/mo`
                  : `${fmt(b.avg)}/mo over this window`
              }>
                <span className={styles.legendSwatch} style={{ background: b.color }} />
                <span className={styles.legendLabel}>
                  {b.cat === OTHER_LABEL ? `Other (${b.rolledUp})` : b.cat}
                </span>
                <span className={styles.legendValue}>{fmt(b.avg)}/mo</span>
              </div>
            ))}
          </div>
        </div>
      )}

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
