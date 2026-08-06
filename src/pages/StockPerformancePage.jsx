import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { fetchSeries, fetchQuotes, fetchCpi } from '../lib/marketData';
import {
  makeSeries, cagr, returnBetween, calendarYearReturns, rollingReturns,
  growthPath, maxDrawdown, toISODate, xirr, MS_DAY,
} from '../lib/benchmark';
import {
  makeCpiSeries, inflationCompare, realCashComparison, realHistory,
  calendarYearInflation, inflationCagr, inflationBetween, realReturn,
  cpiLagMonths, priceRatio,
} from '../lib/inflation';
import {
  breakEvenTable, requiredReturn, projectPaths, taxOpportunityCost, impliedTaxRate,
} from '../lib/switchAnalysis';
import { STATES, findState, STATE_TAX_AS_OF } from '../lib/stateTax';
import {
  FILING_STATUSES, TAX_YEAR, TAX_SOURCE, STANDARD_DEDUCTION, NIIT_RATE,
  NIIT_THRESHOLD, MAX_LOSS_OFFSET, LONG_TERM_DAYS, LTCG_BRACKETS,
  estimateTax, summarizeLots, isLongTerm, longTermDate, heldDays,
} from '../lib/taxes';
import {
  readTable, guessMapping, missingFields, parseRows, sortTrades,
  mergeTrades, mergeCorporateActions, mergeIncome, mergeCashRows, buildLots,
  tradedSymbols, hydrateTrades, hydrateActions, hydrateIncome, hydrateCashRows, FIELDS,
} from '../lib/robinhood';
import { benchmarkLots, externalCashComparison } from '../lib/tradeBenchmark';
import {
  priceSeries, buildPortfolioHistory, contributionEvents, mergeLoggedHistory,
} from '../lib/portfolioHistory';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import styles from './StockPerformancePage.module.css';

// The S&P 500 *total return* index — dividends reinvested. Using the price
// index instead would understate the benchmark by roughly 1.8%/yr, which
// over 20 years is the difference between beating the market and not.
const BENCHMARK_SYMBOL = '^SP500TR';
const SERIES_START = '1999-12-31';
// CPI is pulled from the year before the index series begins, so the first
// trading day already has a price level behind it to measure from.
const CPI_START_YEAR = 1999;

// Horizons the projection is reported over, and the choices offered when
// asked how long the money is being held.
const HORIZONS = [1, 3, 5, 10, 20];

const RANGE_OPTIONS = [
  { id: '5y', label: '5Y', years: 5 },
  { id: '10y', label: '10Y', years: 10 },
  { id: '20y', label: '20Y', years: 20 },
  { id: 'max', label: 'MAX', years: null },
];

function fmt(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(n);
}

function fmtSigned(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return sign + fmt(Math.abs(n));
}

function fmtPct(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return sign + Math.abs(n * 100).toFixed(digits) + '%';
}

function fmtAxis(n) {
  if (n == null || !Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

// Inflation is always a rise, so the +/− prefix fmtPct adds reads as noise.
function fmtPlain(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(digits) + '%';
}

function fmtMonth(t) {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function fmtDay(t) {
  if (t == null || !Number.isFinite(t)) return '—';
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Catmull-Rom-ish smoothing, matching the Net Worth chart.
function smoothPath(points) {
  if (points.length < 2) return '';
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    d += ` C ${p1.x + (p2.x - p0.x) / 6} ${p1.y + (p2.y - p0.y) / 6},`
      + ` ${p2.x - (p3.x - p1.x) / 6} ${p2.y - (p3.y - p1.y) / 6},`
      + ` ${p2.x} ${p2.y}`;
  }
  return d;
}

// ── Growth chart ────────────────────────────────────────────────────────
function GrowthChart({ path }) {
  const W = 880, H = 300;
  const pad = { top: 16, right: 16, bottom: 32, left: 66 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const chart = useMemo(() => {
    if (!path || path.length < 2) return null;
    const values = path.flatMap(p => [p.value, p.contributed]);
    // Both inputs can be cleared to zero, which would otherwise divide the
    // whole chart by zero and render NaN coordinates.
    const peak = Math.max(...values);
    if (!(peak > 0)) return null;
    const yMax = peak * 1.06;
    const tMin = path[0].t;
    const tSpan = Math.max(path[path.length - 1].t - tMin, 1);
    const xPos = (t) => pad.left + ((t - tMin) / tSpan) * innerW;
    const yPos = (v) => pad.top + (1 - v / yMax) * innerH;

    const ticks = Array.from({ length: 5 }, (_, i) => (yMax * i) / 4);
    const value = path.map(p => ({ x: xPos(p.t), y: yPos(p.value) }));
    const contributed = path.map(p => ({ x: xPos(p.t), y: yPos(p.contributed) }));
    const baseY = yPos(0);
    const area = `${smoothPath(value)} L ${value[value.length - 1].x} ${baseY} L ${value[0].x} ${baseY} Z`;

    const labelCount = Math.min(6, path.length);
    const step = (path.length - 1) / (labelCount - 1);
    const xLabels = Array.from({ length: labelCount }, (_, i) => {
      const p = path[Math.round(i * step)];
      return { t: p.t, x: xPos(p.t) };
    });

    return { ticks, value, contributed, area, xLabels, yPos };
  }, [path, innerH, innerW, pad.left, pad.top]);

  if (!chart) {
    return <div className={styles.emptyState}>Not enough history in this range to draw a chart.</div>;
  }

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="sp-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-secondary)" stopOpacity={0.3} />
          <stop offset="100%" stopColor="var(--color-secondary)" stopOpacity={0} />
        </linearGradient>
      </defs>

      {chart.ticks.map((v, i) => (
        <g key={i}>
          <line x1={pad.left} y1={chart.yPos(v)} x2={W - pad.right} y2={chart.yPos(v)}
            stroke="var(--color-text-tertiary)" strokeOpacity={0.18} strokeWidth={1} />
          <text x={pad.left - 8} y={chart.yPos(v) + 4} textAnchor="end" fontSize={11}
            fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">
            {fmtAxis(v)}
          </text>
        </g>
      ))}

      <path d={chart.area} fill="url(#sp-area)" />
      <path d={smoothPath(chart.contributed)} fill="none" stroke="var(--color-text-tertiary)"
        strokeWidth={1.5} strokeDasharray="4 4" />
      <path d={smoothPath(chart.value)} fill="none" stroke="var(--color-secondary)"
        strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" />

      {chart.xLabels.map((l, i) => (
        <text key={i} x={l.x} y={H - 10} textAnchor="middle" fontSize={11}
          fill="var(--color-text-secondary)" fontFamily="var(--font-headline)">
          {new Date(l.t).toLocaleDateString('en-US', { year: 'numeric', timeZone: 'UTC' })}
        </text>
      ))}
    </svg>
  );
}

// ── Calendar-year bars ──────────────────────────────────────────────────
function YearBars({ years }) {
  const W = 880, H = 200;
  const pad = { top: 20, right: 8, bottom: 26, left: 46 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const rows = years.filter(y => y.ret != null);
  if (!rows.length) return null;

  const max = Math.max(...rows.map(y => Math.abs(y.ret))) * 1.1;
  const zeroY = pad.top + (max / (max * 2)) * innerH;
  const bandW = innerW / rows.length;
  const barW = Math.max(6, bandW * 0.62);

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
      {[max, max / 2, 0, -max / 2, -max].map((v, i) => {
        const y = pad.top + ((max - v) / (max * 2)) * innerH;
        return (
          <g key={i}>
            <line x1={pad.left} y1={y} x2={W - pad.right} y2={y}
              stroke="var(--color-text-tertiary)" strokeOpacity={v === 0 ? 0.45 : 0.15} strokeWidth={1} />
            <text x={pad.left - 8} y={y + 4} textAnchor="end" fontSize={10}
              fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">
              {(v * 100).toFixed(0)}%
            </text>
          </g>
        );
      })}

      {rows.map((y, i) => {
        const cx = pad.left + bandW * i + bandW / 2;
        const h = Math.abs(y.ret) / (max * 2) * innerH;
        const top = y.ret >= 0 ? zeroY - h : zeroY;
        return (
          <g key={y.year}>
            <rect x={cx - barW / 2} y={top} width={barW} height={Math.max(h, 1)} rx={2}
              fill={y.ret >= 0 ? '#34d399' : '#f87171'} opacity={y.partial ? 0.5 : 1}>
              <title>{`${y.year}${y.partial ? ' (year to date)' : ''}: ${fmtPct(y.ret)}`}</title>
            </rect>
            {/* Only every other label below ~16 bars, else they collide. */}
            {(rows.length <= 16 || i % 2 === 0) && (
              <text x={cx} y={H - 8} textAnchor="middle" fontSize={9.5}
                fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">
                {`'${String(y.year).slice(2)}`}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The account's whole history: what went in and when, what it grew to, and
 * what the same deposits would have become in the index.
 *
 * The stepped line is money crossing the account boundary, so it moves only
 * when a deposit or withdrawal lands — the vertical distance between it and
 * the portfolio line is the gain at that moment. The last point equals the
 * headline figure exactly; it is the same calculation carried through time.
 */
function PortfolioHistoryChart({ history, events, benchLabel = 'Same deposits in the S&P' }) {
  const W = 880, H = 330;
  const pad = { top: 18, right: 16, bottom: 34, left: 70 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const chart = useMemo(() => {
    const pts = history || [];
    if (pts.length < 2) return null;
    const values = pts.flatMap(p => [p.value, p.contributed, p.bench].filter(Number.isFinite));
    if (!values.length) return null;
    const hi = Math.max(...values) * 1.06;
    const lo = Math.min(0, Math.min(...values));
    const tMin = pts[0].t;
    const tSpan = Math.max(pts[pts.length - 1].t - tMin, 1);
    const x = (t) => pad.left + ((t - tMin) / tSpan) * innerW;
    const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * innerH;
    const lineOf = (key) => {
      const usable = pts.filter(p => Number.isFinite(p[key]));
      if (usable.length < 2) return '';
      return `M ${usable.map(p => `${x(p.t)} ${y(p[key])}`).join(' L ')}`;
    };
    const valueLine = lineOf('value');
    const area = valueLine
      ? `${valueLine} L ${x(pts[pts.length - 1].t)} ${y(lo)} L ${x(pts[0].t)} ${y(lo)} Z`
      : '';
    const years = [];
    const from = new Date(tMin).getUTCFullYear();
    const to = new Date(pts[pts.length - 1].t).getUTCFullYear();
    for (let yr = from; yr <= to; yr++) {
      const t = Date.UTC(yr, 0, 1, 23, 59);
      if (t >= tMin && t <= pts[pts.length - 1].t) years.push({ yr, t });
    }
    return {
      x, y, ticks: ticksFor(lo, hi, 5), years, area,
      valueLine, contributedLine: lineOf('contributed'), benchLine: lineOf('bench'),
    };
  }, [history, innerH, innerW, pad.left, pad.top]);

  if (!chart) return <div className={styles.emptyState}>Not enough history to chart yet.</div>;

  const maxDeposit = Math.max(...(events || []).map(e => Math.abs(e.amount)), 1);

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="pf-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-secondary)" stopOpacity={0.22} />
          <stop offset="100%" stopColor="var(--color-secondary)" stopOpacity={0} />
        </linearGradient>
      </defs>

      {chart.ticks.map((v, i) => (
        <g key={i}>
          <line x1={pad.left} y1={chart.y(v)} x2={W - pad.right} y2={chart.y(v)}
            stroke="var(--color-text-tertiary)" strokeOpacity={0.15} strokeWidth={1} />
          <text x={pad.left - 8} y={chart.y(v) + 4} textAnchor="end" fontSize={10.5}
            fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">{fmtAxis(v)}</text>
        </g>
      ))}

      {chart.years.map(({ yr, t }) => (
        <text key={yr} x={chart.x(t)} y={H - 10} textAnchor="middle" fontSize={10.5}
          fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">{yr}</text>
      ))}

      {/* Each deposit as a tick from the baseline, height by size. */}
      {(events || []).map((e, i) => {
        const h = 6 + 16 * Math.sqrt(Math.abs(e.amount) / maxDeposit);
        const up = e.amount > 0;
        return (
          <line key={i} x1={chart.x(e.t)} y1={H - pad.bottom} x2={chart.x(e.t)} y2={H - pad.bottom - h}
            stroke={up ? 'var(--color-secondary)' : LOSE} strokeOpacity={0.5} strokeWidth={2}>
            <title>{`${fmtDay(e.t)} — ${up ? 'deposited' : 'withdrew'} ${fmt(Math.abs(e.amount))}`}</title>
          </line>
        );
      })}

      <path d={chart.area} fill="url(#pf-area)" />
      {chart.benchLine && (
        <path d={chart.benchLine} fill="none" stroke="var(--color-text-secondary)"
          strokeWidth={1.75} strokeDasharray="5 4" strokeOpacity={0.8} />
      )}
      <path d={chart.contributedLine} fill="none" stroke="var(--color-text-tertiary)"
        strokeWidth={1.5} strokeOpacity={0.9} />
      <path d={chart.valueLine} fill="none" stroke="var(--color-secondary)"
        strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />

      <title>{benchLabel}</title>
    </svg>
  );
}

/**
 * The daily snapshots written by the portfolio-snapshot cron. Read once; a
 * failure is not worth surfacing, since the page reconstructs history anyway
 * and simply loses the recorded precision.
 */
function useLoggedHistory() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let cancelled = false;
    getDoc(doc(db, 'portfolioHistory', 'daily'))
      .then(snap => {
        if (cancelled) return;
        setRows(snap.exists() ? (snap.data()?.rows || []) : []);
      })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, []);
  return rows;
}

/**
 * The reconstructed value of the account through time, with recorded daily
 * snapshots layered over the reconstruction wherever they exist.
 *
 * Shared by the benchmark tab's summary and the inflation tab, which need the
 * identical line — one in nominal dollars, one deflated — and would otherwise
 * be at risk of drifting into two slightly different histories.
 */
function useAccountHistory(series, portfolio) {
  const { trades, income, cashRows, quotes, lots } = portfolio;
  const loggedRows = useLoggedHistory();

  // Split-adjusted price series per ticker, rebuilt from the monthly closes
  // that ride along with the quotes request.
  const tickerSeries = useMemo(() => {
    if (!quotes) return null;
    const out = {};
    for (const [symbol, q] of Object.entries(quotes)) {
      if (!q || q.error || !Array.isArray(q.points) || !q.points.length) continue;
      out[symbol] = priceSeries(q.points);
    }
    return out;
  }, [quotes]);

  const history = useMemo(() => {
    if (!lots || !tickerSeries) return null;
    return buildPortfolioHistory({
      lots,
      tickerSeries,
      ledger: { trades, income, transfers: cashRows.transfers, otherCash: cashRows.otherCash },
      benchSeries: series,
      toT: series.lastT,
    });
  }, [lots, tickerSeries, trades, income, cashRows, series]);

  const events = useMemo(() => contributionEvents(cashRows.transfers), [cashRows]);

  // Recorded days win over reconstruction wherever they exist.
  const merged = useMemo(
    () => (history ? mergeLoggedHistory(history.points, loggedRows) : null),
    [history, loggedRows],
  );

  const shown = merged?.points?.length ? merged.points : history?.points || null;

  return { history, events, merged, shown };
}

/** The whole-account summary shown on the benchmark tab. */
function MyMoneySection({ series }) {
  const portfolio = usePortfolio(series);
  const { trades, cashRows, result, external } = portfolio;
  const { history, events, merged, shown: shownPoints } = useAccountHistory(series, portfolio);

  if (!trades.length) {
    return (
      <div className={styles.card}>
        <div className={styles.cardTitle}>Your own investing</div>
        <div className={styles.cardSub}>
          Import your trades on the <strong>My Trades</strong> tab and your real contributions
          and gains will be charted here against the index.
        </div>
      </div>
    );
  }

  if (!history || !history.points.length) {
    return (
      <div className={styles.card}>
        <div className={styles.cardTitle}>Your own investing</div>
        <div className={styles.emptyState}>Rebuilding your account history…</div>
      </div>
    );
  }

  // Without deposit rows there is no "what you put in", and the value line
  // would be the purchases alone — a large negative number. Say so instead.
  if (!cashRows.transfers.length) {
    return (
      <div className={styles.card}>
        <div className={styles.cardTitle}>Your own investing</div>
        <div className={styles.cardSub}>
          Your stored import has no deposit or withdrawal rows, so there is nothing to chart
          contributions against — those rows were only added to the importer recently.
          Re-import your activity export on the <strong>My Trades</strong> tab and choose
          <strong> Replace history</strong>, and this fills in.
        </div>
      </div>
    );
  }

  // A chart built from a fraction of the holdings isn't slightly low, it's
  // wrong. Refuse it rather than drawing a plausible-looking line.
  if (history.pricedFraction < 0.98) {
    return (
      <div className={styles.card}>
        <div className={styles.cardTitle}>Your own investing</div>
        <div className={styles.error}>
          {history.unpricedCost > 0 && history.pricedCost === 0
            ? 'No live prices came back, so the account cannot be valued right now.'
            : `Only ${Math.round(history.pricedFraction * 100)}% of your holdings could be priced, so this chart would misstate the account.`}
          {' '}Couldn&apos;t price {history.unpriced.join(', ')}. Reload the page to retry; if it
          persists the market data feed is unreachable.
        </div>
      </div>
    );
  }

  const shown = shownPoints;
  const last = shown[shown.length - 1];
  const gain = last.value - last.contributed;
  const vsBench = Number.isFinite(last.bench) ? last.value - last.bench : null;

  return (
    <div className={styles.chartCard}>
      <div className={styles.chartHeader}>
        <div>
          <div className={styles.cardTitle}>
            What you put in, and what it became
          </div>
          <div className={styles.cardSub}>
            Every deposit and withdrawal you made, the account&apos;s value through time, and
            the same deposits put into the index instead. The gap between the solid line and
            the flat one is your gain; the gap to the dashed line is how you did against the
            S&amp;P. Ticks along the bottom mark each transfer, sized by amount.
          </div>
        </div>
      </div>

      <div className={styles.statGrid} style={{ marginBottom: 18 }}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>You put in</div>
          <div className={styles.statValue}>{fmt(last.contributed)}</div>
          <div className={styles.statSub}>
            {external
              ? `${fmt(external.deposits)} deposited less ${fmt(external.withdrawals)} taken out`
              : `${events.length} transfers`}
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Worth today</div>
          <div className={styles.statValue}>{fmt(last.value)}</div>
          <div className={styles.statSub}>
            {fmtDay(last.t)}
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Total gain</div>
          <div className={`${styles.statValue} ${gain >= 0 ? styles.up : styles.down}`}>
            {fmtSigned(gain)}
          </div>
          <div className={styles.statSub}>
            {last.contributed > 0 ? fmtPct(last.value / last.contributed - 1) : '—'} on what you put in
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Same money in the S&amp;P</div>
          <div className={styles.statValue}>{Number.isFinite(last.bench) ? fmt(last.bench) : '—'}</div>
          <div className={styles.statSub}>identical deposits and dates</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Against the index</div>
          <div className={`${styles.statValue} ${vsBench >= 0 ? styles.up : styles.down}`}>
            {vsBench == null ? '—' : fmtSigned(vsBench)}
          </div>
          <div className={styles.statSub}>{vsBench >= 0 ? 'ahead' : 'behind'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Annualized</div>
          <div className={`${styles.statValue} ${external && external.yourIrr >= (external.benchIrr ?? 0) ? styles.up : styles.down}`}>
            {external ? fmtPct(external.yourIrr, 1) : '—'}
          </div>
          <div className={styles.statSub}>
            {external ? `S&P ${fmtPct(external.benchIrr, 1)} on the same cash` : 'money-weighted'}
          </div>
        </div>
      </div>

      <PortfolioHistoryChart history={shown} events={events} />

      <div className={styles.legend} style={{ justifyContent: 'center', marginTop: 6 }}>
        <span><span className={styles.legendDot} style={{ background: 'var(--color-secondary)' }} /> Your account</span>
        <span><span className={styles.legendDash} /> Same deposits in the S&amp;P</span>
        <span>
          <span className={styles.legendDot} style={{ background: 'var(--color-text-tertiary)' }} />
          Money you put in
        </span>
      </div>

      {history.unpriced.length > 0 && (
        <div className={styles.cardSub} style={{ marginTop: 10 }}>
          {history.unpriced.join(', ')} had no quoted price for part of this period — a share
          class that didn&apos;t exist yet, typically — so the line runs a little low in those
          early months. Today&apos;s value is unaffected.
        </div>
      )}

      <div className={styles.cardSub} style={{ marginTop: 10 }}>
        {merged?.loggedCount
          ? `${merged.loggedCount} day${merged.loggedCount === 1 ? '' : 's'} from ${fmtDay(merged.loggedFrom)} onwards are recorded daily and shown as they stood; earlier months are reconstructed from your trades and today's price history.`
          : 'History is reconstructed from your trades and today’s price history. A daily snapshot job records each day from now on, so this will firm up over time.'}
      </div>

      {result && (
        <div className={styles.cardSub} style={{ marginTop: 6 }}>
          Dividends are counted as the cash they were paid out as
          ({fmt(result.dividends.allocated)} to date), which is what happened — they were not
          reinvested. The index line reinvests its own, as the index does.
        </div>
      )}
    </div>
  );
}

// ── Benchmark tab ───────────────────────────────────────────────────────
function BenchmarkTab({ series, meta, cpi }) {
  const [rangeId, setRangeId] = useState('20y');
  // A fixed reference amount. The interactive upfront/monthly inputs are gone:
  // the question they answered ("what would I have?") is answered better by the
  // real contribution history charted below.
  const REFERENCE_AMOUNT = 10000;

  const range = RANGE_OPTIONS.find(o => o.id === rangeId) || RANGE_OPTIONS[2];
  const endT = series.lastT;
  const startT = range.years
    ? Math.max(series.firstT, endT - range.years * 365.25 * MS_DAY)
    : series.firstT;

  const path = useMemo(
    () => growthPath(series, { initial: REFERENCE_AMOUNT, monthly: 0, fromT: startT, toT: endT }),
    [series, startT, endT],
  );

  const stats = useMemo(() => {
    const total = returnBetween(series, startT, endT);
    // Keep only years fully or partly inside the selected range, and only
    // those with a measurable return (the first year of the series has no
    // prior year-end close to measure from).
    const inRange = calendarYearReturns(series).filter(y => (
      y.ret != null
      && Date.UTC(y.year, 11, 31, 12) >= startT
      && Date.UTC(y.year, 0, 1, 12) <= endT
    ));
    const complete = inRange.filter(y => !y.partial);
    const best = complete.length ? complete.reduce((a, b) => (b.ret > a.ret ? b : a)) : null;
    const worst = complete.length ? complete.reduce((a, b) => (b.ret < a.ret ? b : a)) : null;
    return {
      total,
      cagr: cagr(series, startT, endT),
      years: inRange,
      complete,
      best,
      worst,
      positivePct: complete.length ? complete.filter(y => y.ret > 0).length / complete.length : null,
      avgYear: complete.length ? complete.reduce((s, y) => s + y.ret, 0) / complete.length : null,
      drawdown: maxDrawdown(series),
    };
  }, [series, startT, endT]);

  const rolling = useMemo(
    () => [1, 3, 5, 10].map(y => rollingReturns(series, y)).filter(Boolean),
    [series],
  );

  // Inflation over the same window, so the headline can be read in what it
  // actually buys rather than what it says on the statement.
  const infl = useMemo(() => {
    if (!cpi?.series) return null;
    const total = inflationBetween(cpi.series, startT, endT);
    const annual = inflationCagr(cpi.series, startT, endT);
    return {
      total,
      annual,
      realTotal: realReturn(stats.total, total),
      realCagr: realReturn(stats.cagr, annual),
      // The same rolling-window machinery run over the price level, so each
      // horizon is compared against inflation across *its own* windows rather
      // than one long-run average that no individual hold experienced.
      byHorizon: Object.fromEntries(
        rolling
          .map(r => [r.years, rollingReturns(cpi.series, r.years)])
          .filter(([, w]) => w)
          .map(([years, w]) => [years, w.avg]),
      ),
    };
  }, [cpi, startT, endT, stats.total, stats.cagr, rolling]);

  const last = path.length ? path[path.length - 1] : null;

  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroLabel}>
          S&amp;P 500 · {range.years ? `Last ${range.years} years` : 'Full history'}
        </div>
        <div className={styles.heroValue}>{fmtPct(stats.cagr, 2)}<span className={styles.heroUnit}>/yr</span></div>
        <div className={styles.heroChange}>
          <span className={stats.total >= 0 ? styles.changeUp : styles.changeDown}>
            {fmtPct(stats.total)} total
          </span>
          {infl && (
            <span className={infl.realCagr >= 0 ? styles.changeUp : styles.changeDown}>
              {fmtPct(infl.realCagr, 2)}/yr after inflation
            </span>
          )}
          <span className={styles.changeRange}>
            · {fmtDay(startT)} → {fmtDay(endT)}
            {meta.totalReturn ? ' · dividends reinvested' : ' · price only, excludes dividends'}
          </span>
        </div>
      </div>

      <div className={styles.controls}>
        <div className={styles.pillGroup}>
          {RANGE_OPTIONS.map(o => (
            <button key={o.id} type="button"
              className={`${styles.pill} ${rangeId === o.id ? styles.pillActive : ''}`}
              onClick={() => setRangeId(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <MyMoneySection series={series} />

      <div className={styles.sectionHead}>
        For reference
        <span> — what the index alone did with a fixed amount</span>
      </div>

      <div className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div>
            <div className={styles.cardTitle}>
              {fmt(REFERENCE_AMOUNT)}
              {' → '}
              <span className={styles.emphasis}>{last ? fmt(last.value) : '—'}</span>
            </div>
            <div className={styles.cardSub}>
              {last ? `${fmt(last.contributed)} contributed · ${fmtSigned(last.value - last.contributed)} of growth` : ''}
            </div>
          </div>
          <div className={styles.legend}>
            <span><span className={styles.legendDot} style={{ background: 'var(--color-secondary)' }} /> Portfolio value</span>
            <span><span className={styles.legendDash} /> Money you put in</span>
          </div>
        </div>
        <GrowthChart path={path} />
      </div>

      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Annualized return</div>
          <div className={styles.statValue}>{fmtPct(stats.cagr, 2)}</div>
          <div className={styles.statSub}>Compound, {range.years ? `${range.years} years` : 'full history'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>After inflation</div>
          <div className={`${styles.statValue} ${infl && infl.realCagr >= 0 ? styles.up : styles.down}`}>
            {infl ? fmtPct(infl.realCagr, 2) : '—'}
          </div>
          <div className={styles.statSub}>
            {infl ? `prices rose ${fmtPlain(infl.annual, 2)}/yr over the same window` : 'CPI unavailable'}
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Average calendar year</div>
          <div className={styles.statValue}>{fmtPct(stats.avgYear)}</div>
          <div className={styles.statSub}>{stats.complete.length} complete years</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Years that finished up</div>
          <div className={styles.statValue}>
            {stats.positivePct == null ? '—' : `${Math.round(stats.positivePct * 100)}%`}
          </div>
          <div className={styles.statSub}>
            {stats.complete.filter(y => y.ret > 0).length} of {stats.complete.length}
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Best year</div>
          <div className={`${styles.statValue} ${styles.up}`}>{stats.best ? fmtPct(stats.best.ret) : '—'}</div>
          <div className={styles.statSub}>{stats.best ? stats.best.year : ''}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Worst year</div>
          <div className={`${styles.statValue} ${styles.down}`}>{stats.worst ? fmtPct(stats.worst.ret) : '—'}</div>
          <div className={styles.statSub}>{stats.worst ? stats.worst.year : ''}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Deepest drop</div>
          <div className={`${styles.statValue} ${styles.down}`}>
            {stats.drawdown ? fmtPct(stats.drawdown.drawdown) : '—'}
          </div>
          <div className={styles.statSub}>
            {stats.drawdown ? `${fmtDay(stats.drawdown.peakT)} → ${fmtDay(stats.drawdown.troughT)}` : ''}
          </div>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>What a typical hold returned</div>
        <div className={styles.cardSub}>
          Every possible start month across the full series, annualized. This is the honest answer
          to "what do I get if I invest" — a single start date flatters or punishes by luck alone.
          The last two columns run the same windows over the price level, so "real" is what the
          money actually bought after inflation took its cut.
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Holding period</th>
                <th className={styles.num}>Average</th>
                <th className={styles.num}>Median</th>
                <th className={styles.num}>Best</th>
                <th className={styles.num}>Worst</th>
                <th className={styles.num}>Inflation</th>
                <th className={styles.num}>Real average</th>
                <th className={styles.num}>Made money</th>
                <th className={styles.num}>Windows</th>
              </tr>
            </thead>
            <tbody>
              {rolling.map(r => {
                const inflAvg = infl?.byHorizon?.[r.years] ?? null;
                const real = realReturn(r.avg, inflAvg);
                return (
                  <tr key={r.years}>
                    <td><strong>{r.years} year{r.years > 1 ? 's' : ''}</strong></td>
                    <td className={styles.num}>{fmtPct(r.avg, 2)}</td>
                    <td className={styles.num}>{fmtPct(r.median, 2)}</td>
                    <td className={`${styles.num} ${styles.up}`} title={`Started ${fmtMonth(r.best.startT)}`}>
                      {fmtPct(r.best.annual, 2)}
                    </td>
                    <td className={`${styles.num} ${r.worst.annual < 0 ? styles.down : ''}`} title={`Started ${fmtMonth(r.worst.startT)}`}>
                      {fmtPct(r.worst.annual, 2)}
                    </td>
                    <td className={`${styles.num} ${styles.muted}`}>{fmtPlain(inflAvg, 2)}</td>
                    <td className={`${styles.num} ${real == null ? '' : real >= 0 ? styles.up : styles.down}`}>
                      <strong>{fmtPct(real, 2)}</strong>
                    </td>
                    <td className={styles.num}>{Math.round(r.positivePct * 100)}%</td>
                    <td className={`${styles.num} ${styles.muted}`}>{r.count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>Year by year</div>
        <div className={styles.cardSub}>
          Calendar-year total returns. The lighter bar is the current year to date.
        </div>
        <YearBars years={stats.years} />
      </div>
    </>
  );
}

// ── Trade charts ────────────────────────────────────────────────────────

const WIN = '#059669';
const LOSE = '#dc2626';

// Nice round tick step for a span, so axis labels land on 5%/10%/25%…
function tickStep(span, target = 6) {
  const rough = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  for (const mult of [1, 2, 2.5, 5, 10]) {
    if (mag * mult >= rough) return mag * mult;
  }
  return mag * 10;
}

function ticksFor(min, max, target = 6) {
  const step = tickStep(max - min || 1, target);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

/**
 * Every lot as a dot: your return against what the S&P did over that lot's
 * exact holding period. The diagonal is parity — above it you won, below it
 * the index did. Dot area is proportional to dollars invested, so a big miss
 * on a large position is visually louder than a rounding error on a small one.
 */
function LotScatter({ rows }) {
  const W = 880, H = 420;
  const pad = { top: 16, right: 20, bottom: 46, left: 62 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const chart = useMemo(() => {
    const pts = (rows || []).filter(r => Number.isFinite(r.ret) && Number.isFinite(r.benchRet));
    if (!pts.length) return null;

    const values = pts.flatMap(r => [r.ret, r.benchRet]);
    let lo = Math.min(...values, 0);
    let hi = Math.max(...values, 0);
    const padding = Math.max((hi - lo) * 0.08, 0.02);
    lo -= padding; hi += padding;

    const x = (v) => pad.left + ((v - lo) / (hi - lo)) * innerW;
    const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * innerH;

    const maxBasis = Math.max(...pts.map(r => r.costBasis), 1);
    const radius = (b) => 3 + 11 * Math.sqrt(Math.max(b, 0) / maxBasis);

    // Draw the largest first so small dots stay clickable on top.
    const ordered = [...pts].sort((a, b) => b.costBasis - a.costBasis);
    return { pts: ordered, lo, hi, x, y, radius, ticks: ticksFor(lo, hi) };
  }, [rows, innerH, innerW, pad.left, pad.top]);

  if (!chart) return <div className={styles.emptyState}>No priced lots to plot.</div>;

  const { lo, hi, x, y } = chart;

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
      {chart.ticks.map((t, i) => (
        <g key={`g${i}`}>
          <line x1={x(t)} y1={pad.top} x2={x(t)} y2={H - pad.bottom}
            stroke="var(--color-text-tertiary)" strokeOpacity={Math.abs(t) < 1e-9 ? 0.4 : 0.13} strokeWidth={1} />
          <line x1={pad.left} y1={y(t)} x2={W - pad.right} y2={y(t)}
            stroke="var(--color-text-tertiary)" strokeOpacity={Math.abs(t) < 1e-9 ? 0.4 : 0.13} strokeWidth={1} />
          <text x={x(t)} y={H - pad.bottom + 16} textAnchor="middle" fontSize={10.5}
            fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">
            {(t * 100).toFixed(0)}%
          </text>
          <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" fontSize={10.5}
            fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">
            {(t * 100).toFixed(0)}%
          </text>
        </g>
      ))}

      {/* Parity: your return equals the index's over the same window. */}
      <line x1={x(lo)} y1={y(lo)} x2={x(hi)} y2={y(hi)}
        stroke="var(--color-text-secondary)" strokeWidth={1.5} strokeDasharray="5 4" strokeOpacity={0.6} />
      <text x={x(hi) - 6} y={y(hi) + 16} textAnchor="end" fontSize={10.5}
        fill="var(--color-text-secondary)" fontFamily="var(--font-headline)" opacity={0.75}>
        matched the S&amp;P
      </text>

      {chart.pts.map((r, i) => (
        <circle key={i} cx={x(r.benchRet)} cy={y(r.ret)} r={chart.radius(r.costBasis)}
          fill={r.alpha >= 0 ? WIN : LOSE} fillOpacity={0.42}
          stroke={r.alpha >= 0 ? WIN : LOSE} strokeWidth={1.25}>
          <title>
            {`${r.symbol} — ${fmt(r.costBasis)} bought ${fmtDay(r.buyT)}`}
            {`\nYou ${fmtPct(r.ret)} · S&P ${fmtPct(r.benchRet)} · ${fmtSigned(r.alpha)}`}
            {`\n${r.open ? 'Still holding' : `Sold ${fmtDay(r.exitT)}`} · held ${r.heldDays >= 365 ? `${(r.heldDays / 365.25).toFixed(1)}y` : `${r.heldDays}d`}`}
          </title>
        </circle>
      ))}

      <text x={pad.left + innerW / 2} y={H - 6} textAnchor="middle" fontSize={11}
        fill="var(--color-text-secondary)" fontFamily="var(--font-headline)" fontWeight={600}>
        What the S&amp;P returned over the same dates →
      </text>
      <text x={14} y={pad.top + innerH / 2} textAnchor="middle" fontSize={11}
        fill="var(--color-text-secondary)" fontFamily="var(--font-headline)" fontWeight={600}
        transform={`rotate(-90 14 ${pad.top + innerH / 2})`}>
        ← Your return
      </text>
    </svg>
  );
}

/** Dollars gained or lost against the benchmark, per ticker. */
function AlphaBars({ symbols, onSelect, selected, benchName = 'S&P' }) {
  const rows = (symbols || []).filter(s => Number.isFinite(s.alpha));
  const W = 880;
  const rowH = 26;
  const pad = { top: 12, right: 90, bottom: 30, left: 62 };
  const H = pad.top + pad.bottom + rows.length * rowH;
  const innerW = W - pad.left - pad.right;

  if (!rows.length) return <div className={styles.emptyState}>Nothing to compare yet.</div>;

  const maxAbs = Math.max(...rows.map(s => Math.abs(s.alpha)), 1);
  const zeroX = pad.left + innerW / 2;
  const scale = (innerW / 2) / maxAbs;

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
      {ticksFor(-maxAbs, maxAbs, 5).map((t, i) => (
        <g key={i}>
          <line x1={zeroX + t * scale} y1={pad.top} x2={zeroX + t * scale} y2={H - pad.bottom}
            stroke="var(--color-text-tertiary)" strokeOpacity={Math.abs(t) < 1e-9 ? 0.45 : 0.12} strokeWidth={1} />
          <text x={zeroX + t * scale} y={H - pad.bottom + 16} textAnchor="middle" fontSize={10}
            fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">
            {fmtAxis(t)}
          </text>
        </g>
      ))}

      {rows.map((s, i) => {
        const cy = pad.top + i * rowH + rowH / 2;
        const w = Math.abs(s.alpha) * scale;
        const ahead = s.alpha >= 0;
        return (
          <g key={s.symbol} onClick={() => onSelect?.(s.symbol)}
            style={{ cursor: onSelect ? 'pointer' : 'default' }}>
            <rect x={0} y={cy - rowH / 2} width={W} height={rowH}
              fill={selected === s.symbol ? 'var(--color-secondary)' : 'transparent'}
              fillOpacity={selected === s.symbol ? 0.07 : 0} />
            <text x={pad.left - 10} y={cy + 4} textAnchor="end" fontSize={11.5} fontWeight={700}
              fill={selected === s.symbol ? 'var(--color-secondary)' : 'var(--color-text-primary)'}
              fontFamily="var(--font-headline)">
              {s.symbol}
            </text>
            <rect x={ahead ? zeroX : zeroX - w} y={cy - 8} width={Math.max(w, 1)} height={16} rx={2}
              fill={ahead ? WIN : LOSE} fillOpacity={0.82}>
              <title>{`${s.symbol}: ${fmt(s.invested)} invested · you ${fmtPct(s.ret)} vs ${benchName} ${fmtPct(s.benchRet)} · ${fmtSigned(s.alpha)}`}</title>
            </rect>
            <text x={ahead ? zeroX + w + 8 : zeroX - w - 8} y={cy + 4}
              textAnchor={ahead ? 'start' : 'end'} fontSize={11}
              fill={ahead ? WIN : LOSE} fontFamily="var(--font-headline)" fontWeight={600}>
              {fmtSigned(s.alpha)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * One bar per lot on a real time axis, spanning the dates it was held.
 * Answers "when did the good and bad decisions happen", which the scatter
 * deliberately throws away.
 */
function LotTimeline({ rows, nowT }) {
  const W = 880;
  const pad = { top: 14, right: 16, bottom: 30, left: 62 };

  const chart = useMemo(() => {
    const pts = (rows || []).filter(r => Number.isFinite(r.buyT) && Number.isFinite(r.alpha));
    if (!pts.length) return null;
    const ordered = [...pts].sort((a, b) => a.buyT - b.buyT);
    const tMin = ordered[0].buyT;
    const tMax = Math.max(nowT, ...ordered.map(r => r.exitT));
    const rowH = Math.max(3, Math.min(9, 460 / ordered.length));
    const maxAbs = Math.max(...ordered.map(r => Math.abs(r.alpha)), 1);
    return { ordered, tMin, tMax: tMax + (tMax - tMin) * 0.01, rowH, maxAbs };
  }, [rows, nowT]);

  if (!chart) return <div className={styles.emptyState}>Nothing to plot.</div>;

  const { ordered, tMin, tMax, rowH, maxAbs } = chart;
  const H = pad.top + pad.bottom + ordered.length * rowH;
  const innerW = W - pad.left - pad.right;
  const x = (t) => pad.left + ((t - tMin) / (tMax - tMin)) * innerW;

  // One tick per year boundary inside the range.
  const years = [];
  for (let y = new Date(tMin).getUTCFullYear(); y <= new Date(tMax).getUTCFullYear(); y++) {
    const t = Date.UTC(y, 0, 1, 12);
    if (t >= tMin && t <= tMax) years.push({ y, t });
  }

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
      {years.map(({ y, t }) => (
        <g key={y}>
          <line x1={x(t)} y1={pad.top} x2={x(t)} y2={H - pad.bottom}
            stroke="var(--color-text-tertiary)" strokeOpacity={0.16} strokeWidth={1} />
          <text x={x(t)} y={H - pad.bottom + 16} textAnchor="middle" fontSize={10.5}
            fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">{y}</text>
        </g>
      ))}

      {ordered.map((r, i) => {
        const yTop = pad.top + i * rowH;
        const x1 = x(r.buyT);
        const x2 = Math.max(x(r.exitT), x1 + 2);
        const ahead = r.alpha >= 0;
        // Faintest bars would vanish, so floor the opacity rather than scale
        // straight from zero.
        const strength = 0.32 + 0.68 * Math.sqrt(Math.abs(r.alpha) / maxAbs);
        return (
          <rect key={i} x={x1} y={yTop + rowH * 0.15} width={x2 - x1} height={rowH * 0.7} rx={1}
            fill={ahead ? WIN : LOSE} fillOpacity={strength}>
            <title>
              {`${r.symbol} — ${fmt(r.costBasis)} · ${fmtDay(r.buyT)} → ${r.open ? 'still held' : fmtDay(r.exitT)}`}
              {`\nYou ${fmtPct(r.ret)} · S&P ${fmtPct(r.benchRet)} · ${fmtSigned(r.alpha)}`}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

/**
 * One ticker's money against the same money in the index, through time.
 *
 * Both lines track the *dollars you actually committed*: each lot enters on
 * its purchase date at cost, compounds at its side's return, and freezes at
 * its realised value once sold. So the gap between the lines at any point is
 * the dollars that choice was ahead or behind right then — not an abstract
 * price ratio, which would ignore that most of this money arrived late.
 */
/**
 * Every purchase behind one ticker: when, how many shares, at what price.
 *
 * Where a split has since multiplied the shares, both readings are given —
 * what the confirmation said on the day, and what those shares became — since
 * the position's current value only reconciles against the second.
 */
function LotTable({ rows, symbol }) {
  const lots = useMemo(() => [...(rows || [])].sort((a, b) => a.buyT - b.buyT), [rows]);
  if (!lots.length) return null;

  const anySplit = lots.some(r => (r.splitFactor || 1) !== 1);
  const isBasket = lots.some(r => r.basket);
  const totalCost = lots.reduce((s, r) => s + r.costBasis, 0);
  const totalShares = lots.reduce((s, r) => s + (r.quantity || 0), 0);

  return (
    <div style={{ marginTop: 18 }}>
      <div className={styles.cardTitle}>Every purchase of {symbol}</div>
      <div className={styles.cardSub} style={{ marginBottom: 10 }}>
        Matched first-in-first-out, so a purchase that was partly sold appears twice — once for
        the shares that went and once for those still held.
        {anySplit && ' A split has since changed the share count; the as-bought figures are in brackets.'}
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Bought</th>
              <th className={styles.num}>Shares</th>
              <th className={styles.num}>Price paid</th>
              <th className={styles.num}>Cost</th>
              <th>Status</th>
              <th className={styles.num}>Value now</th>
              <th className={styles.num}>Return</th>
            </tr>
          </thead>
          <tbody>
            {lots.map((r, i) => {
              const factor = r.splitFactor || 1;
              const asBoughtShares = r.quantity != null ? r.quantity / factor : null;
              const pricePaid = asBoughtShares ? r.costBasis / asBoughtShares : null;
              const adjPrice = r.quantity ? r.costBasis / r.quantity : null;
              return (
                <tr key={i}>
                  <td>{fmtDay(r.buyT)}</td>
                  <td className={styles.num}>
                    {r.quantity == null
                      ? <span className={styles.muted}>basket</span>
                      : r.quantity.toLocaleString('en-US', { maximumFractionDigits: 6 })}
                    {factor !== 1 && (
                      <span className={styles.muted}>
                        {' '}({asBoughtShares.toLocaleString('en-US', { maximumFractionDigits: 6 })})
                      </span>
                    )}
                  </td>
                  <td className={styles.num}>
                    {pricePaid == null ? '—' : fmt(pricePaid, 2)}
                    {factor !== 1 && (
                      <span className={styles.muted}> ({fmt(adjPrice, 2)} adj)</span>
                    )}
                  </td>
                  <td className={styles.num}>{fmt(r.costBasis, 2)}</td>
                  <td>
                    {r.open
                      ? <span className={styles.tag}>held</span>
                      : `sold ${fmtDay(r.exitT)}`}
                  </td>
                  <td className={styles.num}>{fmt(r.value, 2)}</td>
                  <td className={`${styles.num} ${r.ret >= 0 ? styles.up : styles.down}`}>
                    {fmtPct(r.ret)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td><strong>{lots.length} lot{lots.length === 1 ? '' : 's'}</strong></td>
              <td className={styles.num}>
                <strong>
                  {isBasket ? '—' : totalShares.toLocaleString('en-US', { maximumFractionDigits: 6 })}
                </strong>
              </td>
              <td className={`${styles.num} ${styles.muted}`}>
                {!isBasket && totalShares > 0 ? `${fmt(totalCost / totalShares, 2)} avg` : ''}
              </td>
              <td className={styles.num}><strong>{fmt(totalCost, 2)}</strong></td>
              <td />
              <td className={styles.num}>
                <strong>{fmt(lots.reduce((s, r) => s + r.value, 0), 2)}</strong>
              </td>
              <td className={styles.num} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function TickerDetail({ symbol, rows, summary, income, series, cpi, onClose }) {
  const [loaded, setLoaded] = useState(null);
  // A position that came through a reorganisation spans several tickers whose
  // price histories don't line up — the ticker was renamed mid-life — so there
  // is no single series to chart it against.
  const basket = rows.find(r => r.basket)?.basket || null;

  // Annualized on this position's own cash flows: each purchase out, each
  // sale and the current market value in, dividends on their pay dates. The
  // index side runs the identical schedule, so the two are comparable even
  // though the money arrived in instalments over several years.
  const annual = useMemo(() => {
    const yours = [];
    const bench = [];
    for (const r of rows) {
      yours.push({ t: r.buyT, amount: -r.costBasis });
      yours.push({ t: r.exitT, amount: r.value });
      bench.push({ t: r.buyT, amount: -r.costBasis });
      bench.push({ t: r.exitT, amount: r.benchValue });
    }
    for (const d of income || []) yours.push({ t: d.t, amount: d.amount });
    return { you: xirr(yours), bench: xirr(bench) };
  }, [rows, income]);

  const firstBuyT = useMemo(() => Math.min(...rows.map(r => r.buyT)), [rows]);
  // Trades are anchored at UTC noon but the feed stamps each candle at market
  // open (13:30Z), so a series starting exactly on the first purchase has no
  // close at or before it — that lot would price as null and vanish from the
  // chart. Reach back a month so every lot has a quote behind it.
  const startISO = useMemo(() => toISODate(firstBuyT - 30 * MS_DAY), [firstBuyT]);

  useEffect(() => {
    if (basket) return undefined;
    let cancelled = false;
    fetchSeries(symbol, startISO, {
      onFresh: (fresh) => { if (!cancelled) setLoaded({ symbol, payload: fresh }); },
    })
      .then(({ payload }) => { if (!cancelled) setLoaded({ symbol, payload }); })
      .catch(err => { if (!cancelled) setLoaded({ symbol, error: err.message }); });
    return () => { cancelled = true; };
  }, [symbol, startISO, basket]);

  // Only trust a payload fetched for the ticker currently on screen.
  const ready = loaded?.symbol === symbol ? loaded : null;
  const tickerSeries = useMemo(
    () => (ready?.payload ? makeSeries(ready.payload.points) : null),
    [ready],
  );

  const path = useMemo(() => {
    if (!tickerSeries || !tickerSeries.length) return null;
    const endT = series.lastT;

    // ~180 evenly spaced trading days keeps the line smooth without shipping
    // every close into the DOM.
    const stamps = [];
    for (let i = 0; i < tickerSeries.length; i++) {
      const t = tickerSeries.times[i];
      if (t >= firstBuyT && t <= endT) stamps.push(t);
    }
    if (stamps.length < 2) return null;
    const maxPoints = 180;
    const step = Math.max(1, Math.floor(stamps.length / maxPoints));
    const sampled = stamps.filter((_, i) => i % step === 0);
    if (sampled[sampled.length - 1] !== stamps[stamps.length - 1]) {
      sampled.push(stamps[stamps.length - 1]);
    }

    // A lot with no quote behind its purchase date can't be charted. Rather
    // than dropping it from the line and quietly understating the position,
    // count it so the panel can say so.
    const unpriceable = rows.filter(r => !tickerSeries.closeAt(r.buyT));

    const out = [];
    for (const t of sampled) {
      let you = 0;
      let sp = 0;
      // The same dollars asked only to have held their value — the floor the
      // position has to clear before any of the gain is real.
      let infl = 0;
      for (const r of rows) {
        if (r.buyT > t) continue;
        if (!r.open && t >= r.exitT) {
          // Sold: the money stops compounding at what it actually realised.
          you += r.value;
          sp += r.benchValue;
          if (cpi) {
            const f = priceRatio(cpi, r.buyT, r.exitT);
            if (f) infl += r.costBasis * f;
          }
          continue;
        }
        const buyPx = tickerSeries.closeAt(r.buyT);
        const nowPx = tickerSeries.closeAt(t);
        const spBuy = series.closeAt(r.buyT);
        const spNow = series.closeAt(t);
        if (!buyPx || !nowPx || !spBuy || !spNow) continue;
        you += r.costBasis * (nowPx / buyPx);
        sp += r.costBasis * (spNow / spBuy);
        // Accumulated inside the same guard, so all three lines always
        // describe the identical set of lots.
        if (cpi) {
          const f = priceRatio(cpi, r.buyT, t);
          if (f) infl += r.costBasis * f;
        }
      }
      out.push({ t, you, sp, infl: cpi ? infl : null });
    }
    return out.length >= 2 ? { points: out, unpriceable } : null;
  }, [tickerSeries, rows, series, firstBuyT, cpi]);

  const W = 880, H = 300;
  const pad = { top: 16, right: 16, bottom: 32, left: 68 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const chart = useMemo(() => {
    if (!path) return null;
    const pts = path.points;
    const values = pts.flatMap(p => [p.you, p.sp, p.infl].filter(Number.isFinite));
    const hi = Math.max(...values) * 1.06;
    const lo = Math.min(Math.min(...values) * 0.94, 0);
    const tMin = pts[0].t;
    const tSpan = Math.max(pts[pts.length - 1].t - tMin, 1);
    const x = (t) => pad.left + ((t - tMin) / tSpan) * innerW;
    const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * innerH;
    const line = (key) => pts.map(p => `${x(p.t)} ${y(p[key])}`).join(' L ');
    const inflPts = pts.filter(p => Number.isFinite(p.infl));
    return {
      x, y, tMin, ticks: ticksFor(lo, hi, 5),
      youPath: `M ${line('you')}`,
      spPath: `M ${line('sp')}`,
      inflPath: inflPts.length >= 2
        ? `M ${inflPts.map(p => `${x(p.t)} ${y(p.infl)}`).join(' L ')}`
        : null,
      years: (() => {
        const out = [];
        const from = new Date(tMin).getUTCFullYear();
        const to = new Date(pts[pts.length - 1].t).getUTCFullYear();
        for (let yr = from; yr <= to; yr++) {
          const t = Date.UTC(yr, 0, 1, 12);
          if (t >= tMin && t <= pts[pts.length - 1].t) out.push({ yr, t });
        }
        return out;
      })(),
    };
  }, [path, innerH, innerW, pad.left, pad.top]);

  const last = path ? path.points[path.points.length - 1] : null;

  return (
    <div className={styles.card}>
      <div className={styles.cardHeaderRow}>
        <div>
          <div className={styles.cardTitle}>{symbol} against the S&amp;P 500</div>
          <div className={styles.cardSub}>
            Your money in {symbol} over time, against the same dollars put into the index on the
            same dates. Each purchase joins the line on the day you made it; a sale freezes that
            money at what it realised. Both sides reinvest dividends, so this is total return —
            the position line can sit slightly above the market value in the table for payers.
          </div>
        </div>
        {onClose && (
          <button type="button" className={styles.ghostBtn} onClick={onClose}>Close</button>
        )}
      </div>

      {summary && (
        <div className={styles.miniStats}>
          <span><b>{fmt(summary.invested)}</b> invested</span>
          <span><b>{fmt(summary.returned)}</b> now worth</span>
          {summary.income > 0 && <span><b>{fmt(summary.income)}</b> dividends</span>}
          <span className={summary.gain >= 0 ? styles.up : styles.down}>
            <b>{fmtSigned(summary.gain)}</b> made
          </span>
          <span className={summary.ret >= 0 ? styles.up : styles.down}><b>{fmtPct(summary.ret)}</b> total</span>
          <span className={annual.you >= (annual.bench ?? 0) ? styles.up : styles.down}>
            <b>{fmtPct(annual.you, 1)}</b> a year
          </span>
          <span><b>{fmtPct(annual.bench, 1)}</b> a year in the S&amp;P</span>
          <span className={summary.alpha >= 0 ? styles.up : styles.down}>
            <b>{fmtSigned(summary.alpha)}</b> vs index
          </span>
          <span className={styles.muted}>{summary.lots} lot{summary.lots === 1 ? '' : 's'}</span>
        </div>
      )}

      <LotTable rows={rows} symbol={symbol} />

      {basket && (
        <div className={styles.noteCard}>
          <div className={styles.noteTitle}>
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>merge</span>
            One position, several tickers
          </div>
          <div className={styles.cardSub} style={{ marginTop: 2 }}>
            This holding passed through a share exchange, so it is now{' '}
            {Object.entries(basket).map(([sym, qty], i, arr) => (
              <span key={sym}>
                <strong>{qty.toLocaleString('en-US', { maximumFractionDigits: 4 })} {sym}</strong>
                {i < arr.length - 2 ? ', ' : i === arr.length - 2 ? ' and ' : ''}
              </span>
            ))}. The totals above are exact — what you paid and what it is worth
            are both known. A single line chart isn&apos;t, because the ticker was renamed
            partway through and the two price histories don&apos;t join up.
          </div>
        </div>
      )}

      {!basket && ready?.error && (
        <div className={styles.error}>Couldn&apos;t load price history for {symbol}: {ready.error}</div>
      )}
      {!basket && !ready && <div className={styles.emptyState}>Loading {symbol} price history…</div>}
      {!basket && ready && !ready.error && !chart && (
        <div className={styles.emptyState}>Not enough overlapping history to chart {symbol}.</div>
      )}

      {path?.unpriceable?.length > 0 && (
        <div className={styles.error}>
          {path.unpriceable.length} lot{path.unpriceable.length === 1 ? '' : 's'} bought before
          this price history begins {path.unpriceable.length === 1 ? 'is' : 'are'} missing from the
          line, so it understates the position by about {fmt(path.unpriceable.reduce((a, r) => a + r.costBasis, 0))} of cost.
        </div>
      )}

      {chart && (
        <>
          <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
            {chart.ticks.map((v, i) => (
              <g key={i}>
                <line x1={pad.left} y1={chart.y(v)} x2={W - pad.right} y2={chart.y(v)}
                  stroke="var(--color-text-tertiary)" strokeOpacity={0.15} strokeWidth={1} />
                <text x={pad.left - 8} y={chart.y(v) + 4} textAnchor="end" fontSize={10.5}
                  fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">
                  {fmtAxis(v)}
                </text>
              </g>
            ))}

            {chart.years.map(({ yr, t }) => (
              <text key={yr} x={chart.x(t)} y={H - 10} textAnchor="middle" fontSize={10.5}
                fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">{yr}</text>
            ))}

            {/* Purchase dates — where new money entered both lines at once. */}
            {rows.map((r, i) => (
              <line key={`b${i}`} x1={chart.x(r.buyT)} y1={pad.top} x2={chart.x(r.buyT)} y2={H - pad.bottom}
                stroke="var(--color-secondary)" strokeOpacity={0.13} strokeWidth={1} />
            ))}

            {chart.inflPath && (
              <path d={chart.inflPath} fill="none" stroke="var(--color-warning)"
                strokeWidth={1.75} strokeDasharray="2 3" strokeOpacity={0.9} />
            )}
            <path d={chart.spPath} fill="none" stroke="var(--color-text-secondary)"
              strokeWidth={1.75} strokeDasharray="5 4" strokeOpacity={0.75} />
            <path d={chart.youPath} fill="none"
              stroke={last && last.you >= last.sp ? WIN : LOSE}
              strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
          </svg>

          <div className={styles.legend} style={{ justifyContent: 'center', marginTop: 4 }}>
            <span>
              <span className={styles.legendDot}
                style={{ background: last && last.you >= last.sp ? WIN : LOSE }} />
              {symbol} — {last ? fmt(last.you) : '—'}
            </span>
            <span><span className={styles.legendDash} /> Same money in the S&amp;P — {last ? fmt(last.sp) : '—'}</span>
            {chart.inflPath && (
              <span>
                <span className={styles.legendDash} style={{ borderTopColor: 'var(--color-warning)' }} />
                Just keeping pace with inflation — {last && Number.isFinite(last.infl) ? fmt(last.infl) : '—'}
              </span>
            )}
            <span className={styles.muted}>Vertical lines mark your purchases</span>
          </div>
        </>
      )}
    </div>
  );
}

function TradeCharts({ result, nowT, onSelect, selected }) {
  if (!result || !result.rows.length) {
    return <div className={styles.emptyState}>Import trades to see them charted.</div>;
  }

  const ahead = result.rows.filter(r => r.alpha >= 0);
  const behind = result.rows.filter(r => r.alpha < 0);

  return (
    <>
      <div className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div>
            <div className={styles.cardTitle}>Every lot against the S&amp;P</div>
            <div className={styles.cardSub}>
              Each dot is one lot, sized by how much you put in. The dashed line is parity —
              dots above it beat the index over that lot&apos;s exact holding period, dots below
              trailed it. {ahead.length} of {result.rows.length} lots are ahead.
            </div>
          </div>
          <div className={styles.legend}>
            <span><span className={styles.legendDot} style={{ background: WIN }} /> Beat the S&amp;P ({ahead.length})</span>
            <span><span className={styles.legendDot} style={{ background: LOSE }} /> Trailed it ({behind.length})</span>
          </div>
        </div>
        <LotScatter rows={result.rows} />
      </div>

      <div className={styles.chartCard}>
        <div className={styles.cardTitle}>Dollars ahead or behind, by ticker</div>
        <div className={styles.cardSub}>
          What each position gained or gave up versus putting the same money into the S&amp;P
          on the same dates. Click any ticker to chart it.
        </div>
        <AlphaBars symbols={result.symbols} onSelect={onSelect} selected={selected} />
      </div>

      <div className={styles.chartCard}>
        <div className={styles.cardTitle}>When each lot was held</div>
        <div className={styles.cardSub}>
          One bar per lot, spanning purchase to sale — bars running to the right edge are still
          open. Colour shows whether it beat the index; stronger colour means a bigger dollar gap.
        </div>
        <LotTimeline rows={result.rows} nowT={nowT} />
      </div>
    </>
  );
}

// ── Import wizard ───────────────────────────────────────────────────────
// Two steps on purpose. Committing straight from a paste means a reordered
// Excel column or a re-exported overlapping date range silently corrupts the
// history, and neither is visible after the fact — so the mapping and the
// duplicate count are shown before anything is written.
function ImportWizard({ existingTrades, existingActions, existingIncome, existingCash, onCommit, onCancel, compact }) {
  const fileRef = useRef(null);
  const [staged, setStaged] = useState(null); // { header, rows, source }
  const [mapping, setMapping] = useState(null);
  const [paste, setPaste] = useState('');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('append');
  const [keepDuplicates, setKeepDuplicates] = useState(false);

  const hasHistory = (existingTrades?.length || 0) > 0;

  const stage = useCallback((text, source) => {
    const { header, rows } = readTable(text);
    if (!rows.length) {
      setError('No data rows were found below the header line.');
      return;
    }
    setError(null);
    setStaged({ header, rows, source });
    setMapping(guessMapping(header));
  }, []);

  const handleFiles = useCallback(async (files) => {
    const file = files?.[0];
    if (!file) return;
    stage(await file.text(), file.name);
  }, [stage]);

  const missing = mapping ? missingFields(mapping) : [];

  const parsed = useMemo(
    () => (staged && mapping && !missing.length ? parseRows(staged.rows, mapping) : null),
    [staged, mapping, missing.length],
  );

  const merge = useMemo(
    () => (parsed ? mergeTrades(existingTrades || [], parsed.trades) : null),
    [parsed, existingTrades],
  );

  const commit = () => {
    if (!parsed) return;
    const incoming = keepDuplicates ? parsed.trades : merge.added;
    const trades = mode === 'replace'
      ? sortTrades([...parsed.trades])
      : sortTrades([...(existingTrades || []), ...incoming]);

    // Firestore caps a document at 1MB and this shares one with every other
    // setting, so keep the payload lean.
    const MAX_TRADES = 4000;
    const kept = trades.slice(-MAX_TRADES).map(t => ({
      date: t.date, symbol: t.symbol, side: t.side,
      quantity: t.quantity, price: t.price, amount: t.amount,
    }));

    onCommit({
      trades: kept,
      corporateActions: mode === 'replace'
        ? parsed.corporateActions
        : mergeCorporateActions(existingActions || [], parsed.corporateActions),
      income: mode === 'replace'
        ? parsed.income
        : mergeIncome(existingIncome || [], parsed.income),
      transfers: mode === 'replace'
        ? parsed.transfers
        : mergeCashRows(existingCash?.transfers || [], parsed.transfers),
      otherCash: mode === 'replace'
        ? parsed.otherCash
        : mergeCashRows(existingCash?.otherCash || [], parsed.otherCash),
      importedAt: new Date().toISOString(),
      source: staged.source || '',
      skipped: parsed.skipped,
      truncated: trades.length > MAX_TRADES ? trades.length - MAX_TRADES : 0,
      lastImport: {
        rows: staged.rows.length,
        added: mode === 'replace' ? parsed.trades.length : incoming.length,
        duplicates: keepDuplicates ? 0 : merge.duplicates.length,
        mode,
      },
    });
  };

  // ── Step 1: choose a source ───────────────────────────────────────────
  if (!staged) {
    return (
      <div className={`${styles.card} ${compact ? styles.compact : ''}`}>
        <div className={styles.cardHeaderRow}>
          <div className={styles.cardTitle}>
            {hasHistory ? 'Add more trades' : 'Import your Robinhood trades'}
          </div>
          {onCancel && (
            <button type="button" className={styles.ghostBtn} onClick={onCancel}>Cancel</button>
          )}
        </div>
        <div className={styles.cardSub}>
          In Robinhood: <strong>Account → Settings → Reports and statements → Reports →
          Generate an Activity report</strong>, pick a date range, then download the CSV.
          You can also copy the rows straight out of Excel — columns get mapped in the next
          step, and anything already in your history is detected and skipped. Nothing leaves
          your browser except the ticker symbols needed to price open positions.
        </div>

        <div
          className={`${styles.dropZone} ${dragging ? styles.dropZoneActive : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
          onClick={() => fileRef.current?.click()}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 30 }}>upload_file</span>
          <div>Drop the CSV here, or click to choose a file</div>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv" hidden
            onChange={e => { handleFiles(e.target.files); e.target.value = ''; }} />
        </div>

        <details className={styles.details} open={hasHistory}>
          <summary>…or paste rows from Excel</summary>
          <textarea
            className={styles.textarea}
            rows={6}
            value={paste}
            placeholder={'Activity Date\tProcess Date\tSettle Date\tInstrument\tDescription\tTrans Code\tQuantity\tPrice\tAmount\n…'}
            onChange={e => setPaste(e.target.value)}
          />
          <button type="button" className={styles.primaryBtn}
            disabled={!paste.trim()}
            onClick={() => { stage(paste, 'pasted rows'); setPaste(''); }}>
            Continue
          </button>
        </details>

        {error && <div className={styles.error}>{error}</div>}
      </div>
    );
  }

  // ── Step 2: map columns, review, commit ───────────────────────────────
  const columnLabel = (i) => {
    const raw = String(staged.header[i] ?? '').trim();
    return raw || `Column ${i + 1}`;
  };
  const preview = parsed ? parsed.trades.slice(0, 8) : [];
  const netNew = parsed ? (mode === 'replace' ? parsed.trades.length : (keepDuplicates ? parsed.trades.length : merge.added.length)) : 0;

  return (
    <div className={`${styles.card} ${compact ? styles.compact : ''}`}>
      <div className={styles.cardHeaderRow}>
        <div>
          <div className={styles.cardTitle}>Check the columns before importing</div>
          <div className={styles.cardSub}>
            {staged.rows.length.toLocaleString('en-US')} rows read from {staged.source || 'your paste'}.
          </div>
        </div>
        <button type="button" className={styles.ghostBtn}
          onClick={() => { setStaged(null); setMapping(null); setError(null); }}>
          Start over
        </button>
      </div>

      <div className={styles.mapGrid}>
        {FIELDS.map(f => (
          <label key={f.key} className={styles.mapField}>
            <span className={styles.mapLabel}>
              {f.label}
              {f.required && <em className={styles.req}>required</em>}
            </span>
            <select
              className={styles.select}
              value={mapping[f.key] ?? ''}
              onChange={e => setMapping(m => ({
                ...m,
                [f.key]: e.target.value === '' ? null : Number(e.target.value),
              }))}
            >
              <option value="">— not in this file —</option>
              {staged.header.map((_, i) => (
                <option key={i} value={i}>{columnLabel(i)}</option>
              ))}
            </select>
            <span className={styles.mapHint}>{f.hint}</span>
          </label>
        ))}
      </div>

      {missing.length > 0 && (
        <div className={styles.error}>
          Map {missing.join(', ')} to continue — those columns are needed to build a position.
        </div>
      )}

      {parsed && (
        <>
          <div className={styles.chips}>
            <span className={`${styles.chip} ${styles.chipGood}`}>
              {parsed.trades.length} buy/sell rows
            </span>
            {parsed.corporateActions.length > 0 && (
              <span className={styles.chip}>{parsed.corporateActions.length} corporate actions</span>
            )}
            {parsed.income.length > 0 && (
              <span className={`${styles.chip} ${styles.chipGood}`}>
                {parsed.income.length} dividend rows
              </span>
            )}
            {parsed.transfers.length > 0 && (
              <span className={`${styles.chip} ${styles.chipGood}`}>
                {parsed.transfers.length} deposits/withdrawals
              </span>
            )}
            {parsed.skipped.nonTrade > 0 && (
              <span className={styles.chip}>{parsed.skipped.nonTrade} non-trade rows</span>
            )}
            {parsed.skipped.options > 0 && (
              <span className={styles.chip}>{parsed.skipped.options} options rows</span>
            )}
            {parsed.skipped.unparseable > 0 && (
              <span className={`${styles.chip} ${styles.chipWarn}`}>
                {parsed.skipped.unparseable} unreadable rows
              </span>
            )}
          </div>

          {parsed.trades.length === 0 ? (
            <div className={styles.error}>
              No buy or sell rows came through with this mapping. Check that
              <strong> Action</strong> points at the column holding Buy/Sell.
            </div>
          ) : (
            <>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Date</th><th>Ticker</th><th>Action</th>
                      <th className={styles.num}>Quantity</th>
                      <th className={styles.num}>Price</th>
                      <th className={styles.num}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((t, i) => (
                      <tr key={i}>
                        <td>{t.date}</td>
                        <td><strong>{t.symbol}</strong></td>
                        <td>{t.side}</td>
                        <td className={styles.num}>{t.quantity.toLocaleString('en-US', { maximumFractionDigits: 6 })}</td>
                        <td className={styles.num}>{fmt(t.price, 2)}</td>
                        <td className={styles.num}>{fmt(t.amount, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {parsed.trades.length > preview.length && (
                <div className={styles.cardSub}>
                  Showing the {preview.length} oldest of {parsed.trades.length}.
                </div>
              )}
            </>
          )}

          {hasHistory && (
            <div className={styles.mergeBox}>
              <div className={styles.modeRow}>
                {[
                  { id: 'append', label: 'Add to history', hint: 'Keeps what you already have' },
                  { id: 'replace', label: 'Replace history', hint: 'Discards existing trades' },
                ].map(o => (
                  <button key={o.id} type="button"
                    className={`${styles.pill} ${mode === o.id ? styles.pillActive : ''}`}
                    onClick={() => setMode(o.id)} title={o.hint}>
                    {o.label}
                  </button>
                ))}
              </div>

              {mode === 'append' ? (
                <>
                  <div className={styles.mergeSummary}>
                    <strong>{merge.duplicates.length}</strong> of these rows are already in your
                    history and will be skipped; <strong>{merge.added.length}</strong> are new.
                  </div>
                  <label className={styles.checkbox}>
                    <input type="checkbox" checked={keepDuplicates}
                      onChange={e => setKeepDuplicates(e.target.checked)} />
                    <span>
                      Import the duplicates anyway — only if you really did trade the same
                      ticker, side, size and amount twice on the same day beyond what's stored.
                    </span>
                  </label>
                </>
              ) : (
                <div className={styles.mergeSummary}>
                  Your {existingTrades.length} stored trades will be discarded and replaced
                  with the {parsed.trades.length} rows above.
                </div>
              )}
            </div>
          )}

          <div className={styles.footerActions} style={{ marginTop: 16 }}>
            <button type="button" className={styles.primaryBtn} style={{ marginTop: 0 }}
              disabled={!parsed.trades.length || (mode === 'append' && netNew === 0)}
              onClick={commit}>
              {mode === 'replace'
                ? `Replace with ${parsed.trades.length} trades`
                : netNew === 0 ? 'Nothing new to import' : `Import ${netNew} new trades`}
            </button>
            {onCancel && (
              <button type="button" className={styles.ghostBtn} onClick={onCancel}>Cancel</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Trades tab ──────────────────────────────────────────────────────────
/**
 * Everything derived from the imported activity: hydrated ledgers, live
 * quotes, matched lots, the per-lot comparison and the external-cash headline.
 *
 * Lives in a hook so both tabs can read it without prop-drilling. Only one tab
 * mounts at a time and the quote fetch is cached, so there is no duplicated
 * work in practice.
 */
function usePortfolio(series) {
  const { robinhoodTrades } = useData();
  const [quoteResult, setQuoteResult] = useState(null);

  // Stored trades come back without their derived `t` timestamp — restore it
  // before anything sorts or prices on it.
  const trades = useMemo(() => hydrateTrades(robinhoodTrades?.trades), [robinhoodTrades]);
  const corporateActions = useMemo(() => hydrateActions(robinhoodTrades?.corporateActions), [robinhoodTrades]);
  const income = useMemo(() => hydrateIncome(robinhoodTrades?.income), [robinhoodTrades]);
  const cashRows = useMemo(() => ({
    transfers: hydrateCashRows(robinhoodTrades?.transfers),
    otherCash: hydrateCashRows(robinhoodTrades?.otherCash),
  }), [robinhoodTrades]);

  // Quotes are fetched for *every* traded ticker, not just the ones still
  // held, because the same request carries split history — and a closed lot
  // that straddled a split needs it to match buy shares against sell shares.
  // Keyed as a string so the effect doesn't re-run on an identical list.
  const quoteKey = useMemo(() => {
    // Reorg survivors (BN after a Brookfield-style exchange) never appear in a
    // trade row but still need a price to value the basket.
    const all = new Set(tradedSymbols(trades));
    for (const a of corporateActions) if (a.symbol) all.add(a.symbol);
    return [...all].sort().join(',');
  }, [trades, corporateActions]);
  const earliestTrade = useMemo(
    () => (trades.length ? trades.reduce((a, t) => (t.date < a ? t.date : a), trades[0].date) : null),
    [trades],
  );

  useEffect(() => {
    if (!quoteKey) return undefined;
    let cancelled = false;
    fetchQuotes(quoteKey.split(','), earliestTrade)
      // Per-symbol failures come back inside the result, so a rejection here
      // means the whole request died — record an empty set and let the
      // caveats panel report the unpriced lots.
      .catch(() => ({}))
      .then(q => { if (!cancelled) setQuoteResult({ key: quoteKey, quotes: q }); });
    return () => { cancelled = true; };
  }, [quoteKey, earliestTrade]);

  // Only trust quotes fetched for the current symbol list — otherwise a fresh
  // import would briefly be priced with the previous import's quotes.
  const quotes = quoteResult?.key === quoteKey ? quoteResult.quotes : null;
  const awaitingQuotes = quoteKey !== '' && quotes === null;

  // Split history keyed by symbol, in the shape buildLots expects. A symbol
  // present with an empty array means "the feed knows this ticker and it has
  // no splits" — distinct from absent, which falls back to the file's rows.
  const apiSplits = useMemo(() => {
    if (!quotes) return null;
    const out = {};
    for (const [symbol, q] of Object.entries(quotes)) {
      if (q && !q.error) out[symbol] = Array.isArray(q.splits) ? q.splits : [];
    }
    return out;
  }, [quotes]);

  const lots = useMemo(
    () => (trades.length && !awaitingQuotes ? buildLots(trades, corporateActions, apiSplits) : null),
    [trades, corporateActions, apiSplits, awaitingQuotes],
  );

  const result = useMemo(() => {
    if (!lots) return null;
    return benchmarkLots(lots, series, quotes || {}, series.lastT, income);
  }, [lots, series, quotes, income]);

  // The headline. Per-lot attribution can't be made airtight once dividends
  // are recycled into later buys, so the top-line number is measured on cash
  // that actually crossed the account boundary.
  const external = useMemo(() => {
    if (!result || !cashRows.transfers.length) return null;
    return externalCashComparison({
      transfers: cashRows.transfers,
      otherCash: cashRows.otherCash,
      trades,
      income,
      lotRows: result.rows,
      series,
      asOfT: series.lastT,
    });
  }, [result, cashRows, trades, income, series]);

  return {
    robinhoodTrades, trades, corporateActions, income, cashRows,
    quotes, awaitingQuotes, apiSplits, lots, result, external,
  };
}

// ── Real-return heat scale ──────────────────────────────────────────────
// The site's own status tokens, so the shading matches every other red and
// green on the page rather than introducing a third palette.
const TINT_LOSS = [186, 26, 26];   // --color-error
const TINT_FLAT = [232, 163, 23];  // --color-warning
const TINT_GAIN = [0, 150, 104];   // --color-success

/**
 * Background tint for a real return, on a red → amber → green ramp.
 *
 * Anchored at zero, not at the middle of the range. Zero real return is a
 * real thing — you exactly kept pace with inflation — and it is the only
 * defensible place to put the neutral colour. Scaling the ramp across the
 * range instead would paint the weakest position red however well it did,
 * which is colouring by rank rather than by value.
 *
 * The extremes on screen set how fast the colour saturates, so a portfolio
 * whose spread is narrow still uses the whole ramp.
 */
function realReturnTint(value, worst, best) {
  if (value == null || !Number.isFinite(value)) return undefined;
  const up = value >= 0;
  const extreme = up ? best : worst;
  const t = !Number.isFinite(extreme) || extreme === 0
    ? 0
    : Math.min(1, Math.abs(value / extreme));
  const to = up ? TINT_GAIN : TINT_LOSS;
  const rgb = TINT_FLAT.map((c, i) => Math.round(c + (to[i] - c) * t));
  // A tint, not a fill — the figure sits on top of this and has to stay
  // comfortably readable, which caps the alpha well below solid.
  return `rgba(${rgb.join(', ')}, ${(0.18 + 0.42 * t).toFixed(3)})`;
}

function TradesTab({ series, meta, cpi }) {
  const { setRobinhoodTrades } = useDataActions();
  const [showLots, setShowLots] = useState(false);
  const [reimporting, setReimporting] = useState(false);
  const [view, setView] = useState('summary');
  const [selected, setSelected] = useState(null);

  const {
    robinhoodTrades, trades, corporateActions, income, cashRows, quotes, lots, result, external,
  } = usePortfolio(series);

  // Same lots, measured against the price level instead of the index.
  const infl = useMemo(
    () => (result && cpi?.series ? inflationCompare(result, cpi.series) : null),
    [result, cpi],
  );
  const realCash = useMemo(() => {
    if (!external || !cpi?.series) return null;
    return realCashComparison({
      transfers: cashRows.transfers,
      cpi: cpi.series,
      ending: external.ending,
      asOfT: series.lastT,
    });
  }, [external, cpi, cashRows, series]);
  const inflBySymbol = useMemo(() => {
    const map = new Map();
    for (const s of infl?.symbols || []) map.set(s.symbol, s);
    return map;
  }, [infl]);

  // Ranked best to worst on what the money actually bought. Positions with no
  // CPI cover keep their benchmark ordering and sink to the bottom rather than
  // being ranked on a number that doesn't exist.
  const rankedSymbols = useMemo(() => {
    const rows = [...(result?.symbols || [])];
    return rows.sort((a, b) => {
      const ra = inflBySymbol.get(a.symbol)?.realRet;
      const rb = inflBySymbol.get(b.symbol)?.realRet;
      const aOk = ra != null && Number.isFinite(ra);
      const bOk = rb != null && Number.isFinite(rb);
      if (!aOk && !bOk) return b.alpha - a.alpha;
      if (!aOk) return 1;
      if (!bOk) return -1;
      return rb - ra;
    });
  }, [result, inflBySymbol]);

  // The ends of the ramp, taken from what's on screen.
  const realRange = useMemo(() => {
    const vals = (infl?.symbols || [])
      .map(s => s.realRet)
      .filter(v => v != null && Number.isFinite(v));
    if (!vals.length) return { worst: null, best: null };
    return { worst: Math.min(...vals, 0), best: Math.max(...vals, 0) };
  }, [infl]);

  const handleCommit = useCallback((payload) => {
    setRobinhoodTrades(payload);
    setReimporting(false);
  }, [setRobinhoodTrades]);

  if (!trades.length) {
    return (
      <ImportWizard
        existingTrades={trades}
        existingActions={corporateActions}
        existingIncome={income}
        existingCash={cashRows}
        onCommit={handleCommit}
      />
    );
  }

  const skipped = robinhoodTrades?.skipped || {};
  // Prefer the external-cash figure: it's the only one that can't double-count
  // a dividend which later funded a purchase.
  const headline = external || (result ? {
    alpha: result.totals.alpha, ret: result.totals.ret, benchRet: result.totals.benchRet,
    netTransfers: result.totals.invested,
  } : null);
  const beat = headline && headline.alpha >= 0;

  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroLabel}>
          {external ? 'Your money vs the S&P 500' : 'Your trades vs the S&P 500'}
        </div>
        {!result ? (
          <div className={styles.heroValue}>…</div>
        ) : result.totals.lots === 0 ? (
          <>
            <div className={styles.heroTitle}>Nothing comparable yet</div>
            <div className={styles.heroSubtitle}>
              None of the imported trades could be matched into lots the benchmark can price.
            </div>
          </>
        ) : (
          <>
            <div className={styles.heroValue}>
              {fmtSigned(headline.alpha)}
              <span className={styles.heroUnit}>{beat ? ' ahead' : ' behind'}</span>
            </div>
            <div className={styles.heroChange}>
              <span className={beat ? styles.changeUp : styles.changeDown}>
                You {fmtPct(headline.ret)} · S&amp;P {fmtPct(headline.benchRet)}
              </span>
              <span className={styles.changeRange}>
                {external
                  ? `· ${fmt(external.netTransfers)} of your own money, across ${external.transferCount} transfers`
                  : `· ${fmt(result.totals.invested)} invested across ${result.totals.lots} lots`}
              </span>
            </div>
          </>
        )}
      </div>

      {external && (
        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>You put in</div>
            <div className={styles.statValue}>{fmt(external.netTransfers)}</div>
            <div className={styles.statSub}>
              {fmt(external.deposits)} deposited less {fmt(external.withdrawals)} taken out
            </div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>It is now worth</div>
            <div className={styles.statValue}>{fmt(external.ending)}</div>
            <div className={styles.statSub}>
              {fmt(external.holdings)} in stock
              {Math.abs(external.cash) >= 1 && ` + ${fmt(external.cash)} cash`}
            </div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>The S&amp;P would have</div>
            <div className={styles.statValue}>{fmt(external.benchEnding)}</div>
            <div className={styles.statSub}>same deposits, same dates</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Your annualized</div>
            <div className={`${styles.statValue} ${external.yourIrr >= (external.benchIrr ?? 0) ? styles.up : styles.down}`}>
              {fmtPct(external.yourIrr, 1)}
            </div>
            <div className={styles.statSub}>money-weighted on your own cash</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>S&amp;P annualized</div>
            <div className={styles.statValue}>{fmtPct(external.benchIrr, 1)}</div>
            <div className={styles.statSub}>identical deposits</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Difference</div>
            <div className={`${styles.statValue} ${beat ? styles.up : styles.down}`}>
              {fmtSigned(external.alpha)}
            </div>
            <div className={styles.statSub}>dividends already inside both sides</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Inflation needs</div>
            <div className={styles.statValue}>{realCash ? fmt(realCash.inflatedIn) : '—'}</div>
            <div className={styles.statSub}>
              {realCash
                ? `what your ${fmt(realCash.nominalIn)} of deposits would cost today`
                : 'CPI unavailable'}
            </div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Real gain</div>
            <div className={`${styles.statValue} ${realCash && realCash.realGain >= 0 ? styles.up : styles.down}`}>
              {realCash ? fmtSigned(realCash.realGain) : '—'}
            </div>
            <div className={styles.statSub}>
              {realCash
                ? `${fmtPct(realCash.realIrr, 1)}/yr in real terms · ${realCash.beatInflation ? 'ahead of' : 'behind'} inflation`
                : 'purchasing power created'}
            </div>
          </div>
        </div>
      )}

      {external && (
        <div className={styles.card}>
          <div className={styles.cardTitle}>Why this is the number to trust</div>
          <div className={styles.cardSub}>
            It counts only cash that crossed your account boundary — {external.transferCount} deposits
            and withdrawals — against the ending value of everything you hold plus uninvested cash.
            Dividends never appear as a flow; they are simply part of what the account is worth
            today, exactly as the index&apos;s own dividends are already inside it. The per-ticker
            breakdown below attributes performance to individual picks, but it credits a dividend
            to the position that paid it <em>and</em> counts it again as cost basis if you later
            reinvested that cash by hand, so its total reads better than reality.
          </div>
        </div>
      )}

      {result && result.totals.lots > 0 && (
        <div className={styles.sectionHead}>
          Attribution by position
          <span> — which picks worked, credited per lot</span>
        </div>
      )}

      {result && result.totals.lots > 0 && (
        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>You turned</div>
            <div className={styles.statValue}>{fmt(result.totals.invested)}</div>
            <div className={styles.statSub}>
              into {fmt(result.totals.totalValue)}
              {result.totals.income > 0 && ` (${fmt(result.totals.returned)} held + ${fmt(result.totals.income)} paid out)`}
            </div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>The S&amp;P would have</div>
            <div className={styles.statValue}>{fmt(result.totals.benchReturned)}</div>
            <div className={styles.statSub}>same dollars, same dates</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Dividends received</div>
            <div className={`${styles.statValue} ${result.totals.income > 0 ? styles.up : ''}`}>
              {fmt(result.totals.income)}
            </div>
            <div className={styles.statSub}>
              worth {fmtPct(result.totals.ret - result.totals.priceRet)} of return
            </div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Your annualized</div>
            <div className={`${styles.statValue} ${result.yourIrr >= (result.benchIrr ?? 0) ? styles.up : styles.down}`}>
              {fmtPct(result.yourIrr, 1)}
            </div>
            <div className={styles.statSub}>money-weighted (XIRR)</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>S&amp;P annualized</div>
            <div className={styles.statValue}>{fmtPct(result.benchIrr, 1)}</div>
            <div className={styles.statSub}>identical cash flows</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Closed positions</div>
            <div className={`${styles.statValue} ${result.closedTotals.alpha >= 0 ? styles.up : styles.down}`}>
              {fmtSigned(result.closedTotals.alpha)}
            </div>
            <div className={styles.statSub}>
              {result.closedTotals.lots} lots · you {fmtPct(result.closedTotals.ret)} vs {fmtPct(result.closedTotals.benchRet)}
            </div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Still holding</div>
            <div className={`${styles.statValue} ${result.openTotals.alpha >= 0 ? styles.up : styles.down}`}>
              {fmtSigned(result.openTotals.alpha)}
            </div>
            <div className={styles.statSub}>
              {result.openTotals.lots} lots · you {fmtPct(result.openTotals.ret)} vs {fmtPct(result.openTotals.benchRet)}
            </div>
          </div>
        </div>
      )}

      {/* Everything the comparison does not cover, stated plainly. */}
      <Caveats
        result={result}
        lots={lots}
        skipped={skipped}
        truncated={robinhoodTrades?.truncated}
        quotes={quotes || {}}
        meta={meta}
        seriesFirstT={series.firstT}
      />

      {result && result.rows.length > 0 && (
        <div className={styles.subTabBar}>
          {[
            { id: 'summary', label: 'Summary' },
            { id: 'charts', label: 'Charts' },
          ].map(t => (
            <button key={t.id} type="button"
              className={`${styles.tab} ${view === t.id ? styles.tabActive : ''}`}
              onClick={() => setView(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {view === 'charts' && result && (
        <TradeCharts
          result={result}
          nowT={series.lastT}
          selected={selected}
          onSelect={(sym) => setSelected(selected === sym ? null : sym)}
        />
      )}

      {view === 'summary' && result && result.symbols.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardTitle}>By ticker</div>
          <div className={styles.cardSub}>
            Ranked best to worst on <strong>real return</strong> — what each position returned
            after inflation, which is the only version of the number you can spend. "S&amp;P" is
            what the same money would have done over the exact same holding periods, and
            "Inflation" is what it would have taken merely to stand still. Click a row to chart it
            against the index.
          </div>
          <div className={styles.cardSub} style={{ marginTop: 6 }}>
            The real return column is shaded{' '}
            <span className={styles.swatchInline} style={{ background: realReturnTint(-1, -1, 1) }} />
            red where purchasing power was destroyed,{' '}
            <span className={styles.swatchInline} style={{ background: realReturnTint(0, -1, 1) }} />
            amber where the money merely kept pace with prices, and{' '}
            <span className={styles.swatchInline} style={{ background: realReturnTint(1, -1, 1) }} />
            green where it genuinely got ahead. The shade is set by the figure itself, not by where
            a position places in the ranking.
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th className={styles.num}>Invested</th>
                  <th className={styles.num}>Now worth</th>
                  <th className={styles.num}>Dividends</th>
                  <th className={styles.num}>You</th>
                  <th className={styles.num}>S&amp;P</th>
                  <th className={styles.num}>Difference</th>
                  <th className={styles.num}>Inflation</th>
                  <th className={styles.num}>Real return</th>
                  <th className={styles.num}>Beat inflation by</th>
                  <th className={styles.num}>Lots</th>
                </tr>
              </thead>
              <tbody>
                {rankedSymbols.map(s => {
                  const real = inflBySymbol.get(s.symbol) || null;
                  return (
                    <tr key={s.symbol}
                      className={`${styles.clickRow} ${selected === s.symbol ? styles.clickRowActive : ''}`}
                      onClick={() => setSelected(selected === s.symbol ? null : s.symbol)}>
                      <td>
                        <strong>{s.symbol}</strong>
                        <span className="material-symbols-outlined" style={{ fontSize: 13, verticalAlign: 'middle', marginLeft: 4, opacity: 0.45 }}>
                          show_chart
                        </span>
                      </td>
                      <td className={styles.num}>{fmt(s.invested)}</td>
                      <td className={styles.num}>{fmt(s.returned)}</td>
                      <td className={`${styles.num} ${s.income > 0 ? styles.up : styles.muted}`}>
                        {s.income > 0 ? fmt(s.income) : '—'}
                      </td>
                      <td className={`${styles.num} ${s.ret >= 0 ? styles.up : styles.down}`}
                        title={s.income > 0 ? `${fmtPct(s.priceRet)} from price, ${fmtPct(s.ret - s.priceRet)} from dividends` : undefined}>
                        {fmtPct(s.ret)}
                      </td>
                      <td className={styles.num}>{fmtPct(s.benchRet)}</td>
                      <td className={`${styles.num} ${s.alpha >= 0 ? styles.up : styles.down}`}>
                        <strong>{fmtSigned(s.alpha)}</strong>
                      </td>
                      <td className={`${styles.num} ${styles.muted}`}
                        title={real ? `${fmt(s.invested)} needed to be ${fmt(real.inflValue)} just to stand still` : undefined}>
                        {real ? fmtPlain(real.inflRet) : '—'}
                      </td>
                      <td className={`${styles.num} ${styles.heat}`}
                        style={{ background: realReturnTint(real?.realRet, realRange.worst, realRange.best) }}>
                        {real ? fmtPct(real.realRet) : '—'}
                      </td>
                      <td className={`${styles.num} ${real == null ? '' : real.realGain >= 0 ? styles.up : styles.down}`}>
                        <strong>{real ? fmtSigned(real.realGain) : '—'}</strong>
                      </td>
                      <td className={`${styles.num} ${styles.muted}`}>
                        {s.closedLots > 0 && `${s.closedLots} closed`}
                        {s.closedLots > 0 && s.openLots > 0 && ', '}
                        {s.openLots > 0 && `${s.openLots} open`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td><strong>Total</strong></td>
                  <td className={styles.num}><strong>{fmt(result.totals.invested)}</strong></td>
                  <td className={styles.num}><strong>{fmt(result.totals.returned)}</strong></td>
                  <td className={`${styles.num} ${styles.up}`}><strong>{fmt(result.totals.income)}</strong></td>
                  <td className={`${styles.num} ${result.totals.ret >= 0 ? styles.up : styles.down}`}>
                    <strong>{fmtPct(result.totals.ret)}</strong>
                  </td>
                  <td className={styles.num}><strong>{fmtPct(result.totals.benchRet)}</strong></td>
                  <td className={`${styles.num} ${result.totals.alpha >= 0 ? styles.up : styles.down}`}>
                    <strong>{fmtSigned(result.totals.alpha)}</strong>
                  </td>
                  <td className={`${styles.num} ${styles.muted}`}>
                    <strong>{infl ? fmtPlain(infl.totals.inflRet) : '—'}</strong>
                  </td>
                  <td className={`${styles.num} ${styles.heat}`}
                    style={{ background: realReturnTint(infl?.totals?.realRet, realRange.worst, realRange.best) }}>
                    <strong>{infl ? fmtPct(infl.totals.realRet) : '—'}</strong>
                  </td>
                  <td className={`${styles.num} ${infl && infl.totals.realGain >= 0 ? styles.up : styles.down}`}>
                    <strong>{infl ? fmtSigned(infl.totals.realGain) : '—'}</strong>
                  </td>
                  <td className={`${styles.num} ${styles.muted}`}><strong>{result.totals.lots}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {selected && result && (
        <TickerDetail
          symbol={selected}
          rows={result.rows.filter(r => r.symbol === selected)}
          summary={result.symbols.find(x => x.symbol === selected)}
          income={income.filter(d => selected.split(' + ').includes(d.symbol))}
          series={series}
          onClose={() => setSelected(null)}
        />
      )}

      {view === 'summary' && result && result.rows.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardHeaderRow}>
            <div>
              <div className={styles.cardTitle}>Every lot</div>
              <div className={styles.cardSub}>
                Buys matched to sells first-in-first-out, the way a broker reports cost basis.
              </div>
            </div>
            <button type="button" className={styles.ghostBtn} onClick={() => setShowLots(v => !v)}>
              {showLots ? 'Hide' : `Show all ${result.rows.length}`}
            </button>
          </div>
          {showLots && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th className={styles.num}>Shares</th>
                    <th>Bought</th>
                    <th>Exited</th>
                    <th className={styles.num}>Held</th>
                    <th className={styles.num}>Cost</th>
                    <th className={styles.num}>Value</th>
                    <th className={styles.num}>Divs</th>
                    <th className={styles.num}>You</th>
                    <th className={styles.num}>S&amp;P</th>
                    <th className={styles.num}>Difference</th>
                    <th className={styles.num}>Inflation</th>
                    <th className={styles.num}>Real</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => {
                    const real = infl?.byRow?.get(r) || null;
                    return (
                    <tr key={i} className={styles.clickRow}
                      onClick={() => setSelected(r.symbol)}>
                      <td>
                        <strong>{r.symbol}</strong>
                        {r.open && <span className={styles.tag}>open</span>}
                      </td>
                      <td className={styles.num}>{r.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                      <td>{fmtDay(r.buyT)}</td>
                      <td>{r.open ? 'held' : fmtDay(r.exitT)}</td>
                      <td className={`${styles.num} ${styles.muted}`}>
                        {r.heldDays >= 365 ? `${(r.heldDays / 365.25).toFixed(1)}y` : `${r.heldDays}d`}
                      </td>
                      <td className={styles.num}>{fmt(r.costBasis, 2)}</td>
                      <td className={styles.num}>{fmt(r.value, 2)}</td>
                      <td className={`${styles.num} ${r.income > 0 ? styles.up : styles.muted}`}>
                        {r.income > 0 ? fmt(r.income, 2) : '—'}
                      </td>
                      <td className={`${styles.num} ${r.ret >= 0 ? styles.up : styles.down}`}>{fmtPct(r.ret)}</td>
                      <td className={styles.num}>{fmtPct(r.benchRet)}</td>
                      <td className={`${styles.num} ${r.alpha >= 0 ? styles.up : styles.down}`}>{fmtSigned(r.alpha)}</td>
                      <td className={`${styles.num} ${styles.muted}`}>{real ? fmtPlain(real.inflRet) : '—'}</td>
                      <td className={`${styles.num} ${real == null ? '' : real.realGain >= 0 ? styles.up : styles.down}`}
                        title={real ? `${fmtPct(real.realRet)} after inflation` : undefined}>
                        {real ? fmtSigned(real.realGain) : '—'}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className={styles.footerRow}>
        <span className={styles.muted}>
          {trades.length} trade rows
          {robinhoodTrades?.source ? ` from ${robinhoodTrades.source}` : ''}
          {robinhoodTrades?.importedAt ? ` · last import ${fmtDay(Date.parse(robinhoodTrades.importedAt))}` : ''}
          {robinhoodTrades?.lastImport?.duplicates
            ? ` (${robinhoodTrades.lastImport.added} added, ${robinhoodTrades.lastImport.duplicates} already held)`
            : ''}
        </span>
        <span className={styles.footerActions}>
          <button type="button" className={styles.ghostBtn} onClick={() => setReimporting(v => !v)}>
            {reimporting ? 'Cancel' : 'Add more trades'}
          </button>
          <button type="button" className={styles.dangerBtn}
            onClick={() => { if (confirm('Remove the imported trades?')) setRobinhoodTrades(null); }}>
            Clear trades
          </button>
        </span>
      </div>

      {reimporting && (
        <ImportWizard
          existingTrades={trades}
          existingActions={corporateActions}
          existingIncome={income}
          existingCash={cashRows}
          onCommit={handleCommit}
          onCancel={() => setReimporting(false)}
          compact
        />
      )}
    </>
  );
}

// Anything the headline number silently excludes gets said out loud — a
// benchmark comparison that hides its own gaps is worse than none.
function Caveats({ result, lots, skipped, truncated, quotes, meta, seriesFirstT }) {
  const notes = [];

  if (!meta.totalReturn) {
    notes.push(meta.warning || 'The benchmark is a price index, so it excludes dividends and understates the S&P by roughly 1.8%/yr.');
  }
  if (lots?.excludedSymbols?.length) {
    const list = lots.excludedSymbols.map(e => `${e.symbol} (${e.codes.join(', ')})`).join(', ');
    notes.push(`Excluded entirely: ${list}. A share exchange, spin-off or merger moved cost basis between tickers using fair-market values the export doesn't contain, so no honest return can be computed for them. Every other ticker is unaffected.`);
  }
  if (skipped.options) {
    notes.push(`${skipped.options} options row${skipped.options === 1 ? '' : 's'} excluded — contracts can't share a cost-basis queue with shares of the same underlying.`);
  }
  if (lots?.unmatchedSells?.length) {
    const shares = lots.unmatchedSells.reduce((s, u) => s + u.quantity, 0);
    const syms = [...new Set(lots.unmatchedSells.map(u => u.symbol))].join(', ');
    notes.push(`${shares.toLocaleString('en-US', { maximumFractionDigits: 2 })} shares sold with no matching buy in this file (${syms}) — excluded, since inventing a cost basis would distort every return above. Re-export with an earlier start date to include them.`);
  }
  if (result?.excluded.beforeSeries) {
    notes.push(`${result.excluded.beforeSeries} lot${result.excluded.beforeSeries === 1 ? '' : 's'} bought before ${fmtDay(seriesFirstT)} excluded — the benchmark series doesn't reach back that far.`);
  }
  if (result?.excluded.unpriced) {
    notes.push(`${result.excluded.unpriced} open lot${result.excluded.unpriced === 1 ? '' : 's'} excluded because no current price was available (${result.excluded.unpricedSymbols.join(', ')}) — likely delisted or renamed.`);
  }
  if (skipped.unparseable) {
    notes.push(`${skipped.unparseable} row${skipped.unparseable === 1 ? '' : 's'} skipped — the date, ticker or quantity couldn't be read.`);
  }
  if (truncated) {
    notes.push(`${truncated} of the oldest rows dropped to stay inside the sync size limit; the most recent 4,000 were kept.`);
  }
  const failedQuotes = Object.entries(quotes || {}).filter(([, q]) => q?.error);
  if (failedQuotes.length && !result?.excluded.unpriced) {
    notes.push(`Couldn't price: ${failedQuotes.map(([s]) => s).join(', ')}.`);
  }
  if (result?.dividends?.unallocated) {
    const syms = result.dividends.unallocatedSymbols.join(', ');
    notes.push(`${fmt(result.dividends.unallocated)} of dividends couldn't be matched to a holding (${syms}) — they were paid on shares bought before this file begins, so they're left out rather than credited to the wrong lot.`);
  }
  if (skipped.accountLevelIncome) {
    notes.push(`${skipped.accountLevelIncome} cash row${skipped.accountLevelIncome === 1 ? '' : 's'} with no ticker (interest and similar) aren't credited to any position.`);
  }
  if (skipped.nonTrade) {
    // Older imports stored these as [code, count] pairs.
    const codes = (skipped.nonTradeCodes || []).slice(0, 5)
      .map(r => (Array.isArray(r) ? `${r[0]} ×${r[1]}` : `${r.code} ×${r.count}`))
      .join(', ');
    notes.push(`${skipped.nonTrade} non-trade row${skipped.nonTrade === 1 ? '' : 's'} ignored${codes ? ` (${codes})` : ''} — deposits, withdrawals and subscription fees are cash movements, not investment return.`);
  }

  const splits = lots?.appliedSplits || [];

  if (!notes.length && !splits.length) return null;

  return (
    <>
      {splits.length > 0 && (
        <div className={styles.infoCard}>
          <div className={styles.noteTitle}>
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>call_split</span>
            Stock splits applied
          </div>
          <ul className={styles.noteList}>
            {splits.map((s, i) => (
              <li key={i}>
                <strong>{s.symbol}</strong> {formatRatio(s.factor)} on {s.date} —{' '}
                {s.sharesBefore.toLocaleString('en-US', { maximumFractionDigits: 4 })} shares became{' '}
                {s.sharesAfter.toLocaleString('en-US', { maximumFractionDigits: 4 })}.
                {s.source === 'feed' && ' Taken from live market data, so it counts even if it happened after your export ends.'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {notes.length > 0 && (
        <div className={styles.noteCard}>
          <div className={styles.noteTitle}>
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>info</span>
            What this comparison leaves out
          </div>
          <ul className={styles.noteList}>
            {notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}

// 6 → "6:1", 1.5 → "3:2". Falls back to a plain multiplier when the ratio
// isn't a tidy fraction.
function formatRatio(factor) {
  for (const denom of [1, 2, 3, 4, 5, 10]) {
    const num = factor * denom;
    if (Math.abs(num - Math.round(num)) < 1e-6) return `${Math.round(num)}:${denom}`;
  }
  return `${factor.toFixed(4)}×`;
}

// ── Inflation tab ───────────────────────────────────────────────────────
/**
 * Did the money grow faster than prices did?
 *
 * Every figure here is in *today's* dollars. A deposit made in 2016 is
 * restated at what it would cost to buy the same basket now, and the account's
 * value is what it is. The difference is real gain — the only kind you can
 * spend. Nominal returns flatter long holds precisely because the dollars that
 * went in were worth more than the ones coming out.
 */
function InflationTab({ series, cpi }) {
  const portfolio = usePortfolio(series);
  const { trades, cashRows, result, external } = portfolio;
  const { history, shown } = useAccountHistory(series, portfolio);
  const [selected, setSelected] = useState(null);

  const infl = useMemo(
    () => (result && cpi?.series ? inflationCompare(result, cpi.series) : null),
    [result, cpi],
  );

  const realCash = useMemo(() => {
    if (!external || !cpi?.series) return null;
    return realCashComparison({
      transfers: cashRows.transfers,
      cpi: cpi.series,
      ending: external.ending,
      asOfT: series.lastT,
    });
  }, [external, cpi, cashRows, series]);

  const realLine = useMemo(
    () => (shown && cpi?.series
      ? realHistory(shown, cashRows.transfers, cpi.series, series.lastT)
      : null),
    [shown, cashRows, cpi, series],
  );

  const years = useMemo(() => {
    if (!cpi?.series) return [];
    const indexYears = new Map(calendarYearReturns(series).map(y => [y.year, y]));
    return calendarYearInflation(cpi.series).map(y => ({
      ...y,
      index: indexYears.get(y.year)?.ret ?? null,
      real: realReturn(indexYears.get(y.year)?.ret ?? null, y.ret),
    })).reverse();
  }, [cpi, series]);

  const lag = cpi?.series ? cpiLagMonths(cpi.series, series.lastT) : null;

  if (!cpi) {
    return <div className={styles.emptyState}>Loading consumer price history…</div>;
  }

  if (cpi.error) {
    return (
      <div className={styles.card}>
        <div className={styles.cardTitle}>Consumer prices couldn&apos;t be loaded</div>
        <div className={styles.error}>
          {cpi.error} Everything on this tab is measured against the CPI-U series from the Bureau
          of Labor Statistics, so rather than show you a number built on a guess at inflation,
          it shows nothing. Reload to retry.
        </div>
      </div>
    );
  }

  const beat = realCash ? realCash.beatInflation : (infl ? infl.totals.realGain >= 0 : null);

  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroLabel}>Your money vs the cost of living</div>
        {!trades.length ? (
          <>
            <div className={styles.heroTitle}>Nothing imported yet</div>
            <div className={styles.heroSubtitle}>
              Import your trades on the <strong>My Trades</strong> tab and this measures every
              dollar you put in against what it would take to buy the same things today.
            </div>
          </>
        ) : !realCash && !infl ? (
          <div className={styles.heroValue}>…</div>
        ) : (
          <>
            <div className={styles.heroValue}>
              {fmtSigned(realCash ? realCash.realGain : infl.totals.realGain)}
              <span className={styles.heroUnit}>{beat ? ' of real gain' : ' of real loss'}</span>
            </div>
            <div className={styles.heroChange}>
              <span className={beat ? styles.changeUp : styles.changeDown}>
                {realCash
                  ? `${fmtPct(realCash.realIrr, 1)}/yr after inflation`
                  : `${fmtPct(infl.totals.realRet)} real`}
              </span>
              <span className={styles.changeRange}>
                {realCash
                  ? `· prices rose ${fmtPlain(realCash.inflationSinceFirst)} since your first deposit `
                    + `(${fmtPlain(realCash.inflationAnnual, 2)}/yr)`
                  : '· measured over each lot’s own holding period'}
              </span>
            </div>
          </>
        )}
      </div>

      {realCash && (
        <>
          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>You put in</div>
              <div className={styles.statValue}>{fmt(realCash.nominalIn)}</div>
              <div className={styles.statSub}>net of everything you took back out</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>In today&apos;s dollars</div>
              <div className={styles.statValue}>{fmt(realCash.inflatedIn)}</div>
              <div className={styles.statSub}>
                what those same deposits would cost you now
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Worth today</div>
              <div className={styles.statValue}>{fmt(realCash.ending)}</div>
              <div className={styles.statSub}>holdings plus uninvested cash</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Real gain</div>
              <div className={`${styles.statValue} ${realCash.realGain >= 0 ? styles.up : styles.down}`}>
                {fmtSigned(realCash.realGain)}
              </div>
              <div className={styles.statSub}>
                {fmtPct(realCash.realRet)} of genuine purchasing power
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Nominal gain</div>
              <div className={`${styles.statValue} ${realCash.ending >= realCash.nominalIn ? styles.up : styles.down}`}>
                {fmtSigned(realCash.ending - realCash.nominalIn)}
              </div>
              <div className={styles.statSub}>
                {fmtPct(realCash.nominalRet)} — {fmt(realCash.inflatedIn - realCash.nominalIn)} of
                it is inflation, not gain
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Real annualized</div>
              <div className={`${styles.statValue} ${realCash.realIrr >= 0 ? styles.up : styles.down}`}>
                {fmtPct(realCash.realIrr, 1)}
              </div>
              <div className={styles.statSub}>
                money-weighted, every flow deflated to today
              </div>
            </div>
          </div>

          <div className={realCash.beatInflation ? styles.infoCard : styles.noteCard}>
            <div className={styles.noteTitle}>
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
                {realCash.beatInflation ? 'trending_up' : 'trending_down'}
              </span>
              {realCash.beatInflation
                ? 'Your money grew faster than prices'
                : 'Your money did not keep up with prices'}
            </div>
            <div className={styles.cardSub} style={{ marginTop: 2 }}>
              You have put <strong>{fmt(realCash.nominalIn)}</strong> into this account. Because
              prices have risen {fmtPlain(realCash.inflationSinceFirst)} since your first deposit,
              those dollars would cost <strong>{fmt(realCash.inflatedIn)}</strong> to reproduce
              today — that is the line the account has to clear before a single dollar of the gain
              is real. It is worth <strong>{fmt(realCash.ending)}</strong>, which puts you{' '}
              <strong>{fmt(Math.abs(realCash.realGain))}</strong>{' '}
              {realCash.beatInflation ? 'ahead of' : 'short of'} standing still.
            </div>
          </div>
        </>
      )}

      {realLine && (
        <div className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <div>
              <div className={styles.cardTitle}>Everything in today&apos;s dollars</div>
              <div className={styles.cardSub}>
                Both lines are deflated, not just one: the account&apos;s value at each point is
                what that balance would buy now, and the flat line accumulates each deposit at
                what it would cost now. Where the solid line sits below the flat one, the account
                had lost purchasing power — even in the stretches where the nominal balance was
                climbing.
              </div>
            </div>
          </div>
          <PortfolioHistoryChart history={realLine} events={[]} />
          <div className={styles.legend} style={{ justifyContent: 'center', marginTop: 6 }}>
            <span>
              <span className={styles.legendDot} style={{ background: 'var(--color-secondary)' }} />
              Account value, in today&apos;s dollars
            </span>
            <span>
              <span className={styles.legendDot} style={{ background: 'var(--color-text-tertiary)' }} />
              What you put in, in today&apos;s dollars
            </span>
          </div>
        </div>
      )}

      {infl && (
        <>
          <div className={styles.sectionHead}>
            Attribution by position
            <span> — which picks actually created purchasing power</span>
          </div>

          <div className={styles.chartCard}>
            <div className={styles.cardTitle}>Dollars ahead of inflation, by ticker</div>
            <div className={styles.cardSub}>
              What each position is worth against what its cost basis would have to be worth just
              to have held its value. Bars to the left are positions that lost you buying power
              even where the nominal return was positive.
            </div>
            <AlphaBars
              benchName="inflation"
              symbols={infl.symbols.map(s => ({
                symbol: s.symbol,
                alpha: s.realGain,
                invested: s.invested,
                ret: s.ret,
                benchRet: s.inflRet,
              }))}
              onSelect={(sym) => setSelected(selected === sym ? null : sym)}
              selected={selected}
            />
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>By ticker, after inflation</div>
            <div className={styles.cardSub}>
              &quot;Needed to stand still&quot; is the cost basis carried forward at the price
              level over that position&apos;s own holding period. Anything above it is real.
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th className={styles.num}>Invested</th>
                    <th className={styles.num}>Now worth</th>
                    <th className={styles.num}>Needed to stand still</th>
                    <th className={styles.num}>Real gain</th>
                    <th className={styles.num}>Your return</th>
                    <th className={styles.num}>Inflation</th>
                    <th className={styles.num}>Real return</th>
                    <th className={styles.num}>Lots</th>
                  </tr>
                </thead>
                <tbody>
                  {infl.symbols.map(s => (
                    <tr key={s.symbol}
                      className={`${styles.clickRow} ${selected === s.symbol ? styles.clickRowActive : ''}`}
                      onClick={() => setSelected(selected === s.symbol ? null : s.symbol)}>
                      <td><strong>{s.symbol}</strong></td>
                      <td className={styles.num}>{fmt(s.invested)}</td>
                      <td className={styles.num}>{fmt(s.totalValue)}</td>
                      <td className={`${styles.num} ${styles.muted}`}>{fmt(s.inflValue)}</td>
                      <td className={`${styles.num} ${s.realGain >= 0 ? styles.up : styles.down}`}>
                        <strong>{fmtSigned(s.realGain)}</strong>
                      </td>
                      <td className={`${styles.num} ${s.ret >= 0 ? styles.up : styles.down}`}>
                        {fmtPct(s.ret)}
                      </td>
                      <td className={`${styles.num} ${styles.muted}`}>{fmtPlain(s.inflRet)}</td>
                      <td className={`${styles.num} ${s.realRet >= 0 ? styles.up : styles.down}`}>
                        {fmtPct(s.realRet)}
                      </td>
                      <td className={`${styles.num} ${styles.muted}`}>{s.lots}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td><strong>Total</strong></td>
                    <td className={styles.num}><strong>{fmt(infl.totals.invested)}</strong></td>
                    <td className={styles.num}><strong>{fmt(infl.totals.totalValue)}</strong></td>
                    <td className={`${styles.num} ${styles.muted}`}><strong>{fmt(infl.totals.inflValue)}</strong></td>
                    <td className={`${styles.num} ${infl.totals.realGain >= 0 ? styles.up : styles.down}`}>
                      <strong>{fmtSigned(infl.totals.realGain)}</strong>
                    </td>
                    <td className={`${styles.num} ${infl.totals.ret >= 0 ? styles.up : styles.down}`}>
                      <strong>{fmtPct(infl.totals.ret)}</strong>
                    </td>
                    <td className={`${styles.num} ${styles.muted}`}><strong>{fmtPlain(infl.totals.inflRet)}</strong></td>
                    <td className={`${styles.num} ${infl.totals.realRet >= 0 ? styles.up : styles.down}`}>
                      <strong>{fmtPct(infl.totals.realRet)}</strong>
                    </td>
                    <td className={`${styles.num} ${styles.muted}`}><strong>{infl.totals.lots}</strong></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {infl.excluded.lots > 0 && (
              <div className={styles.cardSub} style={{ marginTop: 10 }}>
                {infl.excluded.lots} lot{infl.excluded.lots === 1 ? '' : 's'} covering{' '}
                {fmt(infl.excluded.cost)} of cost fall outside the published CPI range and are left
                out of this table rather than measured against a price level that doesn&apos;t exist.
              </div>
            )}
          </div>
        </>
      )}

      <div className={styles.card}>
        <div className={styles.cardTitle}>Year by year</div>
        <div className={styles.cardSub}>
          Calendar-year inflation against the S&amp;P 500&apos;s calendar-year total return, and
          what was left over. Measured December to December on both sides.
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Year</th>
                <th className={styles.num}>Inflation</th>
                <th className={styles.num}>S&amp;P 500</th>
                <th className={styles.num}>Real</th>
              </tr>
            </thead>
            <tbody>
              {years.map(y => (
                <tr key={y.year}>
                  <td>
                    <strong>{y.year}</strong>
                    {y.partial && <span className={styles.tag}>to date</span>}
                  </td>
                  <td className={styles.num}>{fmtPlain(y.ret, 2)}</td>
                  <td className={`${styles.num} ${y.index == null ? styles.muted : y.index >= 0 ? styles.up : styles.down}`}>
                    {fmtPct(y.index, 2)}
                  </td>
                  <td className={`${styles.num} ${y.real == null ? styles.muted : y.real >= 0 ? styles.up : styles.down}`}>
                    <strong>{fmtPct(y.real, 2)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={styles.noteCard}>
        <div className={styles.noteTitle}>
          <span className="material-symbols-outlined" style={{ fontSize: 17 }}>info</span>
          How inflation is measured here
        </div>
        <ul className={styles.noteList}>
          <li>
            {cpi.label || 'CPI-U'} from the Bureau of Labor Statistics, series {cpi.seriesId}. Not
            seasonally adjusted, because the question is what a dollar from a given month buys,
            not what forecasters need smoothed.
          </li>
          <li>
            The newest reading is {cpi.latest ? `${cpi.latest.year}-${String(cpi.latest.month).padStart(2, '0')}` : 'unknown'},
            {lag > 0
              ? ` about ${lag} month${lag === 1 ? '' : 's'} behind today — the BLS publishes a month in the middle of the next one, so the most recent inflation is not in these numbers yet and real returns here run very slightly high.`
              : ' current.'}
          </li>
          <li>
            CPI is a national basket. Your own inflation rate depends on where you live and what
            you buy; someone with a fixed mortgage and a short commute has experienced markedly
            less than this, and a renter markedly more.
          </li>
          <li>
            Nothing here is after tax. The tax you would owe on selling is on the{' '}
            <strong>Tax on Selling</strong> tab, and it is charged on the nominal gain — you are
            taxed on the inflation too.
          </li>
          {cpi.missingMonths > 0 && (
            <li>
              {cpi.missingMonths} month{cpi.missingMonths === 1 ? '' : 's'} in the range{' '}
              {cpi.missingMonths === 1 ? 'was' : 'were'} never published — the 2025 funding lapse
              cost October — so a date landing in the gap uses the last reading before it.
            </li>
          )}
        </ul>
      </div>

      {!history && trades.length > 0 && (
        <div className={styles.emptyState}>Rebuilding your account history…</div>
      )}
    </>
  );
}

// ── Tax tab ─────────────────────────────────────────────────────────────

// Filing status and income are the two inputs the answer swings hardest on,
// and re-entering them on every visit would make the tab useless. They stay in
// this browser rather than in the synced settings document — they are answers
// about a tax return, and nothing else on the site needs them.
const TAX_PREFS_KEY = 'stockTaxPrefs:v1';

function loadTaxPrefs() {
  try { return JSON.parse(localStorage.getItem(TAX_PREFS_KEY)) || {}; }
  catch { return {}; }
}

function saveTaxPrefs(prefs) {
  try { localStorage.setItem(TAX_PREFS_KEY, JSON.stringify(prefs)); }
  catch { /* private mode — the inputs just won't persist */ }
}

/**
 * The tax situation, shared by every tab that needs it.
 *
 * One store and one hook, so the single-stock tab and the whole-portfolio tab
 * can never be quoting bills computed from different incomes.
 */
function useTaxPrefs() {
  const [prefs, setPrefsState] = useState(loadTaxPrefs);

  const setPrefs = useCallback((patch) => {
    setPrefsState(prev => {
      const next = { ...prev, ...patch };
      saveTaxPrefs(next);
      return next;
    });
  }, []);

  const num = (v, strip) => Number(String(v ?? '').replace(strip, '')) || 0;
  const status = prefs.status || 'single';

  // Ask for the number people actually know. "Taxable income after deductions"
  // is the figure the brackets need, but almost nobody has it to hand, and a
  // question that can't be answered gets left blank — which lands the whole
  // gain in the 0% band and quotes a bill of nothing.
  const incomeIsGross = prefs.incomeIsGross !== false;
  const enteredIncome = Math.max(0, num(prefs.income, /[$,\s]/g));
  const deduction = STANDARD_DEDUCTION[status] || 0;

  return {
    prefs,
    setPrefs,
    status,
    incomeIsGross,
    enteredIncome,
    deduction,
    otherIncome: incomeIsGross
      ? Math.max(0, enteredIncome - deduction)
      : enteredIncome,
    // Capped at 20% — above every US state rate, and a typo of "50" for a
    // percentage shouldn't silently produce an absurd bill.
    stateRate: Math.max(0, Math.min(0.2, num(prefs.stateRate, /[%\s]/g) / 100)),
    includeNiit: prefs.includeNiit !== false,
    includeRealized: prefs.includeRealized !== false,
    // Whether this money is ever sold again. Stored rather than held in a
    // component so the setup dialog can answer it once and the projection
    // still remembers on the next visit.
    forever: prefs.forever === true,
    setupDone: prefs.setupDone === true,
    stateCode: prefs.stateCode || '',
    // How long the money is expected to be held before it is sold. Drives the
    // headline break-even and the comparison table, so the projection is
    // reported over the horizon you actually have rather than a stock ten.
    sellYears: HORIZONS.includes(prefs.sellYears) ? prefs.sellYears : 10,
  };
}

/**
 * Pick a state and prefill its rate, or type one directly.
 *
 * The prefilled figure is the state's top marginal income rate, which is what
 * most states apply to gains — but a graduated state's top bracket is not most
 * people's rate, and a dozen states treat capital gains specially. Both facts
 * are said next to the number rather than buried, and the box stays editable.
 */
function StatePicker({ prefs, setPrefs, stateCode }) {
  const picked = findState(stateCode);
  return (
    <>
      <div className={styles.inputRow}>
        <label className={styles.inputField} style={{ flex: '1 1 220px' }}>
          <span>Your state</span>
          <select className={styles.select} value={stateCode}
            onChange={(e) => {
              const next = findState(e.target.value);
              setPrefs({
                stateCode: e.target.value,
                stateRate: next ? String(+(next.rate * 100).toFixed(2)) : '',
              });
            }}>
            <option value="">— choose a state —</option>
            {STATES.map(s => (
              <option key={s.code} value={s.code}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className={styles.inputField}>
          <span>Rate on gains</span>
          <input type="text" inputMode="decimal" placeholder="0"
            value={prefs.stateRate ?? ''}
            onChange={e => setPrefs({ stateRate: e.target.value })} />
        </label>
      </div>
      {picked && (
        <div className={styles.stepHint} style={{ marginTop: 8, marginBottom: 0 }}>
          {picked.note
            ? <><strong>{picked.name}:</strong> {picked.note}</>
            : <><strong>{picked.name}</strong> applies its income tax rate to capital gains.</>}
          {' '}Figures are for the {STATE_TAX_AS_OF} and are a starting point, not your return —
          override the rate if you know better.
        </div>
      )}
    </>
  );
}

function TaxSituationInputs({
  prefs, setPrefs, status, otherIncome, incomeIsGross, enteredIncome, deduction,
  stateCode, children,
}) {
  // Long-term gains stack on top of ordinary income, so on a modest income a
  // large gain can land entirely in the 0% band and the estimate comes out at
  // nothing. That is a real answer and a genuinely useful one — but it is
  // indistinguishable from a broken calculator unless the headroom is stated,
  // so state it.
  const zeroBandCeiling = LTCG_BRACKETS[status]?.[0]?.[0];
  const zeroRoom = Math.max(0, (zeroBandCeiling ?? 0) - (otherIncome || 0));

  return (
    <>
      <div className={styles.inputRow}>
        <label className={styles.inputField}>
          <span>Filing status</span>
          <select className={styles.select} value={status}
            onChange={e => setPrefs({ status: e.target.value })}>
            {FILING_STATUSES.map(f => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
        </label>
        <label className={styles.inputField}>
          <span>{incomeIsGross ? 'Your pay, before tax' : 'Taxable income'}</span>
          <input type="text" inputMode="numeric" placeholder="0"
            value={prefs.income ?? ''}
            onChange={e => setPrefs({ income: e.target.value })} />
        </label>
      </div>

      <StatePicker prefs={prefs} setPrefs={setPrefs} stateCode={stateCode} />

      {/* pillGroup, not modeRow — modeRow's track is the same white as a card,
          so on this surface the control would be invisible. */}
      <div className={styles.pillGroup} style={{ marginTop: 12 }}>
        {[
          { gross: true, label: 'That\'s my gross pay', hint: 'The deduction is taken off for you' },
          { gross: false, label: 'That\'s my taxable income', hint: '1040 line 15 — already net of deductions' },
        ].map(o => (
          <button key={String(o.gross)} type="button" title={o.hint}
            className={`${styles.pill} ${incomeIsGross === o.gross ? styles.pillActive : ''}`}
            onClick={() => setPrefs({ incomeIsGross: o.gross })}>
            {o.label}
          </button>
        ))}
      </div>

      <div className={styles.cardSub} style={{ marginTop: 10 }}>
        {incomeIsGross ? (
          <>
            The brackets apply to income <em>after</em> deductions, so the{' '}
            {TAX_YEAR} standard deduction of {fmt(deduction)} for{' '}
            {FILING_STATUSES.find(f => f.id === status)?.label.toLowerCase()} comes off what you
            enter{enteredIncome > 0 && (
              <>
                : <strong>{fmt(enteredIncome)} − {fmt(deduction)} = {fmt(otherIncome)}</strong> of
                taxable income
              </>
            )}. That is an approximation — a 401(k) or HSA contribution lowers it further, and
            itemising or income beyond your salary moves it either way. If you know the real
            figure, switch to <strong>taxable income</strong> and enter it directly.
          </>
        ) : (
          <>
            Line 15 of a 1040 — your income after deductions, excluding these gains. Switch to{' '}
            <strong>gross pay</strong> if you would rather give your salary and have the{' '}
            {fmt(deduction)} standard deduction taken off for you.
          </>
        )}
      </div>
      <label className={styles.checkbox}>
        <input type="checkbox" checked={prefs.includeNiit !== false}
          onChange={e => setPrefs({ includeNiit: e.target.checked })} />
        <span>
          Apply the {fmtPlain(NIIT_RATE)} net investment income tax above{' '}
          {fmt(NIIT_THRESHOLD[status])} of modified AGI. Leave this on unless you know it
          doesn&apos;t apply to you.
        </span>
      </label>

      {zeroRoom > 0 && (
        <div className={styles.infoCard} style={{ marginTop: 14 }}>
          <div className={styles.noteTitle}>
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>savings</span>
            {fmt(zeroRoom)} of long-term gain is tax-free at this income
          </div>
          <div className={styles.cardSub} style={{ marginTop: 2 }}>
            Long-term gains stack <em>on top of</em> your ordinary income, and the bottom band is
            taxed at nothing. The 0% band runs to {fmt(zeroBandCeiling)} of total taxable income
            for {FILING_STATUSES.find(f => f.id === status)?.label.toLowerCase()}, and you are
            using {fmt(otherIncome)} of it — so a long-term gain up to{' '}
            <strong>{fmt(zeroRoom)}</strong> costs no federal tax at all this year.{' '}
            <strong>An estimate of zero below is a real answer, not a missing input.</strong>
            {!(otherIncome > 0) && (
              <>
                {' '}You have entered no income, which is what makes the room this large — if you
                have a salary, put it in the box above and watch this shrink dollar for dollar.
              </>
            )}
            {' '}This is worth knowing in its own right: realising gains up to that line, or
            spreading a sale across tax years to stay under it, is the cheapest selling you will
            ever do.
          </div>
        </div>
      )}

      {children}
    </>
  );
}

/**
 * The four answers the analysis cannot be honest without.
 *
 * Everything else on the tab has a defensible default drawn from your own
 * history or the index's. These four cannot be: the tax on a sale depends
 * entirely on the income it lands on, and getting them silently wrong doesn't
 * produce a visibly broken page — it produces a confident, plausible number
 * that happens to be nonsense. So they are asked once, up front, plainly.
 */
function AnalysisSetupDialog({
  prefs, setPrefs, status, otherIncome, incomeIsGross, enteredIncome, deduction,
  stateRate, forever, stateCode, sellYears, onClose,
}) {
  const firstRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    firstRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const zeroCeiling = LTCG_BRACKETS[status]?.[0]?.[0] ?? 0;
  const upperCeiling = LTCG_BRACKETS[status]?.[1]?.[0] ?? 0;
  const zeroRoom = Math.max(0, zeroCeiling - otherIncome);

  return (
    <div className={styles.backdrop} role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modal} role="dialog" aria-modal="true"
        aria-labelledby="setup-title">
        <div className={styles.modalHead}>
          <div>
            <div className={styles.modalTitle} id="setup-title">
              Four questions before the numbers mean anything
            </div>
            <div className={styles.cardSub} style={{ marginTop: 4 }}>
              What selling costs depends far more on your own situation than on the stock. These
              stay in this browser, are never sent anywhere, and you can change them at any time.
            </div>
          </div>
          <button type="button" className={styles.ghostBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* 1 — filing status */}
        <div className={styles.step}>
          <div className={styles.stepLabel}>
            <span className={styles.stepNum}>1</span> How do you file?
          </div>
          <div className={styles.stepHint}>
            It sets every bracket. The tax-free band for a couple is twice a single filer&apos;s.
          </div>
          <div className={styles.pillGroup} style={{ flexWrap: 'wrap' }}>
            {FILING_STATUSES.map((f, i) => (
              <button key={f.id} type="button" ref={i === 0 ? firstRef : undefined}
                className={`${styles.pill} ${status === f.id ? styles.pillActive : ''}`}
                onClick={() => setPrefs({ status: f.id })}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* 2 — income */}
        <div className={styles.step}>
          <div className={styles.stepLabel}>
            <span className={styles.stepNum}>2</span> What do you earn a year?
          </div>
          <div className={styles.stepHint}>
            The single biggest lever. Capital gains stack on top of your income, so the same sale
            can cost nothing or a fifth of the gain depending on what sits underneath it. Leave
            this blank and every estimate reads as free.
          </div>
          <div className={styles.pillGroup} style={{ marginBottom: 10 }}>
            {[
              { gross: true, label: 'I\'ll give my gross pay' },
              { gross: false, label: 'I know my taxable income' },
            ].map(o => (
              <button key={String(o.gross)} type="button"
                className={`${styles.pill} ${incomeIsGross === o.gross ? styles.pillActive : ''}`}
                onClick={() => setPrefs({ incomeIsGross: o.gross })}>
                {o.label}
              </button>
            ))}
          </div>
          <div className={styles.inputRow}>
            <label className={styles.inputField}>
              <span>{incomeIsGross ? 'Pay before tax' : 'Taxable income'}</span>
              <input type="text" inputMode="numeric" placeholder="0"
                value={prefs.income ?? ''}
                onChange={e => setPrefs({ income: e.target.value })} />
            </label>
          </div>
          {incomeIsGross && enteredIncome > 0 && (
            <div className={styles.stepHint} style={{ marginTop: 8, marginBottom: 0 }}>
              {fmt(enteredIncome)} − {fmt(deduction)} standard deduction ={' '}
              <strong>{fmt(otherIncome)}</strong> of taxable income.
            </div>
          )}
        </div>

        {/* 3 — state */}
        <div className={styles.step}>
          <div className={styles.stepLabel}>
            <span className={styles.stepNum}>3</span> Does your state tax capital gains?
          </div>
          <div className={styles.stepHint}>
            Pick your state and the rate fills in. Most states apply their ordinary income rate to
            gains; eight take nothing at all, and about a dozen treat gains differently from wages.
          </div>
          <StatePicker prefs={prefs} setPrefs={setPrefs} stateCode={stateCode} />
        </div>

        {/* 4 — exit assumption */}
        <div className={styles.step}>
          <div className={styles.stepLabel}>
            <span className={styles.stepNum}>4</span> Will you sell this money eventually?
          </div>
          <div className={styles.stepHint}>
            Holding until death passes the shares on at a stepped-up basis and the embedded gain is
            never taxed at all, which is the strongest possible argument for keeping. If you intend
            to spend the money one day, say so — it is the honest default. This one only changes
            the projection on <strong>Keep or Switch</strong>; it has no bearing on this year&apos;s
            bill.
          </div>
          <div className={styles.pillGroup} style={{ flexWrap: 'wrap' }}>
            {[
              { id: false, label: 'Yes — I\'ll sell one day' },
              { id: true, label: 'No — I\'ll hold it for life' },
            ].map(o => (
              <button key={String(o.id)} type="button"
                className={`${styles.pill} ${forever === o.id ? styles.pillActive : ''}`}
                onClick={() => setPrefs({ forever: o.id })}>
                {o.label}
              </button>
            ))}
          </div>

          {!forever && (
            <div style={{ marginTop: 14 }}>
              <div className={styles.stepLabel} style={{ fontSize: 13 }}>
                In roughly how many years?
              </div>
              <div className={styles.stepHint}>
                It decides which row of the break-even is the headline. The tax you defer matters
                most over a short hold and washes out over a long one, so a five-year answer and a
                twenty-year answer are genuinely different decisions. A rough guess is fine.
              </div>
              <div className={styles.pillGroup} style={{ flexWrap: 'wrap' }}>
                {HORIZONS.map(y => (
                  <button key={y} type="button"
                    className={`${styles.pill} ${sellYears === y ? styles.pillActive : ''}`}
                    onClick={() => setPrefs({ sellYears: y })}>
                    {y === 1 ? 'about a year' : `about ${y} years`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className={styles.answer}>
          {otherIncome > 0 ? (
            <>
              On {fmt(otherIncome)} of taxable income, the first{' '}
              <strong>{fmt(zeroRoom)}</strong> of long-term gain you realise this year is{' '}
              <strong>federally tax-free</strong>. Above that you pay 15%, rising to 20% once your
              total taxable income passes {fmt(upperCeiling)}
              {stateRate > 0 && <>, plus {fmtPlain(stateRate)} to your state</>}. Gains on anything
              held a year or less are taxed as ordinary income instead.
            </>
          ) : (
            <>
              <strong>No income entered yet.</strong> With nothing underneath them, the first{' '}
              {fmt(zeroCeiling)} of long-term gain is tax-free and every estimate on this page will
              read as costing nothing. That may well be right — but it is worth being sure.
            </>
          )}
        </div>

        <div className={styles.modalFoot}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>
            Skip for now
          </button>
          <button type="button" className={styles.primaryBtn}
            onClick={() => { setPrefs({ setupDone: true }); onClose(); }}>
            Use these answers
          </button>
        </div>
      </div>
    </div>
  );
}

const SCOPES = [
  { id: 'all', label: 'Sell everything', hint: 'Every open lot, today' },
  { id: 'long', label: 'Long-term only', hint: 'Only lots past the one-year line' },
  { id: 'gains', label: 'Only winners', hint: 'Lots currently above cost' },
  { id: 'losses', label: 'Harvest losses', hint: 'Lots currently below cost' },
];

/** Realized gains already booked this tax year, split short vs long. */
function realizedThisYear(rows, taxYear) {
  const out = { shortTermGain: 0, longTermGain: 0, lots: 0, proceeds: 0 };
  for (const r of rows || []) {
    if (r.open || !Number.isFinite(r.exitT)) continue;
    if (new Date(r.exitT).getUTCFullYear() !== taxYear) continue;
    const gain = r.value - r.costBasis;
    if (heldDays(r.buyT, r.exitT) >= LONG_TERM_DAYS) out.longTermGain += gain;
    else out.shortTermGain += gain;
    out.proceeds += r.value;
    out.lots++;
  }
  return out;
}

/**
 * What selling would cost.
 *
 * The number that matters is the *incremental* one: tax owed with the sale,
 * less tax owed without it. Quoting the gross bill on the whole year's gains
 * would blame this sale for tax that was already due, and quoting a flat rate
 * on the gain would miss that a large sale pushes its own last dollars into a
 * higher band than its first.
 */
function TaxTab({ series }) {
  const { trades, result, awaitingQuotes } = usePortfolio(series);

  const {
    prefs, setPrefs, status, otherIncome, stateRate, includeNiit, includeRealized,
    incomeIsGross, enteredIncome, deduction, forever, setupDone, stateCode, sellYears,
  } = useTaxPrefs();
  const [scope, setScope] = useState('all');
  const [chosen, setChosen] = useState(() => new Set());
  const [showLots, setShowLots] = useState(false);
  const [setupOpen, setSetupOpen] = useState(!setupDone);

  const nowT = series.lastT;
  const taxYear = new Date(nowT).getUTCFullYear();

  const openRows = useMemo(() => (result?.rows || []).filter(r => r.open), [result]);

  const included = useMemo(() => {
    if (scope === 'long') return openRows.filter(r => isLongTerm(r.buyT, nowT));
    if (scope === 'gains') return openRows.filter(r => r.value > r.costBasis);
    if (scope === 'losses') return openRows.filter(r => r.value < r.costBasis);
    if (scope === 'custom') return openRows.filter(r => chosen.has(r.symbol));
    return openRows;
  }, [scope, openRows, chosen, nowT]);

  const includedSymbols = useMemo(
    () => new Set(included.map(r => r.symbol)),
    [included],
  );

  const sale = useMemo(() => summarizeLots(included, nowT), [included, nowT]);
  const realized = useMemo(() => realizedThisYear(result?.rows, taxYear), [result, taxYear]);

  const base = includeRealized ? realized : { shortTermGain: 0, longTermGain: 0 };

  // Two runs of the same estimator: the year as it already stands, and the
  // year with this sale added on top. The gap is what selling actually costs.
  const before = useMemo(() => estimateTax({
    shortTermGain: base.shortTermGain,
    longTermGain: base.longTermGain,
    otherTaxableIncome: otherIncome, status, stateRate, includeNiit,
  }), [base.shortTermGain, base.longTermGain, otherIncome, status, stateRate, includeNiit]);

  const after = useMemo(() => estimateTax({
    shortTermGain: base.shortTermGain + sale.shortTermGain,
    longTermGain: base.longTermGain + sale.longTermGain,
    otherTaxableIncome: otherIncome, status, stateRate, includeNiit,
  }), [base.shortTermGain, base.longTermGain, sale, otherIncome, status, stateRate, includeNiit]);

  const cost = {
    federalShort: after.federalShort - before.federalShort,
    federalLong: after.federalLong - before.federalLong,
    niit: after.niit - before.niit,
    state: after.state - before.state,
    total: after.total - before.total,
    relief: after.lossRelief - before.lossRelief,
  };
  cost.net = cost.total - cost.relief;

  const perSymbol = useMemo(() => {
    const map = new Map();
    for (const r of openRows) {
      if (!map.has(r.symbol)) {
        map.set(r.symbol, {
          symbol: r.symbol, value: 0, basis: 0,
          shortTermGain: 0, longTermGain: 0, shortLots: 0, longLots: 0,
        });
      }
      const s = map.get(r.symbol);
      s.value += r.value;
      s.basis += r.costBasis;
      if (isLongTerm(r.buyT, nowT)) { s.longTermGain += r.value - r.costBasis; s.longLots++; }
      else { s.shortTermGain += r.value - r.costBasis; s.shortLots++; }
    }
    return [...map.values()]
      .map(s => ({ ...s, gain: s.shortTermGain + s.longTermGain }))
      .sort((a, b) => b.gain - a.gain);
  }, [openRows, nowT]);

  // Short-term lots sitting on a gain, and what patience is worth on each.
  // Priced exactly rather than as (ordinary rate − LT rate) × gain, because a
  // lot that straddles a bracket boundary doesn't move at one rate.
  const ripening = useMemo(() => {
    const rows = openRows
      .filter(r => !isLongTerm(r.buyT, nowT) && r.value > r.costBasis)
      .map(r => {
        const gain = r.value - r.costBasis;
        const asShort = estimateTax({
          shortTermGain: base.shortTermGain + gain,
          longTermGain: base.longTermGain,
          otherTaxableIncome: otherIncome, status, stateRate, includeNiit,
        });
        const asLong = estimateTax({
          shortTermGain: base.shortTermGain,
          longTermGain: base.longTermGain + gain,
          otherTaxableIncome: otherIncome, status, stateRate, includeNiit,
        });
        return {
          ...r,
          gain,
          qualifiesT: longTermDate(r.buyT),
          daysLeft: Math.max(0, Math.ceil((longTermDate(r.buyT) - nowT) / MS_DAY)),
          saving: asShort.total - asLong.total,
        };
      })
      .filter(r => r.saving > 0.5)
      .sort((a, b) => b.saving - a.saving);
    return {
      rows,
      total: rows.reduce((s, r) => s + r.saving, 0),
    };
  }, [openRows, nowT, base.shortTermGain, base.longTermGain, otherIncome, status, stateRate, includeNiit]);

  const toggleSymbol = (symbol) => {
    setChosen(prev => {
      const next = new Set(scope === 'custom' ? prev : includedSymbols);
      if (next.has(symbol)) next.delete(symbol); else next.add(symbol);
      return next;
    });
    setScope('custom');
  };

  if (!trades.length) {
    return (
      <div className={styles.card}>
        <div className={styles.cardTitle}>Nothing to sell yet</div>
        <div className={styles.cardSub}>
          Import your trades on the <strong>My Trades</strong> tab. This tab reads the open lots
          it builds — purchase dates, cost basis and today&apos;s value — and works out what
          selling them would cost in tax.
        </div>
      </div>
    );
  }

  if (!result || awaitingQuotes) {
    return <div className={styles.emptyState}>Pricing your open positions…</div>;
  }

  if (!openRows.length) {
    return (
      <div className={styles.card}>
        <div className={styles.cardTitle}>No open positions</div>
        <div className={styles.cardSub}>
          Every lot in your imported history has been sold, so there is nothing left to model a
          sale of. {realized.lots > 0 && `You did realize ${fmtSigned(realized.shortTermGain + realized.longTermGain)} across ${realized.lots} lots in ${taxYear}.`}
        </div>
      </div>
    );
  }

  const netProceeds = sale.proceeds - cost.net;

  return (
    <>
      {setupOpen && (
        <AnalysisSetupDialog
          prefs={prefs} setPrefs={setPrefs} status={status}
          otherIncome={otherIncome} incomeIsGross={incomeIsGross}
          enteredIncome={enteredIncome} deduction={deduction}
          stateRate={stateRate} forever={forever}
          stateCode={stateCode} sellYears={sellYears}
          onClose={() => setSetupOpen(false)}
        />
      )}

      <div className={styles.controls}>
        <div className={styles.sectionHead} style={{ marginTop: 0 }}>
          {setupDone && otherIncome > 0
            ? <>Based on {fmt(otherIncome)} of taxable income
              <span> · {FILING_STATUSES.find(f => f.id === status)?.label.toLowerCase()}
                {stateRate > 0 ? ` · ${fmtPlain(stateRate)} state` : ' · no state tax'}</span></>
            : <>Your answers are missing
              <span> — every figure below depends on them</span></>}
        </div>
        <button type="button"
          className={setupDone && otherIncome > 0 ? styles.ghostBtn : styles.primaryBtn}
          style={{ marginTop: 0 }}
          onClick={() => setSetupOpen(true)}>
          {setupDone && otherIncome > 0 ? 'Change my answers' : 'Answer the questions'}
        </button>
      </div>

      <div className={styles.hero}>
        <div className={styles.heroLabel}>
          Estimated tax · {taxYear} rules · {FILING_STATUSES.find(f => f.id === status)?.label}
        </div>
        <div className={styles.heroValue}>
          {fmt(Math.abs(cost.net))}
          <span className={styles.heroUnit}>
            {cost.net < 0 ? ' cut from your bill' : ' of tax'}
          </span>
        </div>
        <div className={styles.heroChange}>
          <span className={styles.changeRange}>
            Selling {included.length === openRows.length ? 'everything' : `${included.length} of ${openRows.length} lots`}
            {' · '}{fmt(sale.proceeds)} of stock{' · '}{fmtSigned(sale.gain)} of gain
          </span>
          {sale.gain > 0 && (
            <span className={styles.changeUp}>
              {fmtPlain(cost.net / sale.gain)} of the gain
            </span>
          )}
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>Your situation</div>
        <div className={styles.cardSub}>
          The rate on a capital gain depends entirely on the income it lands on top of, so these
          three answers change the number more than anything about the stocks does. They stay in
          this browser and are never sent anywhere.
        </div>
        <TaxSituationInputs prefs={prefs} setPrefs={setPrefs} status={status}
          otherIncome={otherIncome} incomeIsGross={incomeIsGross}
          enteredIncome={enteredIncome} deduction={deduction} stateCode={stateCode}>
          {realized.lots > 0 && (
            <label className={styles.checkbox}>
              <input type="checkbox" checked={includeRealized}
                onChange={e => setPrefs({ includeRealized: e.target.checked })} />
              <span>
                Stack this on the {fmtSigned(realized.shortTermGain + realized.longTermGain)} you
                already realized across {realized.lots} lot{realized.lots === 1 ? '' : 's'} in{' '}
                {taxYear}. Those gains fill your lower brackets first, so leaving them out
                understates what a further sale costs.
              </span>
            </label>
          )}
        </TaxSituationInputs>
      </div>

      <div className={styles.controls}>
        <div className={styles.pillGroup}>
          {SCOPES.map(o => (
            <button key={o.id} type="button" title={o.hint}
              className={`${styles.pill} ${scope === o.id ? styles.pillActive : ''}`}
              onClick={() => setScope(o.id)}>
              {o.label}
            </button>
          ))}
          {scope === 'custom' && (
            <span className={`${styles.pill} ${styles.pillActive}`}>
              {chosen.size} picked by hand
            </span>
          )}
        </div>
      </div>

      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>You&apos;d receive</div>
          <div className={styles.statValue}>{fmt(sale.proceeds)}</div>
          <div className={styles.statSub}>
            {fmt(sale.basis)} of that is your own money back
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Long-term gain</div>
          <div className={`${styles.statValue} ${sale.longTermGain >= 0 ? styles.up : styles.down}`}>
            {fmtSigned(sale.longTermGain)}
          </div>
          <div className={styles.statSub}>
            {sale.longLots} lot{sale.longLots === 1 ? '' : 's'} held over a year
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Short-term gain</div>
          <div className={`${styles.statValue} ${sale.shortTermGain >= 0 ? styles.up : styles.down}`}>
            {fmtSigned(sale.shortTermGain)}
          </div>
          <div className={styles.statSub}>
            {sale.shortLots} lot{sale.shortLots === 1 ? '' : 's'} · taxed as ordinary income
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Estimated tax</div>
          <div className={`${styles.statValue} ${cost.net > 0 ? styles.down : styles.up}`}>
            {cost.net < 0 ? `−${fmt(-cost.net)}` : fmt(cost.net)}
          </div>
          <div className={styles.statSub}>
            {cost.net < 0
              ? 'a net loss, so it reduces what you owe'
              : `federal ${fmt(cost.federalShort + cost.federalLong + cost.niit)}`}
            {cost.state > 0 && ` + state ${fmt(cost.state)}`}
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>You&apos;d keep</div>
          <div className={styles.statValue}>{fmt(netProceeds)}</div>
          <div className={styles.statSub}>after the tax above is paid</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Rate on the gain</div>
          <div className={styles.statValue}>
            {sale.gain > 0 ? fmtPlain(cost.net / sale.gain) : '—'}
          </div>
          <div className={styles.statSub}>
            {after.topLongTermRate != null
              ? `last long-term dollar at ${fmtPlain(after.topLongTermRate, 0)}`
              : `marginal ordinary rate ${fmtPlain(after.marginalOrdinaryRate, 0)}`}
          </div>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>Where the tax comes from</div>
        <div className={styles.cardSub}>
          Each line is what the sale <em>adds</em> to your bill, not the whole year&apos;s
          {includeRealized && realized.lots > 0 ? ' — the gains you already booked are held constant in both columns' : ''}.
          Long-term gains stack on top of your ordinary income, so the first ones are taxed in
          whatever bracket room is left and the last ones can land a band higher.
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Component</th>
                <th className={styles.num}>Taxable amount</th>
                <th className={styles.num}>Rate</th>
                <th className={styles.num}>Tax</th>
              </tr>
            </thead>
            <tbody>
              {/* Every rate either run touches, so a band that shrank because
                  short-term gains pushed the ordinary base up is still shown
                  rather than silently dropped from a total that includes it. */}
              {[...new Set([
                ...after.longTermBands.map(b => b.rate),
                ...before.longTermBands.map(b => b.rate),
              ])].sort((a, b) => a - b).map(rate => {
                const amount = (after.longTermBands.find(x => x.rate === rate)?.amount || 0)
                  - (before.longTermBands.find(x => x.rate === rate)?.amount || 0);
                if (Math.abs(amount) < 0.5) return null;
                return (
                  <tr key={`lt${rate}`}>
                    <td>Long-term capital gain</td>
                    <td className={styles.num}>{fmt(amount)}</td>
                    <td className={styles.num}>{fmtPlain(rate, 0)}</td>
                    <td className={styles.num}>{fmt(amount * rate)}</td>
                  </tr>
                );
              })}
              {Math.abs(cost.federalShort) >= 0.5 && (
                <tr>
                  <td>Short-term gain, as ordinary income</td>
                  <td className={styles.num}>{fmt(sale.shortTermGain)}</td>
                  <td className={styles.num}>
                    up to {fmtPlain(after.marginalOrdinaryRate, 0)}
                  </td>
                  <td className={styles.num}>{fmt(cost.federalShort)}</td>
                </tr>
              )}
              {Math.abs(cost.niit) >= 0.5 && (
                <tr>
                  <td>Net investment income tax</td>
                  <td className={styles.num}>{fmt(after.niitBase - before.niitBase)}</td>
                  <td className={styles.num}>{fmtPlain(NIIT_RATE)}</td>
                  <td className={styles.num}>{fmt(cost.niit)}</td>
                </tr>
              )}
              {Math.abs(cost.state) >= 0.5 && (
                <tr>
                  <td>State tax on gains</td>
                  <td className={styles.num}>{fmt(Math.max(0, sale.gain))}</td>
                  <td className={styles.num}>{fmtPlain(stateRate)}</td>
                  <td className={styles.num}>{fmt(cost.state)}</td>
                </tr>
              )}
              {Math.abs(cost.relief) >= 0.5 && (
                <tr>
                  <td>Loss written off against ordinary income</td>
                  <td className={styles.num}>{fmt(after.net.ordinaryOffset)}</td>
                  <td className={styles.num}>{fmtPlain(after.marginalOrdinaryRate, 0)}</td>
                  <td className={`${styles.num} ${styles.up}`}>−{fmt(cost.relief)}</td>
                </tr>
              )}
              {Math.abs(cost.total) < 0.5 && Math.abs(cost.relief) < 0.5 && (
                <tr>
                  <td colSpan={4} className={styles.muted}>
                    No tax on this sale — the gains fall inside the {fmtPlain(0, 0)} long-term band.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td><strong>Total</strong></td>
                <td className={styles.num} />
                <td className={styles.num}>
                  <strong>{sale.gain > 0 ? fmtPlain(cost.net / sale.gain) : '—'}</strong>
                </td>
                <td className={`${styles.num} ${cost.net > 0 ? styles.down : styles.up}`}>
                  <strong>{fmt(cost.net)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        {after.net.carryForward > 0 && (
          <div className={styles.cardSub} style={{ marginTop: 10 }}>
            This sale books a net loss. Only {fmt(MAX_LOSS_OFFSET)} of it can be written off
            against ordinary income this year; the remaining {fmt(after.net.carryForward)} carries
            forward indefinitely and can shelter future gains.
          </div>
        )}
      </div>

      {ripening.rows.length > 0 && (
        <div className={styles.infoCard}>
          <div className={styles.noteTitle}>
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>schedule</span>
            {fmt(ripening.total)} of tax turns on holding a little longer
          </div>
          <div className={styles.cardSub} style={{ marginTop: 2, marginBottom: 10 }}>
            These lots are still short-term, so their gains are taxed as ordinary income. Each
            crosses into long-term treatment on the date shown — the saving is the exact
            difference in your bill, not a rate-times-gain approximation.
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Bought</th>
                  <th className={styles.num}>Gain</th>
                  <th>Long-term from</th>
                  <th className={styles.num}>Days to wait</th>
                  <th className={styles.num}>Tax saved</th>
                </tr>
              </thead>
              <tbody>
                {ripening.rows.map((r, i) => (
                  <tr key={i}>
                    <td><strong>{r.symbol}</strong></td>
                    <td>{fmtDay(r.buyT)}</td>
                    <td className={`${styles.num} ${styles.up}`}>{fmtSigned(r.gain)}</td>
                    <td>{fmtDay(r.qualifiesT)}</td>
                    <td className={styles.num}>{r.daysLeft}</td>
                    <td className={`${styles.num} ${styles.up}`}><strong>{fmt(r.saving)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.cardSub} style={{ marginTop: 10 }}>
            Each row is priced on its own, as though it were the only thing you sold. Selling
            several at once pushes the later ones into higher bands, so the savings do not simply
            add up. And waiting is a market bet, not a free one — a {fmtPlain(0.1, 0)} fall in the
            price costs more than most of these rows save.
          </div>
        </div>
      )}

      <div className={styles.card}>
        <div className={styles.cardHeaderRow}>
          <div>
            <div className={styles.cardTitle}>By ticker</div>
            <div className={styles.cardSub}>
              Every open position, split at the one-year line. Tick a row to model selling just
              that position — the totals above follow your selection.
            </div>
          </div>
          <button type="button" className={styles.ghostBtn} onClick={() => setShowLots(v => !v)}>
            {showLots ? 'Hide lots' : `Show all ${openRows.length} lots`}
          </button>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Sell</th>
                <th>Ticker</th>
                <th className={styles.num}>Value</th>
                <th className={styles.num}>Cost basis</th>
                <th className={styles.num}>Long-term gain</th>
                <th className={styles.num}>Short-term gain</th>
                <th className={styles.num}>Total gain</th>
                <th className={styles.num}>Lots</th>
              </tr>
            </thead>
            <tbody>
              {perSymbol.map(s => (
                <tr key={s.symbol} className={styles.clickRow} onClick={() => toggleSymbol(s.symbol)}>
                  <td>
                    <input type="checkbox" readOnly checked={includedSymbols.has(s.symbol)}
                      style={{ cursor: 'pointer' }} />
                  </td>
                  <td><strong>{s.symbol}</strong></td>
                  <td className={styles.num}>{fmt(s.value)}</td>
                  <td className={styles.num}>{fmt(s.basis)}</td>
                  <td className={`${styles.num} ${s.longTermGain >= 0 ? styles.up : styles.down}`}>
                    {s.longLots ? fmtSigned(s.longTermGain) : '—'}
                  </td>
                  <td className={`${styles.num} ${s.shortTermGain >= 0 ? styles.up : styles.down}`}>
                    {s.shortLots ? fmtSigned(s.shortTermGain) : '—'}
                  </td>
                  <td className={`${styles.num} ${s.gain >= 0 ? styles.up : styles.down}`}>
                    <strong>{fmtSigned(s.gain)}</strong>
                  </td>
                  <td className={`${styles.num} ${styles.muted}`}>
                    {s.longLots > 0 && `${s.longLots} long`}
                    {s.longLots > 0 && s.shortLots > 0 && ', '}
                    {s.shortLots > 0 && `${s.shortLots} short`}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td />
                <td><strong>Selected</strong></td>
                <td className={styles.num}><strong>{fmt(sale.proceeds)}</strong></td>
                <td className={styles.num}><strong>{fmt(sale.basis)}</strong></td>
                <td className={`${styles.num} ${sale.longTermGain >= 0 ? styles.up : styles.down}`}>
                  <strong>{fmtSigned(sale.longTermGain)}</strong>
                </td>
                <td className={`${styles.num} ${sale.shortTermGain >= 0 ? styles.up : styles.down}`}>
                  <strong>{fmtSigned(sale.shortTermGain)}</strong>
                </td>
                <td className={`${styles.num} ${sale.gain >= 0 ? styles.up : styles.down}`}>
                  <strong>{fmtSigned(sale.gain)}</strong>
                </td>
                <td className={`${styles.num} ${styles.muted}`}><strong>{included.length}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>

        {showLots && (
          <div className={styles.tableWrap} style={{ marginTop: 18 }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th className={styles.num}>Shares</th>
                  <th>Bought</th>
                  <th className={styles.num}>Held</th>
                  <th>Treatment</th>
                  <th className={styles.num}>Cost basis</th>
                  <th className={styles.num}>Value</th>
                  <th className={styles.num}>Gain</th>
                </tr>
              </thead>
              <tbody>
                {[...openRows].sort((a, b) => a.buyT - b.buyT).map((r, i) => {
                  const long = isLongTerm(r.buyT, nowT);
                  const gain = r.value - r.costBasis;
                  return (
                    <tr key={i} style={{ opacity: included.includes(r) ? 1 : 0.45 }}>
                      <td><strong>{r.symbol}</strong></td>
                      <td className={styles.num}>
                        {/* A lot that came through a reorg holds a basket of
                            tickers rather than a share count. */}
                        {r.quantity == null
                          ? <span className={styles.muted}>basket</span>
                          : r.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })}
                      </td>
                      <td>{fmtDay(r.buyT)}</td>
                      <td className={`${styles.num} ${styles.muted}`}>
                        {heldDays(r.buyT, nowT).toLocaleString('en-US')}d
                      </td>
                      <td>
                        {long
                          ? <span className={styles.tag}>long-term</span>
                          : `short — ${Math.max(0, Math.ceil((longTermDate(r.buyT) - nowT) / MS_DAY))}d to go`}
                      </td>
                      <td className={styles.num}>{fmt(r.costBasis, 2)}</td>
                      <td className={styles.num}>{fmt(r.value, 2)}</td>
                      <td className={`${styles.num} ${gain >= 0 ? styles.up : styles.down}`}>
                        {fmtSigned(gain)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {realized.lots > 0 && (
        <div className={styles.card}>
          <div className={styles.cardTitle}>Already realized in {taxYear}</div>
          <div className={styles.cardSub}>
            Sales you have already made this year, which are taxable whether or not you sell
            anything else. They occupy your lower brackets first, which is why a sale in a year
            you have already booked gains costs more than the same sale in a quiet one.
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Sold</th>
                  <th>Treatment</th>
                  <th className={styles.num}>Proceeds</th>
                  <th className={styles.num}>Cost basis</th>
                  <th className={styles.num}>Gain</th>
                </tr>
              </thead>
              <tbody>
                {result.rows
                  .filter(r => !r.open && new Date(r.exitT).getUTCFullYear() === taxYear)
                  .sort((a, b) => b.exitT - a.exitT)
                  .map((r, i) => {
                    const long = heldDays(r.buyT, r.exitT) >= LONG_TERM_DAYS;
                    const gain = r.value - r.costBasis;
                    return (
                      <tr key={i}>
                        <td><strong>{r.symbol}</strong></td>
                        <td>{fmtDay(r.exitT)}</td>
                        <td>{long ? <span className={styles.tag}>long-term</span> : 'short-term'}</td>
                        <td className={styles.num}>{fmt(r.value, 2)}</td>
                        <td className={styles.num}>{fmt(r.costBasis, 2)}</td>
                        <td className={`${styles.num} ${gain >= 0 ? styles.up : styles.down}`}>
                          {fmtSigned(gain)}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
              <tfoot>
                <tr>
                  <td><strong>Total</strong></td>
                  <td colSpan={2} />
                  <td className={styles.num}><strong>{fmt(realized.proceeds)}</strong></td>
                  <td className={styles.num} />
                  <td className={`${styles.num} ${realized.shortTermGain + realized.longTermGain >= 0 ? styles.up : styles.down}`}>
                    <strong>{fmtSigned(realized.shortTermGain + realized.longTermGain)}</strong>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <div className={styles.noteCard}>
        <div className={styles.noteTitle}>
          <span className="material-symbols-outlined" style={{ fontSize: 17 }}>gavel</span>
          What this estimate assumes, and what it ignores
        </div>
        <ul className={styles.noteList}>
          <li>
            <strong>This is an estimate, not tax advice.</strong> Federal figures are the {TAX_YEAR}{' '}
            brackets from {TAX_SOURCE}. Check them against your own return before acting on a
            number this size, and talk to someone who does this for a living before a large sale.
          </li>
          <li>
            It assumes the account is an ordinary taxable brokerage account. Nothing sold inside
            an IRA or 401(k) works like this.
          </li>
          <li>
            Lots are matched first-in-first-out, the same way the rest of this page does it. If
            your broker has you on specific-identification or average cost, the split between
            long- and short-term will differ and so will the bill.
          </li>
          <li>
            State tax is applied as one flat rate on the whole gain. Real state treatment varies
            a lot — some states tax long-term gains at ordinary rates, some exclude a portion,
            some have their own brackets, and a loss may or may not carry the same relief.
          </li>
          <li>
            Wash sales are not modelled. If you harvest a loss and buy the same security back
            within 30 days either side, that loss is disallowed and the relief shown above
            evaporates.
          </li>
          <li>
            Not modelled: the alternative minimum tax, the QSBS exclusion, Section 1256 contracts,
            the additional Medicare tax on earned income, quarterly estimated-payment penalties,
            the qualified business income deduction, and any credit or phase-out that keys off AGI
            — a large gain can quietly cost you more by raising your AGI than it does in capital
            gains tax itself.
          </li>
          <li>
            Dividends you have already received are excluded, because they were taxed in the year
            they were paid. Only proceeds less cost basis is treated as a capital gain here.
          </li>
          <li>
            Values are today&apos;s prices. A sale settles at whatever the market does on the day,
            and the gain — and the tax — moves with it.
          </li>
        </ul>
      </div>
    </>
  );
}

// ── Single stock tab ────────────────────────────────────────────────────

/**
 * How much room each position has, ranked.
 *
 * One bar per holding: what it has actually returned, less what it must return
 * for keeping it to beat switching to the index. Bars to the right are
 * clearing their own bar; bars to the left are not. Bar thickness carries the
 * size of the position, because a thin miss on a large holding is worth more
 * attention than a wide one on a rounding error.
 */
function MarginBars({ rows, onSelect, selected }) {
  const usable = (rows || []).filter(r => Number.isFinite(r.margin));
  const W = 880;
  const rowH = 30;
  const pad = { top: 12, right: 96, bottom: 30, left: 66 };
  const H = pad.top + pad.bottom + usable.length * rowH;
  const innerW = W - pad.left - pad.right;

  if (!usable.length) {
    return (
      <div className={styles.emptyState}>
        None of these positions has enough history to annualize a return from.
      </div>
    );
  }

  const maxAbs = Math.max(...usable.map(r => Math.abs(r.margin)), 0.01);
  const maxValue = Math.max(...usable.map(r => r.sale.proceeds), 1);
  const zeroX = pad.left + innerW / 2;
  const scale = (innerW / 2) / maxAbs;

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block' }}>
      {ticksFor(-maxAbs, maxAbs, 5).map((t, i) => (
        <g key={i}>
          <line x1={zeroX + t * scale} y1={pad.top} x2={zeroX + t * scale} y2={H - pad.bottom}
            stroke="var(--color-text-tertiary)" strokeOpacity={Math.abs(t) < 1e-9 ? 0.45 : 0.12}
            strokeWidth={1} />
          <text x={zeroX + t * scale} y={H - pad.bottom + 16} textAnchor="middle" fontSize={10}
            fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">
            {fmtPlain(t, 0)}
          </text>
        </g>
      ))}

      {usable.map((r, i) => {
        const cy = pad.top + i * rowH + rowH / 2;
        const w = Math.abs(r.margin) * scale;
        const ahead = r.margin >= 0;
        // Thickness by position size, floored so a small holding is still a bar.
        const h = 8 + 12 * Math.sqrt(r.sale.proceeds / maxValue);
        return (
          <g key={r.symbol} onClick={() => onSelect?.(r.symbol)}
            style={{ cursor: onSelect ? 'pointer' : 'default' }}>
            <rect x={0} y={cy - rowH / 2} width={W} height={rowH}
              fill={selected === r.symbol ? 'var(--color-secondary)' : 'transparent'}
              fillOpacity={selected === r.symbol ? 0.07 : 0} />
            <text x={pad.left - 10} y={cy + 4} textAnchor="end" fontSize={11.5} fontWeight={700}
              fill={selected === r.symbol ? 'var(--color-secondary)' : 'var(--color-text-primary)'}
              fontFamily="var(--font-headline)">
              {r.symbol}
            </text>
            <rect x={ahead ? zeroX : zeroX - w} y={cy - h / 2} width={Math.max(w, 1)} height={h}
              rx={2} fill={ahead ? WIN : LOSE} fillOpacity={0.82}>
              <title>
                {`${r.symbol} — ${fmt(r.sale.proceeds)} held`}
                {`\nHas returned ${fmtPlain(r.historic, 1)}/yr · needs ${fmtPlain(r.required, 1)}/yr to justify keeping`}
                {`\n${ahead ? 'Clears its bar by' : 'Short of its bar by'} ${fmtPlain(Math.abs(r.margin), 1)}`}
                {`\nSelling it alone would cost ${fmt(Math.abs(r.taxCost))} in tax`}
              </title>
            </rect>
            <text x={ahead ? zeroX + w + 8 : zeroX - w - 8} y={cy + 4}
              textAnchor={ahead ? 'start' : 'end'} fontSize={11}
              fill={ahead ? WIN : LOSE} fontFamily="var(--font-headline)" fontWeight={600}>
              {r.margin > 0 ? '+' : '−'}{fmtPlain(Math.abs(r.margin), 1)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The two futures, drawn against each other.
 *
 * Both lines are the same quantity the break-even table solves on — what you
 * would actually have, after the tax finally due, if you cashed out in that
 * year. Charting the raw balances instead would be prettier and would disagree
 * with the table sitting underneath it.
 *
 * Where they cross is the whole decision: before it, keeping is ahead; after
 * it, the index has made back the tax and more. If they never cross, no
 * horizon rescues the switch at these rates.
 */
function SwitchCrossoverChart({
  symbol, value, basis, taxToSell, indexReturn, scenarios, activeKey,
  futureTaxRate, forever, years = 20,
}) {
  const W = 880, H = 340;
  const pad = { top: 18, right: 156, bottom: 40, left: 72 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const model = useMemo(() => {
    const runs = (scenarios || [])
      .map(sc => ({
        ...sc,
        path: projectPaths({
          value, basis, taxToSell, indexReturn, stockReturn: sc.rate,
          futureTaxRate, forever, years,
        }),
      }))
      .filter(r => r.path);
    if (!runs.length) return null;
    return { runs, active: runs.find(r => r.key === activeKey) || runs[0] };
  }, [scenarios, activeKey, value, basis, taxToSell, indexReturn, futureTaxRate, forever, years]);

  if (!model) return <div className={styles.emptyState}>Nothing to project.</div>;

  const { runs, active } = model;
  const pts = active.path.pts;
  const crossN = active.path.crossN;
  // Scale to the selected case alone. Fitting all three would keep the axis
  // still while switching, but a good case compounding five points harder for
  // twenty years ends up several times the others — and squashing the crossing
  // flat to accommodate it loses the one thing the chart is for. The siblings
  // are clipped instead.
  const all = pts.flatMap(p => [p.keep, p.sell]);
  const hi = Math.max(...all) * 1.04;
  const lo = Math.min(...all) * 0.96;
  const x = (n) => pad.left + (n / years) * innerW;
  const y = (v) => pad.top + (1 - (v - lo) / (hi - lo || 1)) * innerH;
  const line = (key) => `M ${pts.map(p => `${x(p.n)} ${y(p[key])}`).join(' L ')}`;

  // The band between the curves, split at the crossing. Each side is coloured
  // by who is actually ahead across it rather than by an assumption about
  // which way the crossing runs — with a higher future rate entered, the
  // switch can start ahead and fall behind, which is the reverse of the usual.
  const at = (n) => {
    const i = Math.min(Math.floor(n), pts.length - 2);
    const f = n - i;
    const a = pts[i];
    const b = pts[i + 1];
    return { n, keep: a.keep + (b.keep - a.keep) * f, sell: a.sell + (b.sell - a.sell) * f };
  };

  const segments = crossN == null
    ? [pts]
    // The crossing point belongs to both halves, so the band closes to zero
    // width there instead of leaving a wedge between the sampled years.
    : [[...pts.filter(p => p.n <= crossN), at(crossN)],
      [at(crossN), ...pts.filter(p => p.n >= crossN)]];

  const bandPath = (seg) => {
    if (seg.length < 2) return '';
    const top = seg.map(p => `${x(p.n)} ${y(p.sell)}`).join(' L ');
    const bottom = [...seg].reverse().map(p => `${x(p.n)} ${y(p.keep)}`).join(' L ');
    return `M ${top} L ${bottom} Z`;
  };

  const last = pts[pts.length - 1];
  const tickYears = [0, 5, 10, 15, 20].filter(t => t <= years);

  // Clamp each end label into the frame, then walk them in vertical order
  // pushing apart anything closer than a line height.
  const endLabels = [
    ...runs.map(r => ({
      key: r.key, short: r.short, value: r.path.last.keep,
      color: 'var(--color-secondary)', bold: r.key === active.key,
    })),
    {
      key: '__sp', short: 'S&P', value: last.sell,
      color: 'var(--color-text-secondary)', bold: true,
    },
  ]
    .map(l => ({ ...l, raw: y(l.value) }))
    .sort((a, b) => a.raw - b.raw);

  const LABEL_GAP = 13;
  const topY = pad.top + 8;
  const bottomY = H - pad.bottom;

  let floorY = topY - LABEL_GAP;
  for (const l of endLabels) {
    l.yPos = Math.max(Math.min(Math.max(l.raw, topY), bottomY), floorY + LABEL_GAP);
    // The arrow means the line left the chart, not that the label was nudged.
    l.off = l.raw < pad.top || l.raw > bottomY;
    floorY = l.yPos;
  }
  // Pushing downward can run the stack off the bottom when several cluster
  // there, so walk back up and pull them inside the frame.
  let ceilY = bottomY;
  for (let i = endLabels.length - 1; i >= 0; i--) {
    endLabels[i].yPos = Math.min(endLabels[i].yPos, ceilY);
    ceilY = endLabels[i].yPos - LABEL_GAP;
  }

  return (
    <>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}>
        <defs>
          <clipPath id="switch-plot">
            <rect x={pad.left} y={pad.top} width={innerW} height={innerH} />
          </clipPath>
        </defs>
        {ticksFor(lo, hi, 5).map((v, i) => (
          <g key={i}>
            <line x1={pad.left} y1={y(v)} x2={W - pad.right} y2={y(v)}
              stroke="var(--color-text-tertiary)" strokeOpacity={0.15} strokeWidth={1} />
            <text x={pad.left - 8} y={y(v) + 4} textAnchor="end" fontSize={10.5}
              fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">{fmtAxis(v)}</text>
          </g>
        ))}

        {tickYears.map(t => (
          <text key={t} x={x(t)} y={H - 14} textAnchor="middle" fontSize={10.5}
            fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">
            {t === 0 ? 'today' : `${t}y`}
          </text>
        ))}

        {segments.map((seg, i) => {
          const lead = seg.reduce((s, p) => s + (p.sell - p.keep), 0);
          return (
            <path key={i} d={bandPath(seg)} fill={lead >= 0 ? WIN : LOSE} fillOpacity={0.1} />
          );
        })}

        <path d={line('sell')} fill="none" stroke="var(--color-text-secondary)"
          strokeWidth={1.9} strokeDasharray="5 4" strokeOpacity={0.9} />

        {/* The scenarios not selected, kept faint — the fan is the point, but
            only one of them is driving the numbers below. Clipped, because the
            axis is fitted to the selected case. */}
        <g clipPath="url(#switch-plot)">
          {runs.filter(r => r.key !== active.key).map(r => (
            <path key={r.key}
              d={`M ${r.path.pts.map(p => `${x(p.n)} ${y(p.keep)}`).join(' L ')}`}
              fill="none" stroke="var(--color-secondary)" strokeWidth={1.3}
              strokeOpacity={0.32} strokeLinecap="round" />
          ))}
        </g>

        <path d={line('keep')} fill="none" stroke="var(--color-secondary)"
          strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />

        {crossN != null && (
          <g>
            <line x1={x(crossN)} y1={pad.top} x2={x(crossN)} y2={H - pad.bottom}
              stroke="var(--color-text-primary)" strokeOpacity={0.35} strokeWidth={1}
              strokeDasharray="3 3" />
            <text x={x(crossN) + 6} y={pad.top + 12} fontSize={10.5} fontWeight={700}
              fill="var(--color-text-primary)" fontFamily="var(--font-headline)">
              they meet at {crossN.toFixed(1)}y
            </text>
          </g>
        )}

        {/* End labels rather than a number on every point. Two scenarios that
            both run off the top would otherwise pin to the same pixel and print
            over each other, so they are clamped to the frame and then pushed
            apart in order. */}
        {endLabels.map(l => (
          <text key={l.key} x={x(years) + 8} y={l.yPos + 4} fontSize={11}
            fontWeight={l.bold ? 700 : 500} fillOpacity={l.bold ? 1 : 0.55}
            fill={l.color} fontFamily="var(--font-headline)">
            {l.off ? (l.raw < pad.top ? '↑ ' : '↓ ') : ''}{fmtAxis(l.value)} {l.short}
          </text>
        ))}

        {/* Hover targets, one per year. */}
        {pts.map(p => (
          <rect key={p.n} x={Math.max(pad.left, x(p.n) - innerW / years / 2)} y={pad.top}
            width={innerW / years} height={innerH} fill="transparent">
            <title>
              {`Year ${p.n}\nKeep ${symbol}: ${fmt(p.keep)}\nSell and buy the S&P: ${fmt(p.sell)}`}
              {`\n${p.sell >= p.keep ? 'switching ahead by ' : 'keeping ahead by '}${fmt(Math.abs(p.sell - p.keep))}`}
            </title>
          </rect>
        ))}
      </svg>

      <div className={styles.legend} style={{ justifyContent: 'center', marginTop: 6 }}>
        <span>
          <span className={styles.legendDot} style={{ background: 'var(--color-secondary)' }} />
          Keep {symbol} — {active.label} at {fmtPlain(active.rate, 1)}/yr
        </span>
        {runs.length > 1 && (
          <span className={styles.muted}>
            faint lines are the other {runs.length - 1} case{runs.length === 2 ? '' : 's'}
          </span>
        )}
        <span>
          <span className={styles.legendDash} />
          Sell, pay {fmt(Math.abs(taxToSell))} of tax, buy the S&amp;P at {fmtPlain(indexReturn, 1)}/yr
        </span>
      </div>
    </>
  );
}

/**
 * One position, end to end: what it has done, what selling it would cost, and
 * what it has to earn from here for keeping it to have been the right call.
 *
 * The last of those is the part worth having. The instinct is that a holding
 * must beat the index to justify itself, but for an appreciated position in a
 * taxable account that is usually wrong — selling hands over a slice today and
 * those dollars stop compounding, so keeping starts with a larger stake and
 * can afford to trail. This works out by how much.
 */
function SingleStockTab({ series, cpi }) {
  const portfolio = usePortfolio(series);
  const { trades, income, result, awaitingQuotes } = portfolio;
  const {
    prefs, setPrefs, status, otherIncome, stateRate, includeNiit, includeRealized,
    incomeIsGross, enteredIncome, deduction, forever, setupDone, stateCode, sellYears,
  } = useTaxPrefs();

  const [symbol, setSymbol] = useState(null);
  const [view, setView] = useState('one');
  const [setupOpen, setSetupOpen] = useState(!setupDone);
  const setForever = useCallback((v) => setPrefs({ forever: v }), [setPrefs]);
  // One horizon everywhere: the answer given in the dialog, and changing the
  // pills in the comparison view updates that answer rather than diverging
  // from it.
  const horizon = sellYears;
  const setHorizon = useCallback((y) => setPrefs({ sellYears: y }), [setPrefs]);
  const [indexText, setIndexText] = useState('');
  const [futureRateText, setFutureRateText] = useState('');
  const [stockText, setStockText] = useState('');
  const [spreadText, setSpreadText] = useState('');
  const [scenario, setScenario] = useState('base');

  const nowT = series.lastT;
  const taxYear = new Date(nowT).getUTCFullYear();

  // What a typical ten-year hold in the index has actually returned — a
  // defensible default that isn't a round number pulled from the air.
  const defaultIndexReturn = useMemo(() => {
    const ten = rollingReturns(series, 10);
    return ten?.avg ?? cagr(series, series.firstT, series.lastT) ?? 0.09;
  }, [series]);

  const indexReturn = indexText.trim() === ''
    ? defaultIndexReturn
    : Math.max(-0.5, Math.min(0.5, (Number(indexText.replace(/[%\s]/g, '')) || 0) / 100));

  const positions = useMemo(() => {
    const map = new Map();
    for (const r of result?.rows || []) {
      if (!map.has(r.symbol)) map.set(r.symbol, { symbol: r.symbol, open: [], all: [], value: 0 });
      const p = map.get(r.symbol);
      p.all.push(r);
      if (r.open) { p.open.push(r); p.value += r.value; }
    }
    return [...map.values()].sort((a, b) => b.value - a.value);
  }, [result]);

  // Default to the biggest thing you actually still hold — the position the
  // question is most likely being asked about.
  const active = positions.find(p => p.symbol === symbol) || positions[0] || null;

  const summary = result?.symbols.find(s => s.symbol === active?.symbol) || null;

  const infl = useMemo(
    () => (result && cpi?.series ? inflationCompare(result, cpi.series) : null),
    [result, cpi],
  );
  const realForSymbol = infl?.symbols.find(s => s.symbol === active?.symbol) || null;

  // Shaded on the same ramp as the By ticker table, so a colour means the same
  // thing on both screens.
  const realRange = useMemo(() => {
    const vals = (infl?.symbols || [])
      .map(s => s.realRet)
      .filter(v => v != null && Number.isFinite(v));
    if (!vals.length) return { worst: null, best: null };
    return { worst: Math.min(...vals, 0), best: Math.max(...vals, 0) };
  }, [infl]);

  const symbolIncome = useMemo(
    () => (income || []).filter(d => (active?.symbol || '').split(' + ').includes(d.symbol)),
    [income, active],
  );

  // What this position has actually annualized on its own cash flows. A
  // starting point for the projection, emphatically not a forecast.
  const stockHistoricAnnual = useMemo(() => {
    if (!active) return null;
    const flows = [];
    for (const r of active.all) {
      flows.push({ t: r.buyT, amount: -r.costBasis });
      flows.push({ t: r.exitT, amount: r.value });
    }
    for (const d of symbolIncome) flows.push({ t: d.t, amount: d.amount });
    return xirr(flows);
  }, [active, symbolIncome]);

  const defaultStockReturn = Number.isFinite(stockHistoricAnnual)
    ? Math.max(-0.5, Math.min(0.5, stockHistoricAnnual))
    : defaultIndexReturn;
  // The central case: its own history unless you say otherwise.
  const centralReturn = stockText.trim() === ''
    ? defaultStockReturn
    : Math.max(-0.5, Math.min(0.5, (Number(stockText.replace(/[%\s]/g, '')) || 0) / 100));

  // How far the good and bad cases sit either side of it, in percentage
  // points. Points rather than a multiplier so it still behaves when the
  // central case is negative — half of −8%/yr is not a worse outcome.
  const spread = spreadText.trim() === ''
    ? 0.05
    : Math.max(0, Math.min(0.4, (Number(spreadText.replace(/[%\s]/g, '')) || 0) / 100));

  const scenarios = useMemo(() => ([
    { key: 'worse', label: 'does worse', short: 'worse', rate: centralReturn - spread },
    { key: 'base', label: 'holds its average', short: 'as before', rate: centralReturn },
    { key: 'better', label: 'does better', short: 'better', rate: centralReturn + spread },
  ]), [centralReturn, spread]);

  const activeScenario = scenarios.find(s => s.key === scenario) || scenarios[1];

  const realized = useMemo(() => realizedThisYear(result?.rows, taxYear), [result, taxYear]);
  const base = includeRealized
    ? realized
    : { shortTermGain: 0, longTermGain: 0 };

  const sale = useMemo(
    () => (active ? summarizeLots(active.open, nowT) : null),
    [active, nowT],
  );

  // Incremental again: the bill with this position sold, less the bill without.
  const tax = useMemo(() => {
    if (!sale) return null;
    const common = { otherTaxableIncome: otherIncome, status, stateRate, includeNiit };
    const before = estimateTax({
      shortTermGain: base.shortTermGain, longTermGain: base.longTermGain, ...common,
    });
    const after = estimateTax({
      shortTermGain: base.shortTermGain + sale.shortTermGain,
      longTermGain: base.longTermGain + sale.longTermGain,
      ...common,
    });
    const net = (after.total - before.total) - (after.lossRelief - before.lossRelief);
    return { before, after, cost: net, proceeds: sale.proceeds - net };
  }, [sale, base.shortTermGain, base.longTermGain, otherIncome, status, stateRate, includeNiit]);

  // The rate on gains taxed at the horizon. Defaulted to the one selling today
  // implies, but overridable — this is the single input a bracket calculation
  // genuinely cannot supply, because it depends on an income twenty years out.
  // Someone planning to sell in retirement should say so.
  const impliedRate = tax && sale
    ? impliedTaxRate(tax.cost, sale.proceeds, sale.basis)
    : 0.15;
  const futureRateOverridden = futureRateText.trim() !== '';
  const futureTaxRate = futureRateOverridden
    ? Math.max(0, Math.min(0.9, (Number(futureRateText.replace(/[%\s]/g, '')) || 0) / 100))
    : impliedRate;

  const table = useMemo(() => {
    if (!sale || !tax || !(sale.proceeds > 0)) return [];
    return breakEvenTable({
      value: sale.proceeds,
      basis: sale.basis,
      taxToSell: tax.cost,
      indexReturn,
      futureTaxRate,
      horizons: HORIZONS,
    });
  }, [sale, tax, indexReturn, futureTaxRate]);

  // Reported over the hold you said you had, not a stock ten years.
  const headline = useMemo(() => {
    if (!sale || !tax || !(sale.proceeds > 0)) return null;
    return requiredReturn({
      value: sale.proceeds,
      basis: sale.basis,
      taxToSell: tax.cost,
      indexReturn,
      years: horizon,
      futureTaxRate,
      liquidateAtEnd: !forever,
    });
  }, [sale, tax, indexReturn, horizon, futureTaxRate, forever]);

  /**
   * Every open position put through the same question at once.
   *
   * Each position's tax is priced *on its own*, as though it were the only
   * thing sold — that keeps the rows comparable, which is the point of the
   * view, but it means the column does not add up. Gains stack, so selling
   * several together pushes the later ones into higher bands. The real
   * whole-portfolio bill is computed separately below and the two are shown
   * against each other rather than one being quietly presented as the other.
   */
  const comparison = useMemo(() => {
    if (!result) return [];
    const common = { otherTaxableIncome: otherIncome, status, stateRate, includeNiit };
    const before = estimateTax({
      shortTermGain: base.shortTermGain, longTermGain: base.longTermGain, ...common,
    });

    const incomeBySymbol = new Map();
    for (const d of income || []) {
      if (!incomeBySymbol.has(d.symbol)) incomeBySymbol.set(d.symbol, []);
      incomeBySymbol.get(d.symbol).push(d);
    }

    return positions
      .filter(p => p.open.length)
      .map(p => {
        const s = summarizeLots(p.open, nowT);
        const after = estimateTax({
          shortTermGain: base.shortTermGain + s.shortTermGain,
          longTermGain: base.longTermGain + s.longTermGain,
          ...common,
        });
        const taxCost = (after.total - before.total) - (after.lossRelief - before.lossRelief);
        const rate = impliedTaxRate(taxCost, s.proceeds, s.basis);
        const req = requiredReturn({
          value: s.proceeds,
          basis: s.basis,
          taxToSell: taxCost,
          indexReturn,
          years: horizon,
          futureTaxRate: futureRateOverridden ? futureTaxRate : rate,
          liquidateAtEnd: !forever,
        });

        const flows = [];
        for (const r of p.all) {
          flows.push({ t: r.buyT, amount: -r.costBasis });
          flows.push({ t: r.exitT, amount: r.value });
        }
        for (const part of p.symbol.split(' + ')) {
          for (const d of incomeBySymbol.get(part) || []) flows.push({ t: d.t, amount: d.amount });
        }
        const historic = xirr(flows);

        return {
          symbol: p.symbol,
          sale: s,
          taxCost,
          netProceeds: s.proceeds - taxCost,
          required: req?.required ?? null,
          hurdle: req?.hurdle ?? null,
          historic,
          margin: (Number.isFinite(historic) && req) ? historic - req.required : null,
        };
      })
      .sort((a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity));
  }, [result, positions, income, nowT, base.shortTermGain, base.longTermGain,
    otherIncome, status, stateRate, includeNiit, indexReturn, horizon,
    futureRateOverridden, futureTaxRate, forever]);

  // What selling the lot of them together would actually cost, which is more
  // than the sum of the rows above once the gains stack into higher bands.
  const sellEverything = useMemo(() => {
    if (!result) return null;
    const openAll = (result.rows || []).filter(r => r.open);
    if (!openAll.length) return null;
    const s = summarizeLots(openAll, nowT);
    const common = { otherTaxableIncome: otherIncome, status, stateRate, includeNiit };
    const before = estimateTax({
      shortTermGain: base.shortTermGain, longTermGain: base.longTermGain, ...common,
    });
    const after = estimateTax({
      shortTermGain: base.shortTermGain + s.shortTermGain,
      longTermGain: base.longTermGain + s.longTermGain,
      ...common,
    });
    const cost = (after.total - before.total) - (after.lossRelief - before.lossRelief);
    return { sale: s, cost, proceeds: s.proceeds - cost };
  }, [result, nowT, base.shortTermGain, base.longTermGain,
    otherIncome, status, stateRate, includeNiit]);

  const summedTax = comparison.reduce((t, r) => t + r.taxCost, 0);

  if (!trades.length) {
    return (
      <div className={styles.card}>
        <div className={styles.cardTitle}>Nothing to analyse yet</div>
        <div className={styles.cardSub}>
          Import your trades on the <strong>My Trades</strong> tab and each position can be taken
          apart here — how it has done, what selling it would cost, and what it needs to earn to
          be worth keeping.
        </div>
      </div>
    );
  }

  if (!result || awaitingQuotes) {
    return <div className={styles.emptyState}>Pricing your positions…</div>;
  }

  if (!active) {
    return <div className={styles.emptyState}>No positions could be priced.</div>;
  }

  return (
    <>
      {setupOpen && (
        <AnalysisSetupDialog
          prefs={prefs} setPrefs={setPrefs} status={status}
          otherIncome={otherIncome} incomeIsGross={incomeIsGross}
          enteredIncome={enteredIncome} deduction={deduction}
          stateRate={stateRate} forever={forever}
          stateCode={stateCode} sellYears={sellYears}
          onClose={() => setSetupOpen(false)}
        />
      )}

      <div className={styles.controls}>
        <div className={styles.sectionHead} style={{ marginTop: 0 }}>
          {setupDone && otherIncome > 0
            ? <>Based on {fmt(otherIncome)} of taxable income
              <span> · {FILING_STATUSES.find(f => f.id === status)?.label.toLowerCase()}
                {stateRate > 0 ? ` · ${fmtPlain(stateRate)} state` : ' · no state tax'}</span></>
            : <>Your answers are missing
              <span> — the tax on every sale below depends on them</span></>}
        </div>
        <button type="button"
          className={setupDone && otherIncome > 0 ? styles.ghostBtn : styles.primaryBtn}
          style={{ marginTop: 0 }}
          onClick={() => setSetupOpen(true)}>
          {setupDone && otherIncome > 0 ? 'Change my answers' : 'Answer the questions'}
        </button>
      </div>

      <div className={styles.subTabBar}>
        {[
          { id: 'one', label: 'One position' },
          { id: 'all', label: 'Compare all' },
        ].map(t => (
          <button key={t.id} type="button"
            className={`${styles.tab} ${view === t.id ? styles.tabActive : ''}`}
            onClick={() => setView(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {view === 'all' && (
        <CompareAllPositions
          rows={comparison}
          horizon={horizon}
          setHorizon={setHorizon}
          indexReturn={indexReturn}
          indexText={indexText}
          setIndexText={setIndexText}
          defaultIndexReturn={defaultIndexReturn}
          futureRateText={futureRateText}
          setFutureRateText={setFutureRateText}
          forever={forever}
          setForever={setForever}
          sellEverything={sellEverything}
          summedTax={summedTax}
          selected={active.symbol}
          onSelect={(sym) => { setSymbol(sym); setView('one'); }}
          taxInputs={
            <TaxSituationInputs prefs={prefs} setPrefs={setPrefs} status={status}
              otherIncome={otherIncome} incomeIsGross={incomeIsGross}
              enteredIncome={enteredIncome} deduction={deduction} stateCode={stateCode} />
          }
        />
      )}

      {view === 'one' && (
      <>
      <div className={styles.controls}>
        <div className={styles.pillGroup} style={{ flexWrap: 'wrap' }}>
          {positions.map(p => (
            <button key={p.symbol} type="button"
              className={`${styles.pill} ${active.symbol === p.symbol ? styles.pillActive : ''}`}
              onClick={() => setSymbol(p.symbol)}
              title={p.open.length ? `${fmt(p.value)} still held` : 'fully sold'}>
              {p.symbol}
              {!p.open.length && <span className={styles.muted}> ·sold</span>}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.hero}>
        <div className={styles.heroLabel}>
          {active.symbol} · keep it, or sell and buy the index?
        </div>
        {!active.open.length ? (
          <>
            <div className={styles.heroTitle}>You no longer hold {active.symbol}</div>
            <div className={styles.heroSubtitle}>
              Every lot has been sold, so there is nothing to decide. The history below still
              shows how it did against the index and against inflation while you held it.
            </div>
          </>
        ) : !headline ? (
          <div className={styles.heroValue}>…</div>
        ) : (
          <>
            <div className={styles.heroValue}>
              {fmtPlain(headline.required, 1)}
              <span className={styles.heroUnit}>/yr needed to keep it</span>
            </div>
            <div className={styles.heroChange}>
              <span className={headline.hurdle <= 0 ? styles.changeUp : styles.changeDown}>
                {headline.hurdle <= 0
                  ? `it may trail the S&P by ${fmtPlain(-headline.hurdle, 2)}/yr and still win`
                  : `it must beat the S&P by ${fmtPlain(headline.hurdle, 2)}/yr`}
              </span>
              <span className={activeScenario.rate >= headline.required ? styles.changeUp : styles.changeDown}>
                · {activeScenario.label} at {fmtPlain(activeScenario.rate, 1)},{' '}
                {activeScenario.rate >= headline.required ? 'which clears it' : 'which falls short'}
              </span>
              <span className={styles.changeRange}>
                · over {forever ? `${horizon} years, never sold` : `the ${horizon} years you said`}
                {' '}· S&amp;P assumed at {fmtPlain(indexReturn, 1)}/yr
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── What it has done ── */}
      <div className={styles.sectionHead}>
        The record
        <span> — against the index, and against the cost of living</span>
      </div>

      {realForSymbol && (
        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Invested</div>
            <div className={styles.statValue}>{fmt(realForSymbol.invested)}</div>
            <div className={styles.statSub}>{realForSymbol.lots} lots</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Now worth</div>
            <div className={styles.statValue}>{fmt(realForSymbol.totalValue)}</div>
            <div className={styles.statSub}>
              {summary?.income > 0 ? `includes ${fmt(summary.income)} of dividends` : 'dividends included'}
            </div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Your return</div>
            <div className={`${styles.statValue} ${realForSymbol.ret >= 0 ? styles.up : styles.down}`}>
              {fmtPct(realForSymbol.ret)}
            </div>
            <div className={styles.statSub}>
              S&amp;P {summary ? fmtPct(summary.benchRet) : '—'} over the same dates
            </div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Beat the S&amp;P by</div>
            <div className={`${styles.statValue} ${summary && summary.alpha >= 0 ? styles.up : styles.down}`}>
              {summary ? fmtSigned(summary.alpha) : '—'}
            </div>
            <div className={styles.statSub}>same money, same holding periods</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Real return</div>
            <div className={`${styles.statValue} ${styles.heatChip}`}
              style={{ background: realReturnTint(realForSymbol.realRet, realRange.worst, realRange.best) }}>
              {fmtPct(realForSymbol.realRet)}
            </div>
            <div className={styles.statSub}>
              after {fmtPlain(realForSymbol.inflRet)} of inflation over the same period
            </div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Beat inflation by</div>
            <div className={`${styles.statValue} ${realForSymbol.realGain >= 0 ? styles.up : styles.down}`}>
              {fmtSigned(realForSymbol.realGain)}
            </div>
            <div className={styles.statSub}>real purchasing power created</div>
          </div>
        </div>
      )}

      <TickerDetail
        symbol={active.symbol}
        rows={active.all}
        summary={summary}
        income={(income || []).filter(d => active.symbol.split(' + ').includes(d.symbol))}
        series={series}
        cpi={cpi?.series || null}
      />

      {active.open.length > 0 && sale && tax && (
        <>
          {/* ── What selling costs ── */}
          <div className={styles.sectionHead}>
            The cost of switching
            <span> — what the taxman takes on the way out</span>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>Your situation</div>
            <div className={styles.cardSub}>
              Shared with the <strong>Tax on Selling</strong> tab — change it in either place.
            </div>
            <TaxSituationInputs prefs={prefs} setPrefs={setPrefs} status={status}
              otherIncome={otherIncome} incomeIsGross={incomeIsGross}
              enteredIncome={enteredIncome} deduction={deduction} stateCode={stateCode} />
          </div>

          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>You&apos;d receive</div>
              <div className={styles.statValue}>{fmt(sale.proceeds)}</div>
              <div className={styles.statSub}>
                {sale.longLots} long-term, {sale.shortLots} short-term lots
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Taxable gain</div>
              <div className={`${styles.statValue} ${sale.gain >= 0 ? styles.up : styles.down}`}>
                {fmtSigned(sale.gain)}
              </div>
              <div className={styles.statSub}>
                {fmtSigned(sale.longTermGain)} long · {fmtSigned(sale.shortTermGain)} short
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Tax to switch</div>
              <div className={`${styles.statValue} ${tax.cost > 0 ? styles.down : styles.up}`}>
                {tax.cost < 0 ? `−${fmt(-tax.cost)}` : fmt(tax.cost)}
              </div>
              <div className={styles.statSub}>
                {sale.gain > 0 ? `${fmtPlain(tax.cost / sale.gain)} of the gain` : 'a loss — it cuts your bill'}
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Reaches the index</div>
              <div className={styles.statValue}>{fmt(tax.proceeds)}</div>
              <div className={styles.statSub}>
                {fmtPlain(1 - tax.proceeds / sale.proceeds)} smaller than the stake you hold now
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>That tax, compounded</div>
              <div className={styles.statValue}>
                {fmt(taxOpportunityCost(tax.cost, indexReturn, 10))}
              </div>
              <div className={styles.statSub}>
                what the tax dollars alone would be worth in 10 years at {fmtPlain(indexReturn, 1)}
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Rate assumed later</div>
              <div className={styles.statValue}>{fmtPlain(futureTaxRate)}</div>
              <div className={styles.statSub}>
                {futureRateOverridden
                  ? 'your figure, on gains taxed at the horizon'
                  : 'implied by selling today — override it below'}
              </div>
            </div>
          </div>

          {/* ── The break-even ── */}
          <div className={styles.sectionHead}>
            The break-even
            <span> — what {active.symbol} must earn for keeping it to have been right</span>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>Assumptions</div>
            <div className={styles.cardSub}>
              The whole answer turns on what you think the index will do and whether this money
              is ever sold again, so both are yours to set.
            </div>
            <div className={styles.inputRow}>
              <label className={styles.inputField}>
                <span>S&amp;P return a year</span>
                <input type="text" inputMode="decimal"
                  placeholder={(defaultIndexReturn * 100).toFixed(1)}
                  value={indexText}
                  onChange={e => setIndexText(e.target.value)} />
              </label>
              <label className={styles.inputField}>
                <span>{active.symbol} central case</span>
                <input type="text" inputMode="decimal"
                  placeholder={(defaultStockReturn * 100).toFixed(1)}
                  value={stockText}
                  onChange={e => setStockText(e.target.value)} />
              </label>
              <label className={styles.inputField}>
                <span>Better / worse by</span>
                <input type="text" inputMode="decimal" placeholder="5"
                  value={spreadText}
                  onChange={e => setSpreadText(e.target.value)} />
              </label>
              <label className={styles.inputField}>
                <span>Tax rate when you sell</span>
                <input type="text" inputMode="decimal"
                  placeholder={(impliedRate * 100).toFixed(1)}
                  value={futureRateText}
                  onChange={e => setFutureRateText(e.target.value)} />
              </label>
            </div>
            <div className={styles.cardSub} style={{ marginTop: 10 }}>
              Blank uses {fmtPlain(defaultIndexReturn, 1)} for the index — what a typical ten-year
              hold has actually averaged across every start month in the series, which is a fairer
              figure than any single stretch of history. For {active.symbol} it uses{' '}
              {fmtPlain(defaultStockReturn, 1)}, which is what your own money in it has annualized
              so far. <strong>That is history, not a forecast</strong> — a position that has run
              hot is the one least likely to repeat it, which is what the three cases below are
              for. <strong>Better / worse by</strong> is in percentage points either side of the
              central case, so 5 gives you {fmtPlain(centralReturn - spread, 1)},{' '}
              {fmtPlain(centralReturn, 1)} and {fmtPlain(centralReturn + spread, 1)}.
            </div>

            <div className={styles.pillGroup} style={{ marginTop: 12 }}>
              {scenarios.map(s => (
                <button key={s.key} type="button"
                  className={`${styles.pill} ${scenario === s.key ? styles.pillActive : ''}`}
                  onClick={() => setScenario(s.key)}>
                  {s.key === 'base' ? 'Holds its average' : s.key === 'worse' ? 'Does worse' : 'Does better'}
                  {' '}<span className={styles.muted}>{fmtPlain(s.rate, 1)}</span>
                </button>
              ))}
            </div>
            <div className={styles.cardSub} style={{ marginTop: 6 }}>
              The <strong>tax rate when you sell</strong> is the one number a bracket calculation
              can&apos;t work out for you — it depends on your income in the year you finally sell,
              which may be decades away. Blank uses {fmtPlain(impliedRate, 1)}, the rate selling
              today would cost. Override it if you expect to sell in a different situation: a low
              income in early retirement can put a long-term gain back in the 0% band, and a large
              sale in a working year can push it to 23.8%.
            </div>
            <div className={styles.pillGroup} style={{ marginTop: 12 }}>
              {[
                { id: false, label: 'I\'ll sell eventually', hint: 'Both sides are taxed at the horizon' },
                { id: true, label: 'I\'ll never sell', hint: 'Held to a step-up in basis, or donated' },
              ].map(o => (
                <button key={String(o.id)} type="button" title={o.hint}
                  className={`${styles.pill} ${forever === o.id ? styles.pillActive : ''}`}
                  onClick={() => setForever(o.id)}>
                  {o.label}
                </button>
              ))}
            </div>
            <div className={styles.cardSub} style={{ marginTop: 10 }}>
              {forever
                ? 'Neither the gain you hold now nor the one you\'d build in the index is ever taxed — '
                  + 'heirs take the shares at a stepped-up basis, or a charity does. Deferring is worth '
                  + 'the most in this case, so the hurdle is at its lowest.'
                : 'Both paths are taxed when they finally sell, so deferring buys time rather than '
                  + 'forgiveness — which is the honest default unless you know you\'ll never sell.'}
            </div>
          </div>

          <div className={styles.chartCard}>
            <div className={styles.chartHeader}>
              <div>
                <div className={styles.cardTitle}>
                  The two futures, side by side
                </div>
                <div className={styles.cardSub}>
                  Both lines are what you would actually have <strong>after tax</strong> if you
                  cashed out in that year, which is the same measure the table below solves on.
                  Selling costs {fmt(Math.abs(tax.cost))} up front, so the dashed line starts from
                  a smaller stake — the shaded band is how far apart the two choices are, and where
                  the lines cross is the moment the index has made that tax back.
                </div>
              </div>
            </div>
            <SwitchCrossoverChart
              symbol={active.symbol}
              value={sale.proceeds}
              basis={sale.basis}
              taxToSell={tax.cost}
              indexReturn={indexReturn}
              scenarios={scenarios}
              activeKey={scenario}
              futureTaxRate={futureTaxRate}
              forever={forever}
              years={20}
            />

            <div className={styles.tableWrap} style={{ marginTop: 16 }}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>If {active.symbol}</th>
                    <th className={styles.num}>Returns</th>
                    <th className={styles.num}>In 20 years, keeping</th>
                    <th className={styles.num}>Switching</th>
                    <th className={styles.num}>Difference</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map(s => {
                    const p = projectPaths({
                      value: sale.proceeds, basis: sale.basis, taxToSell: tax.cost,
                      indexReturn, stockReturn: s.rate, futureTaxRate, forever, years: 20,
                    });
                    if (!p) return null;
                    const gap = p.last.keep - p.last.sell;
                    return (
                      <tr key={s.key}
                        className={styles.clickRow}
                        onClick={() => setScenario(s.key)}
                        style={scenario === s.key
                          ? { background: 'rgba(0, 88, 190, 0.06)', fontWeight: 600 }
                          : undefined}>
                        <td><strong>{s.label}</strong></td>
                        <td className={styles.num}>{fmtPlain(s.rate, 1)}</td>
                        <td className={styles.num}>{fmt(p.last.keep)}</td>
                        <td className={`${styles.num} ${styles.muted}`}>{fmt(p.last.sell)}</td>
                        <td className={`${styles.num} ${gap >= 0 ? styles.up : styles.down}`}>
                          <strong>{fmtSigned(gap)}</strong>
                        </td>
                        <td className={gap >= 0 ? styles.up : styles.down}>
                          {gap >= 0 ? 'keeping wins' : 'switching wins'}
                          {p.crossN != null && (
                            <span className={styles.muted}>
                              {' '}· they cross at {p.crossN.toFixed(1)}y
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className={styles.cardSub} style={{ marginTop: 12 }}>
              {forever
                ? `Because this money is never sold again, the gap you see at year zero is the tax `
                  + `itself — ${fmt(Math.abs(tax.cost))} that leaves and never compounds for you again.`
                : `Both paths pay tax when they finally sell, so at year zero they are worth the `
                  + `same and no gap is visible. That is the point: selling today costs you nothing `
                  + `today — it costs you the compounding on the ${fmt(Math.abs(tax.cost))} that `
                  + `goes to tax years before it had to.`}
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>
              What {active.symbol} has to return, by how long you hold it
            </div>
            <div className={styles.cardSub}>
              Selling costs {fmt(Math.abs(tax.cost))} today, so only {fmt(tax.proceeds)} of your{' '}
              {fmt(sale.proceeds)} reaches the index. Keeping starts with the whole amount still
              working, and that head start is what the position is allowed to give back in
              performance. The <strong>gap</strong> column is the answer to your question: a
              negative gap means {active.symbol} can underperform the index by that much a year
              and you are still better off having kept it.
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>If you hold for</th>
                    <th className={styles.num}>S&amp;P assumed</th>
                    <th className={styles.num}>{active.symbol} must return</th>
                    <th className={styles.num}>Gap vs the index</th>
                    <th>What that means</th>
                  </tr>
                </thead>
                <tbody>
                  {table.map(row => {
                    const r = forever ? row.forever : row.liquidate;
                    if (!r) return null;
                    const yours = row.years === horizon;
                    return (
                      <tr key={row.years}
                        style={yours ? { background: 'rgba(0, 88, 190, 0.06)' } : undefined}>
                        <td>
                          <strong>{row.years} year{row.years === 1 ? '' : 's'}</strong>
                          {yours && <span className={styles.tag}>your hold</span>}
                        </td>
                        <td className={`${styles.num} ${styles.muted}`}>{fmtPlain(indexReturn, 2)}</td>
                        <td className={styles.num}><strong>{fmtPlain(r.required, 2)}</strong></td>
                        <td className={`${styles.num} ${r.hurdle <= 0 ? styles.up : styles.down}`}>
                          <strong>{r.hurdle > 0 ? '+' : '−'}{fmtPlain(Math.abs(r.hurdle), 2)}</strong>
                        </td>
                        <td className={styles.muted}>
                          {r.hurdle <= 0
                            ? `can lag the index and still win`
                            : `has to beat the index outright`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className={styles.cardSub} style={{ marginTop: 12 }}>
              {headline && headline.hurdle <= 0 ? (
                <>
                  Read the ten-year row as the verdict. Switching only pays if you believe{' '}
                  {active.symbol} will return <strong>less than {fmtPlain(headline.required, 1)}</strong> a
                  year from here while the index makes {fmtPlain(indexReturn, 1)} — that is the bar
                  the tax bill buys you. Notice the gap narrows as the horizon lengthens: a one-off
                  tax hit matters less the longer the money compounds afterwards, so deferring is
                  worth most to someone about to sell again soon.
                </>
              ) : (
                <>
                  This position has no meaningful embedded gain to defer — selling costs little or
                  nothing — so keeping it has to be justified on the merits: {active.symbol} must
                  outright beat the index by {headline ? fmtPlain(headline.hurdle, 2) : '—'} a year.
                  There is no tax argument for holding on here.
                </>
              )}
            </div>
          </div>

          <div className={styles.noteCard}>
            <div className={styles.noteTitle}>
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>balance</span>
              What this comparison is, and what it is not
            </div>
            <ul className={styles.noteList}>
              <li>
                <strong>This is a tax-drag calculation, not investment advice.</strong> It answers
                one narrow question — how much performance the deferred tax is worth — and says
                nothing about whether {active.symbol} is a good business at this price.
              </li>
              <li>
                It ignores risk entirely. A single stock and a 500-company index earning the same
                return are not the same outcome, and a concentrated position can lose far more than
                the hurdle here is worth. If {active.symbol} is a large share of your net worth,
                that is a stronger argument to sell than anything in this table.
              </li>
              <li>
                Future tax is assumed at {fmtPlain(futureTaxRate)} — the rate implied by selling
                today. Your bracket, the law, and the {fmtPlain(NIIT_RATE)} investment surtax
                thresholds will all move over a ten- or twenty-year horizon.
              </li>
              <li>
                Both sides are modelled as a single lump growing at a steady rate. Real returns
                arrive unevenly, and selling in a year with other gains — or other losses — changes
                the bill materially. The <strong>Tax on Selling</strong> tab models a whole year at
                once if you want to net this against something else.
              </li>
              <li>
                Dividends the position pays are inside its historical return above but are not
                projected forward; the required return here is a total return, so compare it against
                what you expect {active.symbol} to deliver including any yield.
              </li>
              <li>
                Selling in pieces across tax years, or selling only the long-term lots, can cut the
                bill well below the figure shown here. This models selling the whole position at once.
              </li>
            </ul>
          </div>
        </>
      )}
      </>
      )}
    </>
  );
}

/**
 * Every holding against the same bar, ranked.
 *
 * The per-position view answers "should I keep this one". This answers the
 * question you actually have, which is "of the things I own, which are hardest
 * to justify keeping" — and that only shows up when they are side by side.
 */
function CompareAllPositions({
  rows, horizon, setHorizon, indexReturn, indexText, setIndexText, defaultIndexReturn,
  futureRateText, setFutureRateText, forever, setForever, sellEverything, summedTax,
  selected, onSelect, taxInputs,
}) {
  if (!rows.length) {
    return (
      <div className={styles.card}>
        <div className={styles.cardTitle}>No open positions to compare</div>
        <div className={styles.cardSub}>
          Everything in your imported history has been sold, so there is nothing to weigh up.
        </div>
      </div>
    );
  }

  const clearing = rows.filter(r => r.margin != null && r.margin >= 0);
  const failing = rows.filter(r => r.margin != null && r.margin < 0);
  const totalValue = rows.reduce((s, r) => s + r.sale.proceeds, 0);
  const failingValue = failing.reduce((s, r) => s + r.sale.proceeds, 0);

  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroLabel}>Every position against the same bar</div>
        <div className={styles.heroValue}>
          {failing.length}
          <span className={styles.heroUnit}>
            {failing.length === 1 ? ' position is not clearing it' : ' positions are not clearing it'}
          </span>
        </div>
        <div className={styles.heroChange}>
          <span className={failing.length ? styles.changeDown : styles.changeUp}>
            {fmt(failingValue)} of {fmt(totalValue)} held
          </span>
          <span className={styles.changeRange}>
            · on {horizon}-year holds · S&amp;P assumed at {fmtPlain(indexReturn, 1)}/yr
            · measured on each position&apos;s own past return
          </span>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>Your situation</div>
        <div className={styles.cardSub}>
          Shared with the <strong>Tax on Selling</strong> tab — change it in either place.
        </div>
        {taxInputs}
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>Assumptions</div>
        <div className={styles.cardSub}>
          Every row is priced against the same index return and the same horizon, which is what
          makes them comparable.
        </div>
        <div className={styles.inputRow}>
          <label className={styles.inputField}>
            <span>S&amp;P return a year</span>
            <input type="text" inputMode="decimal"
              placeholder={(defaultIndexReturn * 100).toFixed(1)}
              value={indexText} onChange={e => setIndexText(e.target.value)} />
          </label>
          <label className={styles.inputField}>
            <span>Tax rate when you sell</span>
            <input type="text" inputMode="decimal" placeholder="implied by each position"
              value={futureRateText} onChange={e => setFutureRateText(e.target.value)} />
          </label>
        </div>
        <div className={styles.pillGroup} style={{ marginTop: 12, marginRight: 8 }}>
          {HORIZONS.map(h => (
            <button key={h} type="button"
              className={`${styles.pill} ${horizon === h ? styles.pillActive : ''}`}
              onClick={() => setHorizon(h)}>
              {h}y
            </button>
          ))}
        </div>
        <div className={styles.pillGroup} style={{ marginTop: 12 }}>
          {[
            { id: false, label: 'I\'ll sell eventually' },
            { id: true, label: 'I\'ll never sell' },
          ].map(o => (
            <button key={String(o.id)} type="button"
              className={`${styles.pill} ${forever === o.id ? styles.pillActive : ''}`}
              onClick={() => setForever(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div>
            <div className={styles.cardTitle}>How much room each one has</div>
            <div className={styles.cardSub}>
              What each position has actually returned a year, less what it must return over the
              next {horizon} years for keeping it to beat switching to the index. Bars to the right
              are clearing their own bar; bars to the left are not. Thickness is the size of the
              holding — a narrow miss on a large position is worth more of your attention than a
              wide one on a rounding error. Click any bar to open it in full.
            </div>
          </div>
          <div className={styles.legend}>
            <span><span className={styles.legendDot} style={{ background: WIN }} /> Clearing ({clearing.length})</span>
            <span><span className={styles.legendDot} style={{ background: LOSE }} /> Not ({failing.length})</span>
          </div>
        </div>
        <MarginBars rows={rows} onSelect={onSelect} selected={selected} />
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>Position by position</div>
        <div className={styles.cardSub}>
          <strong>Needs</strong> is the return that would make keeping the position exactly as good
          as selling it and buying the index. <strong>Has done</strong> is what your own money in it
          has actually annualized. Where "has done" is the larger, the position has been clearing
          its bar — which is a record, not a promise.
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Ticker</th>
                <th className={styles.num}>Value</th>
                <th className={styles.num}>Gain</th>
                <th className={styles.num}>Tax to sell</th>
                <th className={styles.num}>Reaches the index</th>
                <th className={styles.num}>Needs</th>
                <th className={styles.num}>Has done</th>
                <th className={styles.num}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.symbol}
                  className={`${styles.clickRow} ${selected === r.symbol ? styles.clickRowActive : ''}`}
                  onClick={() => onSelect?.(r.symbol)}>
                  <td><strong>{r.symbol}</strong></td>
                  <td className={styles.num}>{fmt(r.sale.proceeds)}</td>
                  <td className={`${styles.num} ${r.sale.gain >= 0 ? styles.up : styles.down}`}>
                    {fmtSigned(r.sale.gain)}
                  </td>
                  <td className={styles.num}>
                    {r.taxCost < 0 ? `−${fmt(-r.taxCost)}` : fmt(r.taxCost)}
                  </td>
                  <td className={`${styles.num} ${styles.muted}`}>{fmt(r.netProceeds)}</td>
                  <td className={styles.num}>{fmtPlain(r.required, 1)}</td>
                  <td className={styles.num}>{fmtPlain(r.historic, 1)}</td>
                  <td className={`${styles.num} ${r.margin == null ? styles.muted : r.margin >= 0 ? styles.up : styles.down}`}>
                    <strong>
                      {r.margin == null
                        ? '—'
                        : `${r.margin > 0 ? '+' : '−'}${fmtPlain(Math.abs(r.margin), 1)}`}
                    </strong>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td><strong>{rows.length} positions</strong></td>
                <td className={styles.num}><strong>{fmt(totalValue)}</strong></td>
                <td className={styles.num}>
                  <strong>{fmtSigned(rows.reduce((s, r) => s + r.sale.gain, 0))}</strong>
                </td>
                <td className={styles.num}><strong>{fmt(summedTax)}</strong></td>
                <td className={`${styles.num} ${styles.muted}`}>
                  <strong>{fmt(totalValue - summedTax)}</strong>
                </td>
                <td className={styles.num} colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>

        {sellEverything && (
          <div className={styles.noteCard} style={{ marginTop: 14 }}>
            <div className={styles.noteTitle}>
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>functions</span>
              The tax column does not add up — and that is not a rounding error
            </div>
            <div className={styles.cardSub} style={{ marginTop: 2 }}>
              Each row is priced as though it were the only thing you sold, which is what makes the
              rows comparable. But gains stack: sell several together and the later ones are pushed
              into higher bands. Selling every position one-at-a-time in separate years comes to{' '}
              <strong>{fmt(summedTax)}</strong>; selling the lot of them in one year costs{' '}
              <strong>{fmt(sellEverything.cost)}</strong>
              {sellEverything.cost > summedTax + 1 && (
                <> — <strong>{fmt(sellEverything.cost - summedTax)}</strong> more, which is the
                  price of doing it all at once</>
              )}. The <strong>Tax on Selling</strong> tab models any combination properly.
            </div>
          </div>
        )}

        <div className={styles.cardSub} style={{ marginTop: 12 }}>
          <strong>Past return is not a forecast.</strong> Ranking on what a position has done
          assumes it keeps doing it, and the holdings at the top of this list are the ones that
          have run hottest — historically the least likely to repeat. Read it as a list of which
          positions have the least room, not as a list of what to sell. Concentration, and whether
          you still want to own the business, belong in the decision and are nowhere in this table.
        </div>
      </div>
    </>
  );
}

// ── Page ────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'benchmark', label: 'S&P Benchmark' },
  { id: 'trades', label: 'My Trades' },
  { id: 'inflation', label: 'vs Inflation' },
  { id: 'tax', label: 'Tax on Selling' },
  { id: 'stock', label: 'Keep or Switch' },
];

/**
 * Consumer prices, loaded once for the whole page.
 *
 * Returns null while in flight, and an object carrying either a usable series
 * or an `error` — never a partial one. A missing CPI has to stay visible as a
 * missing CPI: an inflation comparison that quietly falls back to an assumed
 * 2%/yr would be indistinguishable from a real one and wrong by thousands.
 */
function useCpi() {
  const [state, setState] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const accept = (payload) => {
      if (cancelled) return;
      setState({
        // `series` is the lookup structure the math wants; the BLS identifier
        // is kept apart under its own name so it can't be rendered by mistake.
        series: makeCpiSeries(payload.points),
        seriesId: payload.series,
        label: payload.label,
        latest: payload.latest,
        missingMonths: payload.missingMonths || 0,
        error: null,
      });
    };
    fetchCpi(CPI_START_YEAR, { onFresh: accept })
      .then(({ payload }) => accept(payload))
      .catch(err => { if (!cancelled) setState({ series: null, error: err.message }); });
    return () => { cancelled = true; };
  }, []);

  return state;
}

export function StockPerformancePage() {
  const [tab, setTab] = useState('benchmark');
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const cpi = useCpi();

  useEffect(() => {
    let cancelled = false;
    fetchSeries(BENCHMARK_SYMBOL, SERIES_START, {
      onFresh: (fresh) => { if (!cancelled) setPayload(fresh); },
    })
      .then(({ payload: p }) => {
        if (cancelled) return;
        setPayload(p);
        setError(null);
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const series = useMemo(() => (payload ? makeSeries(payload.points) : null), [payload]);
  const meta = useMemo(() => ({
    totalReturn: payload?.totalReturn ?? true,
    warning: payload?.warning || null,
    asOf: payload?.points?.length ? toISODate(payload.points[payload.points.length - 1][0] * 1000) : null,
  }), [payload]);

  if (loading && !series) {
    return <div className={styles.page}><div className={styles.emptyState}>Loading S&amp;P 500 history…</div></div>;
  }

  if (!series || !series.length) {
    return (
      <div className={styles.page}>
        <div className={styles.hero}>
          <div className={styles.heroLabel}>Stock Performance</div>
          <div className={styles.heroTitle}>Couldn't load the S&amp;P 500 series</div>
          <div className={styles.heroSubtitle}>{error || 'No price history was returned.'}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.tabBar}>
        {TABS.map(t => (
          <button key={t.id} type="button"
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'benchmark' && <BenchmarkTab series={series} meta={meta} cpi={cpi} />}
      {tab === 'trades' && <TradesTab series={series} meta={meta} cpi={cpi} />}
      {tab === 'inflation' && <InflationTab series={series} cpi={cpi} />}
      {tab === 'tax' && <TaxTab series={series} />}
      {tab === 'stock' && <SingleStockTab series={series} cpi={cpi} />}
    </div>
  );
}

export default StockPerformancePage;
