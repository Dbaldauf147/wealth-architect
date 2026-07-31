import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { fetchSeries, fetchQuotes } from '../lib/marketData';
import {
  makeSeries, cagr, returnBetween, calendarYearReturns, rollingReturns,
  growthPath, maxDrawdown, toISODate, MS_DAY,
} from '../lib/benchmark';
import { parseTradesCsv, buildLots } from '../lib/robinhood';
import { benchmarkLots, openSymbols } from '../lib/tradeBenchmark';
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

// ── Benchmark tab ───────────────────────────────────────────────────────
function BenchmarkTab({ series, meta }) {
  const [rangeId, setRangeId] = useState('20y');
  const [initial, setInitial] = useState('10000');
  const [monthly, setMonthly] = useState('0');

  const range = RANGE_OPTIONS.find(o => o.id === rangeId) || RANGE_OPTIONS[2];
  const endT = series.lastT;
  const startT = range.years
    ? Math.max(series.firstT, endT - range.years * 365.25 * MS_DAY)
    : series.firstT;

  const initialAmount = Math.max(0, Number(initial) || 0);
  const monthlyAmount = Math.max(0, Number(monthly) || 0);

  const path = useMemo(
    () => growthPath(series, { initial: initialAmount, monthly: monthlyAmount, fromT: startT, toT: endT }),
    [series, initialAmount, monthlyAmount, startT, endT],
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
        <div className={styles.inputRow}>
          <label className={styles.inputField}>
            <span>Invested upfront</span>
            <input type="number" min="0" step="1000" value={initial}
              onChange={e => setInitial(e.target.value)} />
          </label>
          <label className={styles.inputField}>
            <span>Added monthly</span>
            <input type="number" min="0" step="100" value={monthly}
              onChange={e => setMonthly(e.target.value)} />
          </label>
        </div>
      </div>

      <div className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div>
            <div className={styles.cardTitle}>
              {fmt(initialAmount)}
              {monthlyAmount > 0 && ` + ${fmt(monthlyAmount)}/mo`}
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

// ── Import panel ────────────────────────────────────────────────────────
function ImportPanel({ onImport, error, compact }) {
  const fileRef = useRef(null);
  const [paste, setPaste] = useState('');
  const [dragging, setDragging] = useState(false);

  const handleFiles = useCallback(async (files) => {
    const file = files?.[0];
    if (!file) return;
    onImport(await file.text(), file.name);
  }, [onImport]);

  return (
    <div className={`${styles.card} ${compact ? styles.compact : ''}`}>
      <div className={styles.cardTitle}>Import your Robinhood trades</div>
      <div className={styles.cardSub}>
        In Robinhood: <strong>Account → Settings → Reports and statements → Reports → Generate
        an Activity report</strong>, pick a date range, then download the CSV. Drop it below.
        Nothing leaves your browser except the ticker symbols needed to price open positions.
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
        <input ref={fileRef} type="file" accept=".csv,.txt,text/csv" hidden
          onChange={e => { handleFiles(e.target.files); e.target.value = ''; }} />
      </div>

      <details className={styles.details}>
        <summary>…or paste the rows instead</summary>
        <textarea
          className={styles.textarea}
          rows={6}
          value={paste}
          placeholder={'Activity Date,Process Date,Settle Date,Instrument,Description,Trans Code,Quantity,Price,Amount\n…'}
          onChange={e => setPaste(e.target.value)}
        />
        <button type="button" className={styles.primaryBtn}
          disabled={!paste.trim()}
          onClick={() => { onImport(paste, 'pasted rows'); setPaste(''); }}>
          Parse pasted rows
        </button>
      </details>

      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}

// ── Trades tab ──────────────────────────────────────────────────────────
function TradesTab({ series, meta }) {
  const { robinhoodTrades } = useData();
  const { setRobinhoodTrades } = useDataActions();
  const [importError, setImportError] = useState(null);
  const [quoteResult, setQuoteResult] = useState(null);
  const [showLots, setShowLots] = useState(false);
  const [reimporting, setReimporting] = useState(false);

  const trades = useMemo(() => robinhoodTrades?.trades || [], [robinhoodTrades]);
  const lots = useMemo(() => (trades.length ? buildLots(trades) : null), [trades]);

  // Open positions need a live price to be worth anything. Closed lots don't,
  // so an all-closed import renders without a single network call. Keyed as a
  // string so the effect doesn't re-run on an identical list.
  const quoteKey = useMemo(() => (lots ? openSymbols(lots).sort().join(',') : ''), [lots]);

  useEffect(() => {
    if (!quoteKey) return undefined;
    let cancelled = false;
    fetchQuotes(quoteKey.split(','))
      // Per-symbol failures come back inside the result, so a rejection here
      // means the whole request died — record an empty set and let the
      // caveats panel report the unpriced lots.
      .catch(() => ({}))
      .then(q => { if (!cancelled) setQuoteResult({ key: quoteKey, quotes: q }); });
    return () => { cancelled = true; };
  }, [quoteKey]);

  // Only trust quotes fetched for the current symbol list — otherwise a fresh
  // import would briefly be priced with the previous import's quotes.
  const quotes = quoteResult?.key === quoteKey ? quoteResult.quotes : null;
  const awaitingQuotes = quoteKey !== '' && quotes === null;

  const result = useMemo(() => {
    if (!lots || awaitingQuotes) return null;
    return benchmarkLots(lots, series, quotes || {}, series.lastT);
  }, [lots, series, quotes, awaitingQuotes]);

  const handleImport = useCallback((text, sourceName) => {
    const parsed = parseTradesCsv(text);
    if (parsed.errors.length) { setImportError(parsed.errors.join(' ')); return; }
    // Firestore caps a document at 1MB and this shares one with every other
    // setting, so keep the payload lean.
    const MAX_TRADES = 4000;
    const kept = parsed.trades.slice(-MAX_TRADES).map(t => ({
      date: t.date, symbol: t.symbol, side: t.side,
      quantity: t.quantity, price: t.price, amount: t.amount,
    }));
    setImportError(null);
    setRobinhoodTrades({
      trades: kept,
      importedAt: new Date().toISOString(),
      source: sourceName || '',
      skipped: parsed.skipped,
      truncated: parsed.trades.length > MAX_TRADES ? parsed.trades.length - MAX_TRADES : 0,
    });
    setReimporting(false);
  }, [setRobinhoodTrades]);

  if (!trades.length) {
    return <ImportPanel onImport={handleImport} error={importError} />;
  }

  const skipped = robinhoodTrades?.skipped || {};
  const beat = result && result.totals.alpha >= 0;

  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroLabel}>Your trades vs the S&amp;P 500</div>
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
              {fmtSigned(result.totals.alpha)}
              <span className={styles.heroUnit}>{beat ? ' ahead' : ' behind'}</span>
            </div>
            <div className={styles.heroChange}>
              <span className={beat ? styles.changeUp : styles.changeDown}>
                You {fmtPct(result.totals.ret)} · S&amp;P {fmtPct(result.totals.benchRet)}
              </span>
              <span className={styles.changeRange}>
                · {fmt(result.totals.invested)} invested across {result.totals.lots} lots
              </span>
            </div>
          </>
        )}
      </div>

      {result && result.totals.lots > 0 && (
        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>You turned</div>
            <div className={styles.statValue}>{fmt(result.totals.invested)}</div>
            <div className={styles.statSub}>into {fmt(result.totals.returned)}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>The S&amp;P would have</div>
            <div className={styles.statValue}>{fmt(result.totals.benchReturned)}</div>
            <div className={styles.statSub}>same dollars, same dates</div>
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

      {result && result.symbols.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardTitle}>By ticker</div>
          <div className={styles.cardSub}>
            Sorted by dollars gained or lost against the benchmark. "S&amp;P" is what the same
            money would have done over the exact same holding periods.
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th className={styles.num}>Invested</th>
                  <th className={styles.num}>Now worth</th>
                  <th className={styles.num}>You</th>
                  <th className={styles.num}>S&amp;P</th>
                  <th className={styles.num}>Difference</th>
                  <th className={styles.num}>Lots</th>
                </tr>
              </thead>
              <tbody>
                {result.symbols.map(s => (
                  <tr key={s.symbol}>
                    <td><strong>{s.symbol}</strong></td>
                    <td className={styles.num}>{fmt(s.invested)}</td>
                    <td className={styles.num}>{fmt(s.returned)}</td>
                    <td className={`${styles.num} ${s.ret >= 0 ? styles.up : styles.down}`}>{fmtPct(s.ret)}</td>
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

      {result && result.rows.length > 0 && (
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
                    <th className={styles.num}>You</th>
                    <th className={styles.num}>S&amp;P</th>
                    <th className={styles.num}>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i}>
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
          {robinhoodTrades?.importedAt ? ` · imported ${fmtDay(Date.parse(robinhoodTrades.importedAt))}` : ''}
        </span>
        <span className={styles.footerActions}>
          <button type="button" className={styles.ghostBtn} onClick={() => setReimporting(v => !v)}>
            {reimporting ? 'Cancel' : 'Import another file'}
          </button>
          <button type="button" className={styles.dangerBtn}
            onClick={() => { if (confirm('Remove the imported trades?')) setRobinhoodTrades(null); }}>
            Clear trades
          </button>
        </span>
      </div>

      {reimporting && <ImportPanel onImport={handleImport} error={importError} compact />}
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
  if (skipped.nonTrade) {
    const codes = (skipped.nonTradeCodes || []).slice(0, 5).map(([c, n]) => `${c} ×${n}`).join(', ');
    notes.push(`${skipped.nonTrade} non-trade row${skipped.nonTrade === 1 ? '' : 's'} ignored${codes ? ` (${codes})` : ''} — dividends, transfers and fees aren't part of a trade's return.`);
  }

  if (!notes.length) return null;

  return (
    <div className={styles.noteCard}>
      <div className={styles.noteTitle}>
        <span className="material-symbols-outlined" style={{ fontSize: 17 }}>info</span>
        What this comparison leaves out
      </div>
      <ul className={styles.noteList}>
        {notes.map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    </div>
  );
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
