import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { computeIncome, monthKeysEnding, monthKeyFor, commissionTakeHome, forecastPayroll } from '../lib/income';
import { expectedPayouts, isPayroll } from '../lib/commissions';
import { useCommissions } from '../hooks/useCommissions';
import { CommissionsIncomeCard, ExpectedCommissionsCard } from '../components/CommissionsIncomeCard';
import styles from './IncomePage.module.css';

/* Just the income: where it comes from, how regularly, how it's trending.
   What counts as income is decided in lib/income.js. */

// Categorical slots 1–3 (validated all-pairs; dataviz palette).
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];
const OTHER = '#94a3b8';
// Income by month: the paycheck split into base and commission, then the rest.
const PARTS = [
  { key: 'base', label: 'Base salary', color: SERIES[0] },
  { key: 'commission', label: 'Commissions', color: SERIES[1] },
  { key: 'other', label: 'Other income', color: SERIES[2] },
];
const AHEAD = 6;

const RANGES = [
  { months: 6, label: '6M' },
  { months: 12, label: '12M' },
  { months: 24, label: '24M' },
  { months: 0, label: 'All' },
];

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const short = key => { const [y, m] = key.split('-'); return `${MONTH_SHORT[m - 1]} ${y.slice(2)}`; };
const long = key => { const [y, m] = key.split('-'); return `${MONTH_LONG[m - 1]} ${y}`; };
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
// Small figures (interest, a dividend) keep their cents rather than reading "$0".
const amt = n => (Math.abs(n) < 10 ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n) : money(n));
const cents = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const pct = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n * 100))}%`;
const axis = n => (n >= 1000 ? `$${Math.round(n / 100) / 10}k` : `$${Math.round(n)}`);
const day = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const dayY = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Starts at the minimum and grows to the container: starting wide would prop
// the container open and the measurement would read its own width back.
function useMeasuredWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setWidth(Math.max(320, Math.round(el.clientWidth || 320)));
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(s => s * p).find(s => s >= v);
}

/** Every YYYY-MM from the first transaction to today. */
function monthsSpanned(transactions, today) {
  let first = null;
  for (const t of transactions || []) {
    const d = new Date(t.date);
    if (isNaN(d)) continue;
    const k = monthKeyFor(d);
    if (!first || k < first) first = k;
  }
  if (!first) return [];
  const last = monthKeyFor(today);
  const [fy, fm] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  return monthKeysEnding(last, (ly - fy) * 12 + (lm - fm) + 1);
}

export function IncomePage() {
  const { transactions, incomeCategories, loading } = useData();
  const [range, setRange] = useState(12);
  const [showAll, setShowAll] = useState(false);
  const { commissions, payouts } = useCommissions();

  const result = useMemo(() => {
    if (!transactions?.length) return null;
    const today = new Date();
    const all = monthsSpanned(transactions, today);
    // N complete months plus the one in progress.
    const keys = range ? all.slice(-(range + 1)) : all;
    return computeIncome({ transactions, incomeCategories, monthKeys: keys, today });
  }, [transactions, incomeCategories, range]);

  const outlook = useMemo(() => {
    if (!result) return null;
    const today = new Date();
    const takeHome = commissionTakeHome(result.paychecks, payouts, today);
    return { takeHome, ...forecastPayroll({ paychecks: result.paychecks, payouts: expectedPayouts(commissions, today), takeHome, today, ahead: AHEAD }) };
  }, [result, commissions, payouts]);

  if (loading && !result) return <div className={styles.empty}>Loading transactions…</div>;
  if (!result) return <div className={styles.empty}>No transactions yet.</div>;

  const { months, sources, sourceOrder, summary, current, deposits, credits } = result;
  // Same colours as the chart: payroll in base-salary blue, the rest in other-income green.
  const payrollSources = new Set(deposits.filter(x => isPayroll(x)).map(x => x.source));
  const colorOf = src => (payrollSources.has(src) ? PARTS[0].color : sourceOrder.includes(src) ? PARTS[2].color : OTHER);
  const shownDeposits = showAll ? deposits : deposits.slice(0, 15);
  const complete = months.filter(m => !m.partial);
  const partTotals = Object.fromEntries(PARTS.map(p => [p.key, complete.reduce((s, m) => s + m.parts[p.key], 0)]));

  return (
    <div className={styles.page}>
      <div className={styles.hero} data-testid="income-hero">
        <div className={styles.heroLabel}>Income</div>
        <h1 className={styles.heroTitle}>
          {money(summary.completeTotal)}
          <span className={styles.heroTitleSub}> over the last {summary.completeCount} complete month{summary.completeCount === 1 ? '' : 's'}</span>
        </h1>
        <div className={styles.heroStats}>
          <Stat value={money(summary.avgPerMonth)} label="Average a month" />
          <Stat
            value={summary.change == null ? '—' : pct(summary.change)}
            label="vs the period before"
            sub={summary.prior ? `${money(summary.prior)} then` : 'no income tracked before this range'}
          />
          {summary.latest && (
            <Stat
              value={money(summary.latest.total)}
              label={`${long(summary.latest.key)}`}
              sub={[
                summary.latest.vsAvg != null ? `${pct(summary.latest.vsAvg)} vs average` : null,
                summary.latest.lastYear ? `${money(summary.latest.lastYear)} a year earlier` : null,
              ].filter(Boolean).join(' · ')}
            />
          )}
          {summary.best && <Stat value={money(summary.best.total)} label="Best month" sub={long(summary.best.key)} />}
        </div>
      </div>

      <div className={styles.controls}>
        <div className={styles.segment} role="group" aria-label="Time range">
          {RANGES.map(r => (
            <button
              key={r.label}
              type="button"
              className={`${styles.segmentBtn} ${range === r.months ? styles.segmentActive : ''}`}
              onClick={() => setRange(r.months)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className={styles.controlsNote}>
          Counting {summary.categories.map(c => `“${c}”`).join(', ')}
          {summary.usingDefaults ? ' (Cash Flow’s defaults — set your own in the Income bucket on Transactions)' : ' — the Income bucket on Transactions'}.
          Transfers and investments never count.
        </div>
      </div>

      {current && (
        <section className={styles.card} data-testid="income-current">
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>{long(current.key)} so far</h2>
              <div className={styles.cardHint}>
                {money(current.received)} received
                {current.due.length > 0 && <> · {money(current.expected)} still expected · about {money(current.projected)} for the month</>}
                {current.due.length === 0 && ' · nothing else expected from your regular payers'}
              </div>
            </div>
          </div>
          {current.due.length > 0 && (
            <ul className={styles.dueList}>
              {current.due.map((x, i) => (
                <li key={i}>
                  <span className="material-symbols-outlined">schedule</span>
                  <b>{x.name}</b>
                  <span className={styles.muted}>{x.source}</span>
                  <span className={styles.dueWhen}>{x.date < new Date() ? `due ${day(x.date)}` : `around ${day(x.date)}`}</span>
                  <span className={styles.num}>~{amt(x.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>Income by month</h2>
            <div className={styles.cardHint}>
              Base salary is the regular paycheck; commission is what a paycheck carries above it, after tax.
              {complete.length > 0 && <> Over the {complete.length} complete month{complete.length === 1 ? '' : 's'}: {PARTS.map(p => `${p.label.toLowerCase()} ${money(partTotals[p.key])}`).join(' · ')}.</>}
              {' '}Faded bars are what’s still expected from payroll. The tick is the same month a year earlier.
            </div>
          </div>
          <div className={styles.legend}>
            {PARTS.map(p => <span key={p.key}><i style={{ background: p.color }} />{p.label}</span>)}
            <span><i className={styles.legendExpected} />Expected</span>
            <span><i className={styles.legendTick} />A year earlier</span>
          </div>
        </div>
        <MonthlyChart months={months} forecast={outlook?.months || []} />
      </section>

      {outlook && <ExpectedCommissionsCard upcoming={outlook.upcoming} takeHome={outlook.takeHome} />}

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>Sources</h2>
            <div className={styles.cardHint}>Who pays you, how often, and when the next one is due.</div>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="income-sources">
            <thead>
              <tr>
                <th>Source</th>
                <th className={styles.num}>Total</th>
                <th>Share</th>
                <th className={styles.num}>Avg / month</th>
                <th>Paid by</th>
              </tr>
            </thead>
            <tbody>
              {sources.map(s => (
                <tr key={s.source}>
                  <td>
                    <div className={styles.sourceName}><i style={{ background: colorOf(s.source) }} />{s.source}</div>
                    <div className={styles.muted}>{s.count} deposit{s.count === 1 ? '' : 's'} · paid in {s.monthsPaid} of {months.length} months</div>
                  </td>
                  <td className={styles.num}>{amt(s.total)}</td>
                  <td className={styles.shareCell}>
                    <div className={styles.shareBar}><div style={{ width: `${Math.max(2, s.share * 100)}%`, background: colorOf(s.source) }} /></div>
                    <span>{Math.round(s.share * 100)}%</span>
                  </td>
                  <td className={styles.num}>{amt(s.avgPerMonth)}</td>
                  <td>
                    <ul className={styles.payers}>
                      {s.payers.slice(0, 4).map(p => (
                        <li key={p.name}>
                          <b>{p.name}</b>
                          <span className={styles.muted}>
                            {' '}· {p.cadence ? p.cadence.label : `${p.count} payment${p.count === 1 ? '' : 's'}`}
                            {p.cadence && p.cadence.label !== 'irregular' && <> · usually {amt(p.typical)}</>}
                            {' '}· last {day(p.last)}
                            {p.nextExpected && (p.nextExpected >= new Date(new Date().toDateString())
                              ? <> · next ~{day(p.nextExpected)}</>
                              : <> · was due ~{day(p.nextExpected)}</>)}
                          </span>
                        </li>
                      ))}
                      {s.payers.length > 4 && <li className={styles.muted}>and {s.payers.length - 4} more</li>}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <CommissionsIncomeCard transactions={transactions} />

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>Deposits</h2>
            <div className={styles.cardHint}>Every income deposit in the range, newest first.</div>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="income-deposits">
            <thead>
              <tr><th>Date</th><th>Description</th><th>Source</th><th>Account</th><th className={styles.num}>Amount</th></tr>
            </thead>
            <tbody>
              {shownDeposits.map((x, i) => (
                <tr key={i}>
                  <td className={styles.nowrap}>{dayY(x.date)}</td>
                  <td>{x.description}</td>
                  <td className={styles.nowrap}><span className={styles.sourceName}><i style={{ background: colorOf(x.source) }} />{x.source}</span></td>
                  <td className={styles.muted}>{x.account || '—'}</td>
                  <td className={styles.num}>{cents(x.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {deposits.length > 15 && (
          <button type="button" className={styles.linkBtn} onClick={() => setShowAll(v => !v)}>
            {showAll ? 'Show fewer' : `Show all ${deposits.length}`}
          </button>
        )}
      </section>

      {credits.count > 0 && (
        <details className={styles.card}>
          <summary className={styles.summary}>
            <span className={styles.cardTitle}>Refunds &amp; credits: {money(credits.total)}</span>
            <span className={styles.muted}> — {credits.count} in the range. Not income, but Cash Flow counts them in its Income figure, so the two pages reconcile once these are added.</span>
          </summary>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Date</th><th>Description</th><th>Category</th><th className={styles.num}>Amount</th></tr></thead>
              <tbody>
                {credits.top.map((x, i) => (
                  <tr key={i}>
                    <td className={styles.nowrap}>{dayY(x.date)}</td>
                    <td>{x.description}</td>
                    <td className={styles.muted}>{x.category}</td>
                    <td className={styles.num}>{cents(x.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {credits.count > credits.top.length && <div className={styles.muted} style={{ marginTop: 8 }}>The {credits.top.length} largest of {credits.count}.</div>}
        </details>
      )}
    </div>
  );
}

function Stat({ value, label, sub }) {
  return (
    <div>
      <div className={styles.heroStatValue}>{value}</div>
      <div className={styles.heroStatLabel}>{label}</div>
      {sub && <div className={styles.heroStatSub}>{sub}</div>}
    </div>
  );
}

/* Stacked bars of base salary, commission and other income, with what payroll
   should still bring — the rest of this month and the next few — faded on top,
   and a tick for the same month a year earlier. */
function MonthlyChart({ months, forecast }) {
  const [ref, width] = useMeasuredWidth();
  const [hover, setHover] = useState(null);
  const ahead = new Map(forecast.map(f => [f.key, f]));
  const known = new Set(months.map(m => m.key));
  const bars = [
    ...months.map(m => ({ ...m, expected: ahead.get(m.key) || null })),
    ...forecast.filter(f => !known.has(f.key) && f.base + f.commission > 0)
      .map(f => ({ key: f.key, future: true, total: 0, lastYear: 0, parts: { base: 0, commission: 0, other: 0 }, otherBySource: {}, expected: f })),
  ];
  const expectedOf = b => (b.expected ? b.expected.base + b.expected.commission : 0);
  const H = 280;
  const pad = { top: 16, right: 8, bottom: 26, left: 48 };
  const innerW = width - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(...bars.map(b => Math.max(b.total + expectedOf(b), b.lastYear)), 1));
  const step = innerW / bars.length;
  const barW = Math.max(4, Math.min(34, step * 0.62));
  const y = v => pad.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  const labelEvery = Math.ceil(bars.length / Math.floor(innerW / 52));
  const segmentsOf = b => [
    ...PARTS.map(p => ({ key: p.key, color: p.color, value: b.parts[p.key] || 0 })),
    ...(b.expected ? [
      { key: 'expected-base', color: PARTS[0].color, value: b.expected.base, expected: true },
      { key: 'expected-commission', color: PARTS[1].color, value: b.expected.commission, expected: true },
    ] : []),
  ].filter(s => s.value > 0);

  return (
    <div ref={ref} className={styles.chartWrap} data-testid="income-by-month">
      <svg width={width} height={H} role="img" aria-label="Income by month: base salary, commissions and other income, with expected payroll">
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--color-surface-alt)" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className={styles.axisText}>{axis(t)}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const cx = pad.left + step * i + step / 2;
          const x0 = cx - barW / 2;
          let base = 0;
          const segs = segmentsOf(b);
          return (
            <g key={b.key} data-month={b.key}>
              {segs.map((s, j) => {
                const top = y(base + s.value);
                const h = y(base) - top;
                base += s.value;
                const isTop = j === segs.length - 1;
                // 2px surface gap between stacked segments; the top one gets the rounded data end.
                const gap = j > 0 ? 2 : 0;
                const hh = Math.max(0, h - gap);
                if (hh <= 0) return null;
                const r = isTop ? Math.min(4, barW / 2, hh) : 0;
                return (
                  <path
                    key={s.key}
                    data-part={s.key}
                    d={`M${x0},${top + hh} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top + r} V${top + hh} Z`}
                    fill={s.color}
                    fillOpacity={s.expected ? 0.3 : 1}
                    stroke={s.expected ? s.color : 'none'}
                    strokeDasharray={s.expected ? '3 2' : undefined}
                  />
                );
              })}
              {b.lastYear > 0 && (
                <line x1={x0 - 3} x2={x0 + barW + 3} y1={y(b.lastYear)} y2={y(b.lastYear)} stroke="var(--color-text-primary)" strokeWidth={2} strokeLinecap="round" />
              )}
            </g>
          );
        })}
        {bars.map((b, i) => i % labelEvery === 0 && (
          <text key={b.key} x={pad.left + step * i + step / 2} y={H - 8} textAnchor="middle" className={styles.axisText}>
            {short(b.key)}{b.partial ? '*' : ''}
          </text>
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--color-text-muted)" />
        {bars.map((b, i) => (
          <rect
            key={b.key}
            x={pad.left + step * i}
            y={pad.top}
            width={step}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {hover != null && bars[hover] && (() => {
        const b = bars[hover];
        const x = b.expected;
        const others = Object.entries(b.otherBySource || {}).sort((p, q) => q[1] - p[1]);
        const left = Math.min(width - 250, Math.max(0, pad.left + step * hover + step / 2 - 125));
        return (
          <div className={styles.tooltip} style={{ left, top: 4 }} data-testid="income-tooltip">
            <div className={styles.tooltipTitle}>{long(b.key)}{b.partial ? ' (so far)' : b.future ? ' (expected)' : ''}</div>
            {!b.future && PARTS.map(p => (
              <div key={p.key}><i style={{ background: p.color }} />{p.label}<b>{money(b.parts[p.key])}</b></div>
            ))}
            {others.slice(0, 3).map(([src, v]) => (
              <div key={src} className={styles.tooltipSub}>{src}<b>{money(v)}</b></div>
            ))}
            {others.length > 3 && <div className={styles.tooltipSub}>and {others.length - 3} more</div>}
            {!b.future && <div className={styles.tooltipTotal}>{b.partial ? 'Received' : 'Total'}<b>{money(b.total)}</b></div>}
            {x && x.base > 0 && <div><i style={{ background: PARTS[0].color, opacity: 0.35 }} />Expected base · {x.paychecks} paycheck{x.paychecks === 1 ? '' : 's'}<b>{money(x.base)}</b></div>}
            {x && x.commission > 0 && <div><i style={{ background: PARTS[1].color, opacity: 0.35 }} />Expected commission<b>{money(x.commission)}</b></div>}
            {x && x.commission > 0 && <div className={styles.tooltipSub}>{money(x.commissionPreTax)} pre-tax{x.projected ? ', projected' : ''}</div>}
            {x && x.base + x.commission > 0 && <div className={styles.tooltipTotal}>{b.future ? 'Expected' : 'Month, expected'}<b>{money(b.total + x.base + x.commission)}</b></div>}
            {b.lastYear > 0 && <div className={styles.muted}>A year earlier<b>{money(b.lastYear)}</b></div>}
          </div>
        );
      })()}
      {bars.some(b => b.partial) && <div className={styles.chartFoot}>* month in progress</div>}
    </div>
  );
}
