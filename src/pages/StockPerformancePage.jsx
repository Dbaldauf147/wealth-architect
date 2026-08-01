import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { fetchSeries, fetchQuotes } from '../lib/marketData';
import {
  makeSeries, cagr, returnBetween, calendarYearReturns, rollingReturns,
  growthPath, maxDrawdown, toISODate, MS_DAY,
} from '../lib/benchmark';
import {
  readTable, guessMapping, missingFields, parseRows, sortTrades,
  mergeTrades, mergeCorporateActions, mergeIncome, mergeCashRows, buildLots,
  tradedSymbols, hydrateTrades, hydrateActions, hydrateIncome, hydrateCashRows, FIELDS,
} from '../lib/robinhood';
import { benchmarkLots, externalCashComparison } from '../lib/tradeBenchmark';
import { priceSeries, buildPortfolioHistory, contributionEvents } from '../lib/portfolioHistory';
import styles from './StockPerformancePage.module.css';

// The S&P 500 *total return* index — dividends reinvested. Using the price
// index instead would understate the benchmark by roughly 1.8%/yr, which
// over 20 years is the difference between beating the market and not.
const BENCHMARK_SYMBOL = '^SP500TR';
const SERIES_START = '1999-12-31';

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

/** The whole-account summary shown on the benchmark tab. */
function MyMoneySection({ series }) {
  const { trades, income, cashRows, quotes, lots, result, external } = usePortfolio(series);

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

  const last = history.points[history.points.length - 1];
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

      <PortfolioHistoryChart history={history.points} events={events} />

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
function BenchmarkTab({ series, meta }) {
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
                <th className={styles.num}>Made money</th>
                <th className={styles.num}>Windows</th>
              </tr>
            </thead>
            <tbody>
              {rolling.map(r => (
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
                  <td className={styles.num}>{Math.round(r.positivePct * 100)}%</td>
                  <td className={`${styles.num} ${styles.muted}`}>{r.count}</td>
                </tr>
              ))}
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
function AlphaBars({ symbols, onSelect, selected }) {
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
              <title>{`${s.symbol}: ${fmt(s.invested)} invested · you ${fmtPct(s.ret)} vs S&P ${fmtPct(s.benchRet)} · ${fmtSigned(s.alpha)}`}</title>
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

function TickerDetail({ symbol, rows, summary, series, onClose }) {
  const [loaded, setLoaded] = useState(null);
  // A position that came through a reorganisation spans several tickers whose
  // price histories don't line up — the ticker was renamed mid-life — so there
  // is no single series to chart it against.
  const basket = rows.find(r => r.basket)?.basket || null;

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
      for (const r of rows) {
        if (r.buyT > t) continue;
        if (!r.open && t >= r.exitT) {
          // Sold: the money stops compounding at what it actually realised.
          you += r.value;
          sp += r.benchValue;
          continue;
        }
        const buyPx = tickerSeries.closeAt(r.buyT);
        const nowPx = tickerSeries.closeAt(t);
        const spBuy = series.closeAt(r.buyT);
        const spNow = series.closeAt(t);
        if (!buyPx || !nowPx || !spBuy || !spNow) continue;
        you += r.costBasis * (nowPx / buyPx);
        sp += r.costBasis * (spNow / spBuy);
      }
      out.push({ t, you, sp });
    }
    return out.length >= 2 ? { points: out, unpriceable } : null;
  }, [tickerSeries, rows, series, firstBuyT]);

  const W = 880, H = 300;
  const pad = { top: 16, right: 16, bottom: 32, left: 68 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const chart = useMemo(() => {
    if (!path) return null;
    const pts = path.points;
    const values = pts.flatMap(p => [p.you, p.sp]);
    const hi = Math.max(...values) * 1.06;
    const lo = Math.min(Math.min(...values) * 0.94, 0);
    const tMin = pts[0].t;
    const tSpan = Math.max(pts[pts.length - 1].t - tMin, 1);
    const x = (t) => pad.left + ((t - tMin) / tSpan) * innerW;
    const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * innerH;
    const line = (key) => pts.map(p => `${x(p.t)} ${y(p[key])}`).join(' L ');
    return {
      x, y, tMin, ticks: ticksFor(lo, hi, 5),
      youPath: `M ${line('you')}`,
      spPath: `M ${line('sp')}`,
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
        <button type="button" className={styles.ghostBtn} onClick={onClose}>Close</button>
      </div>

      {summary && (
        <div className={styles.miniStats}>
          <span><b>{fmt(summary.invested)}</b> invested</span>
          <span><b>{fmt(summary.returned)}</b> now worth</span>
          {summary.income > 0 && <span><b>{fmt(summary.income)}</b> dividends</span>}
          <span className={summary.ret >= 0 ? styles.up : styles.down}><b>{fmtPct(summary.ret)}</b> you</span>
          <span><b>{fmtPct(summary.benchRet)}</b> S&amp;P</span>
          <span className={summary.alpha >= 0 ? styles.up : styles.down}>
            <b>{fmtSigned(summary.alpha)}</b> difference
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

function TradesTab({ series, meta }) {
  const { setRobinhoodTrades } = useDataActions();
  const [showLots, setShowLots] = useState(false);
  const [reimporting, setReimporting] = useState(false);
  const [view, setView] = useState('summary');
  const [selected, setSelected] = useState(null);

  const {
    robinhoodTrades, trades, corporateActions, income, cashRows, quotes, lots, result, external,
  } = usePortfolio(series);

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
            Sorted by dollars gained or lost against the benchmark. "S&amp;P" is what the same
            money would have done over the exact same holding periods. Click a row to chart it
            against the index.
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
                  <th className={styles.num}>Lots</th>
                </tr>
              </thead>
              <tbody>
                {result.symbols.map(s => (
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
                    <td className={`${styles.num} ${styles.muted}`}>
                      {s.closedLots > 0 && `${s.closedLots} closed`}
                      {s.closedLots > 0 && s.openLots > 0 && ', '}
                      {s.openLots > 0 && `${s.openLots} open`}
                    </td>
                  </tr>
                ))}
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
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => (
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
                    </tr>
                  ))}
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
    const codes = (skipped.nonTradeCodes || []).slice(0, 5).map(([c, n]) => `${c} ×${n}`).join(', ');
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

// ── Page ────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'benchmark', label: 'S&P Benchmark' },
  { id: 'trades', label: 'My Trades' },
];

export function StockPerformancePage() {
  const [tab, setTab] = useState('benchmark');
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

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

      {tab === 'benchmark'
        ? <BenchmarkTab series={series} meta={meta} />
        : <TradesTab series={series} meta={meta} />}
    </div>
  );
}

export default StockPerformancePage;
