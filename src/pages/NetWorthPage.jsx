import { useMemo, useState } from 'react';
import { useData } from '../contexts/DataContext';
import styles from './NetWorthPage.module.css';

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function fmtSigned(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return sign + new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(n));
}

function fmtAxis(n) {
  if (n == null || !Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return sign + Math.abs(n * 100).toFixed(1) + '%';
}

function fmtDateShort(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function smoothPath(points) {
  if (points.length < 2) return '';
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

const RANGE_OPTIONS = [
  { id: '1m', label: '1M', days: 30 },
  { id: '3m', label: '3M', days: 90 },
  { id: '6m', label: '6M', days: 180 },
  { id: '1y', label: '1Y', days: 365 },
  { id: 'all', label: 'ALL', days: null },
];

const VIEW_OPTIONS = [
  { id: 'networth', label: 'Net Worth' },
  { id: 'breakdown', label: 'Assets vs Liabilities' },
];

export function NetWorthPage() {
  const { balances, balanceHistory, loading } = useData();
  const [rangeId, setRangeId] = useState('1y');
  const [viewId, setViewId] = useState('networth');

  // Walk the balance history forward, maintaining the latest known balance for
  // each account. At every snapshot date emit a net-worth row using the
  // forward-filled values so accounts that don't update on a given date still
  // contribute. Liability accounts are subtracted by absolute value so we are
  // resilient to Tiller's two conventions (some accounts record debt as a
  // negative balance, others as a positive one — the Balances tab shows
  // liabilities as positive numbers regardless).
  const series = useMemo(() => {
    if (!balanceHistory || balanceHistory.length === 0 || !balances) return [];

    const classification = {};
    for (const a of balances.assets || []) {
      if (!a.custom && a.name) classification[a.name] = 'asset';
    }
    for (const l of balances.liabilities || []) {
      if (!l.custom && l.name) classification[l.name] = 'liability';
    }

    const rows = [];
    for (const r of balanceHistory) {
      if (!r.date || !r.account) continue;
      const side = classification[r.account];
      if (!side) continue;
      const t = new Date(r.date).getTime();
      if (!Number.isFinite(t)) continue;
      rows.push({ t, account: r.account, side, balance: r.balance || 0 });
    }
    if (!rows.length) return [];
    rows.sort((a, b) => a.t - b.t);

    const running = new Map();
    const dailyMap = new Map();
    for (const r of rows) {
      running.set(r.account, { side: r.side, balance: r.balance });
      const dayKey = new Date(r.t);
      dayKey.setHours(0, 0, 0, 0);
      const k = dayKey.getTime();
      let assets = 0, liabilities = 0;
      for (const v of running.values()) {
        if (v.side === 'asset') assets += v.balance;
        else liabilities += Math.abs(v.balance);
      }
      dailyMap.set(k, { t: k, assets, liabilities, netWorth: assets - liabilities });
    }

    return [...dailyMap.values()].sort((a, b) => a.t - b.t);
  }, [balanceHistory, balances]);

  // Apply the active range pill by trimming to the last N days. ALL uses the
  // full series.
  const filtered = useMemo(() => {
    if (!series.length) return series;
    const opt = RANGE_OPTIONS.find(o => o.id === rangeId) || RANGE_OPTIONS[3];
    if (!opt.days) return series;
    const cutoff = series[series.length - 1].t - opt.days * 24 * 60 * 60 * 1000;
    const trimmed = series.filter(p => p.t >= cutoff);
    return trimmed.length >= 2 ? trimmed : series.slice(-2);
  }, [series, rangeId]);

  const stats = useMemo(() => {
    if (!filtered.length) return null;
    const first = filtered[0];
    const last = filtered[filtered.length - 1];
    const change = last.netWorth - first.netWorth;
    const pct = first.netWorth !== 0 ? change / Math.abs(first.netWorth) : null;
    let hi = filtered[0], lo = filtered[0];
    let sum = 0;
    for (const p of filtered) {
      if (p.netWorth > hi.netWorth) hi = p;
      if (p.netWorth < lo.netWorth) lo = p;
      sum += p.netWorth;
    }
    return { first, last, change, pct, hi, lo, avg: sum / filtered.length };
  }, [filtered]);

  // Chart geometry. Picked to match the surface size used on Cash Flow /
  // Spending Trends — wide enough to read, short enough not to dominate.
  const chartW = 880;
  const chartH = 280;
  const pad = { top: 16, right: 16, bottom: 32, left: 64 };
  const innerW = chartW - pad.left - pad.right;
  const innerH = chartH - pad.top - pad.bottom;

  const chart = useMemo(() => {
    if (filtered.length < 2) return null;

    const seriesA = viewId === 'breakdown'
      ? filtered.map(p => p.assets)
      : filtered.map(p => p.netWorth);
    const seriesB = viewId === 'breakdown' ? filtered.map(p => p.liabilities) : null;

    const values = seriesB ? [...seriesA, ...seriesB] : seriesA;
    const rawMin = Math.min(...values, 0);
    const rawMax = Math.max(...values, 0);
    const span = Math.max(rawMax - rawMin, 1);
    const padPct = 0.08;
    const yMin = rawMin - span * padPct;
    const yMax = rawMax + span * padPct;

    const tMin = filtered[0].t;
    const tMax = filtered[filtered.length - 1].t;
    const tSpan = Math.max(tMax - tMin, 1);

    const xPos = (t) => pad.left + ((t - tMin) / tSpan) * innerW;
    const yPos = (v) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

    const ticks = (() => {
      const count = 5;
      const out = [];
      for (let i = 0; i < count; i++) {
        out.push(yMin + ((yMax - yMin) * i) / (count - 1));
      }
      return out;
    })();

    const pointsA = filtered.map((p, i) => ({ x: xPos(p.t), y: yPos(seriesA[i]), v: seriesA[i], t: p.t }));
    const pointsB = seriesB ? filtered.map((p, i) => ({ x: xPos(p.t), y: yPos(seriesB[i]), v: seriesB[i], t: p.t })) : null;

    const baselineY = yPos(0);
    const areaPathA = (() => {
      const top = smoothPath(pointsA);
      if (!top) return '';
      return `${top} L ${pointsA[pointsA.length - 1].x} ${baselineY} L ${pointsA[0].x} ${baselineY} Z`;
    })();

    return { ticks, pointsA, pointsB, areaPathA, yPos, xPos, yMin, yMax, tMin, tMax };
  }, [filtered, viewId, innerH, innerW, pad.left, pad.top]);

  const xAxisLabels = useMemo(() => {
    if (!chart || filtered.length < 2) return [];
    const count = Math.min(6, filtered.length);
    const step = (filtered.length - 1) / (count - 1);
    const out = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.round(i * step);
      const p = filtered[idx];
      out.push({ t: p.t, x: chart.xPos(p.t) });
    }
    return out;
  }, [chart, filtered]);

  // Pick a handful of evenly-spaced points to render hover dots. With many
  // history rows the chart can get noisy; the dots are visual anchors, not
  // every snapshot.
  const dotPoints = useMemo(() => {
    if (!chart) return [];
    const max = 14;
    if (chart.pointsA.length <= max) return chart.pointsA.map((p, i) => ({ ...p, idx: i }));
    const step = (chart.pointsA.length - 1) / (max - 1);
    const out = [];
    for (let i = 0; i < max; i++) {
      const idx = Math.round(i * step);
      out.push({ ...chart.pointsA[idx], idx });
    }
    return out;
  }, [chart]);

  // TEMP DIAGNOSTIC: reconcile the current-balances net worth (hero) against the
  // subset of accounts the chart is actually able to plot. The chart only counts
  // an account if it is non-custom AND its exact name appears in Balance History
  // (see the `series` memo). This surfaces every account that contributes to the
  // hero total but is missing from the charted series, and why.
  const reconcile = useMemo(() => {
    if (!balances) return null;
    const histNames = new Set();
    const histNorm = new Map(); // normalized name -> original history name
    for (const r of balanceHistory || []) {
      if (r && r.account) {
        histNames.add(r.account);
        histNorm.set(String(r.account).trim().toLowerCase(), r.account);
      }
    }
    const rows = [];
    const add = (a, side) => {
      if (!a || !a.name) return;
      const exact = histNames.has(a.name);
      const norm = String(a.name).trim().toLowerCase();
      const nearMatch = !exact && histNorm.has(norm) ? histNorm.get(norm) : null;
      const contribution = side === 'asset' ? (a.balance || 0) : -Math.abs(a.balance || 0);
      // A row is charted only when it is non-custom AND has an exact-name match.
      const charted = exact && !a.custom;
      let reason = 'charted';
      if (!charted) {
        if (a.custom) reason = 'custom (excluded)';
        else if (nearMatch) reason = 'name mismatch';
        else reason = 'no history rows';
      }
      rows.push({ name: a.name, side, custom: !!a.custom, balance: a.balance || 0, contribution, charted, nearMatch, reason });
    };
    for (const a of balances.assets || []) add(a, 'asset');
    for (const l of balances.liabilities || []) add(l, 'liability');

    let inChart = 0, missing = 0, missingCustom = 0, missingMismatch = 0, missingNoHistory = 0;
    for (const r of rows) {
      if (r.charted) { inChart += r.contribution; continue; }
      missing += r.contribution;
      if (r.custom) missingCustom += r.contribution;
      else if (r.nearMatch) missingMismatch += r.contribution;
      else missingNoHistory += r.contribution;
    }
    // Culprits first: uncharted rows by descending absolute contribution.
    rows.sort((a, b) => (a.charted - b.charted) || (Math.abs(b.contribution) - Math.abs(a.contribution)));
    return { rows, inChart, missing, missingCustom, missingMismatch, missingNoHistory, total: balances.netWorth ?? 0 };
  }, [balances, balanceHistory]);

  if (loading && (!balanceHistory || balanceHistory.length === 0)) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyState}>Loading balance history…</div>
      </div>
    );
  }

  if (!series.length) {
    return (
      <div className={styles.page}>
        <div className={styles.hero}>
          <div className={styles.heroLabel}>Net Worth Over Time</div>
          <div className={styles.heroTitle}>No balance history available</div>
          <div className={styles.heroSubtitle}>
            Add the "Balance History" tab in your Tiller sheet to start tracking net worth over time.
          </div>
        </div>
      </div>
    );
  }

  const currentNetWorth = balances?.netWorth ?? stats?.last?.netWorth ?? 0;

  return (
    <div className={styles.page}>
      {/* Hero */}
      <div className={styles.hero}>
        <div className={styles.heroLabel}>Net Worth Over Time</div>
        <div className={styles.heroValue}>{fmt(currentNetWorth)}</div>
        {stats && (
          <div className={styles.heroChange}>
            <span className={stats.change >= 0 ? styles.changeUp : styles.changeDown}>
              <span className="material-symbols-outlined" style={{ fontSize: 16, verticalAlign: 'middle' }}>
                {stats.change >= 0 ? 'trending_up' : 'trending_down'}
              </span>
              {' '}
              {fmtSigned(stats.change)}
              {stats.pct != null && <span style={{ opacity: 0.8 }}>{' '}({fmtPct(stats.pct)})</span>}
            </span>
            <span className={styles.changeRange}>
              · {fmtDateShort(new Date(stats.first.t))} → {fmtDateShort(new Date(stats.last.t))}
            </span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className={styles.controls}>
        <div className={styles.pillGroup}>
          {RANGE_OPTIONS.map(o => (
            <button
              key={o.id}
              type="button"
              className={`${styles.pill} ${rangeId === o.id ? styles.pillActive : ''}`}
              onClick={() => setRangeId(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className={styles.pillGroup}>
          {VIEW_OPTIONS.map(o => (
            <button
              key={o.id}
              type="button"
              className={`${styles.pill} ${viewId === o.id ? styles.pillActive : ''}`}
              onClick={() => setViewId(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className={styles.chartCard}>
        {!chart ? (
          <div className={styles.emptyState}>
            Not enough history in this range to draw a chart.
          </div>
        ) : (
          <svg width="100%" height={chartH} viewBox={`0 0 ${chartW} ${chartH}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
            {chart.ticks.map((t, i) => {
              const y = chart.yPos(t);
              return (
                <g key={i}>
                  <line x1={pad.left} y1={y} x2={chartW - pad.right} y2={y}
                    stroke="var(--color-text-tertiary)" strokeOpacity={0.18} strokeWidth={1} />
                  <text x={pad.left - 8} y={y + 4} textAnchor="end" fontSize={11}
                    fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">
                    {fmtAxis(t)}
                  </text>
                </g>
              );
            })}

            {chart.yMin < 0 && chart.yMax > 0 && (
              <line x1={pad.left} y1={chart.yPos(0)} x2={chartW - pad.right} y2={chart.yPos(0)}
                stroke="var(--color-text-tertiary)" strokeOpacity={0.4} strokeWidth={1} strokeDasharray="3 3" />
            )}

            {viewId === 'networth' && (
              <path d={chart.areaPathA} fill="url(#nw-area)" opacity={0.55} />
            )}

            <defs>
              <linearGradient id="nw-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-secondary, #0058be)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--color-secondary, #0058be)" stopOpacity={0} />
              </linearGradient>
            </defs>

            <path d={smoothPath(chart.pointsA)} fill="none"
              stroke={viewId === 'breakdown' ? '#34d399' : 'var(--color-secondary, #0058be)'}
              strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" />

            {chart.pointsB && (
              <path d={smoothPath(chart.pointsB)} fill="none" stroke="#f87171"
                strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" />
            )}

            {dotPoints.map((p, i) => {
              const orig = filtered[p.idx];
              const label = viewId === 'breakdown'
                ? `${fmtDateShort(new Date(orig.t))} — Assets ${fmt(orig.assets)} · Liabilities ${fmt(orig.liabilities)} · Net ${fmt(orig.netWorth)}`
                : `${fmtDateShort(new Date(orig.t))} — ${fmt(orig.netWorth)}`;
              return (
                <circle key={i} cx={p.x} cy={p.y} r={3}
                  fill="var(--color-surface, #fff)"
                  stroke={viewId === 'breakdown' ? '#34d399' : 'var(--color-secondary, #0058be)'}
                  strokeWidth={1.5}>
                  <title>{label}</title>
                </circle>
              );
            })}

            {xAxisLabels.map((l, i) => (
              <text key={i} x={l.x} y={chartH - 10} textAnchor="middle"
                fontSize={11} fill="var(--color-text-secondary)" fontFamily="var(--font-headline)">
                {new Date(l.t).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}
              </text>
            ))}
          </svg>
        )}

        {viewId === 'breakdown' && (
          <div className={styles.legend}>
            <span><span className={styles.legendDot} style={{ background: '#34d399' }} /> Assets</span>
            <span><span className={styles.legendDot} style={{ background: '#f87171' }} /> Liabilities</span>
          </div>
        )}
      </div>

      {/* Stat strip */}
      {stats && (
        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Current</div>
            <div className={styles.statValue}>{fmt(stats.last.netWorth)}</div>
            <div className={styles.statSub}>{fmtDateShort(new Date(stats.last.t))}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Highest in range</div>
            <div className={styles.statValue}>{fmt(stats.hi.netWorth)}</div>
            <div className={styles.statSub}>{fmtDateShort(new Date(stats.hi.t))}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Lowest in range</div>
            <div className={styles.statValue}>{fmt(stats.lo.netWorth)}</div>
            <div className={styles.statSub}>{fmtDateShort(new Date(stats.lo.t))}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Average</div>
            <div className={styles.statValue}>{fmt(stats.avg)}</div>
            <div className={styles.statSub}>{filtered.length} snapshots</div>
          </div>
        </div>
      )}

      {/* TEMP DIAGNOSTIC — remove after root-causing the net-worth/chart gap. */}
      {reconcile && (
        <div style={{
          marginTop: 24, padding: 16, borderRadius: 12,
          border: '1px solid var(--color-text-tertiary)', borderColor: 'rgba(128,128,128,0.3)',
          background: 'rgba(128,128,128,0.06)', fontFamily: 'var(--font-headline)',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>🔎 Net-worth reconciliation (temporary)</div>
          <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 12, opacity: 0.85 }}>
            Hero total (all current balances): <b>{fmt(reconcile.total)}</b><br />
            In chart (non-custom + exact history match): <b>{fmt(reconcile.inChart)}</b><br />
            Missing from chart: <b>{fmtSigned(reconcile.missing)}</b>
            {'  '}— custom {fmtSigned(reconcile.missingCustom)}
            {' · '}name mismatch {fmtSigned(reconcile.missingMismatch)}
            {' · '}no history rows {fmtSigned(reconcile.missingNoHistory)}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                  <th style={{ padding: '4px 10px 4px 0' }}>Account</th>
                  <th style={{ padding: '4px 10px' }}>Side</th>
                  <th style={{ padding: '4px 10px', textAlign: 'right' }}>Contribution</th>
                  <th style={{ padding: '4px 10px' }}>In chart?</th>
                  <th style={{ padding: '4px 10px' }}>Reason / near-match</th>
                </tr>
              </thead>
              <tbody>
                {reconcile.rows.map((r, i) => (
                  <tr key={i} style={{
                    borderTop: '1px solid rgba(128,128,128,0.18)',
                    background: r.charted ? 'transparent' : 'rgba(248,113,113,0.10)',
                  }}>
                    <td style={{ padding: '4px 10px 4px 0' }}>{r.name}</td>
                    <td style={{ padding: '4px 10px' }}>{r.side}</td>
                    <td style={{ padding: '4px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtSigned(r.contribution)}</td>
                    <td style={{ padding: '4px 10px' }}>{r.charted ? '✓' : '—'}</td>
                    <td style={{ padding: '4px 10px' }}>
                      {r.reason}{r.nearMatch ? ` → history has "${r.nearMatch}"` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default NetWorthPage;
