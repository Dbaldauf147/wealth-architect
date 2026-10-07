import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { computeIncome, monthKeysEnding, monthKeyFor } from '../lib/income';
import styles from './IncomePage.module.css';

/* Just the income: where it comes from, how regularly, how it's trending.
   What counts as income is decided in lib/income.js. */

// Categorical slots 1–3 (validated all-pairs; dataviz palette), then Other.
// Past three, stacked segments fold into Other so yellow never sits on orange.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];
const OTHER = '#94a3b8';
const TOP_N = 3;

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

  const result = useMemo(() => {
    if (!transactions?.length) return null;
    const today = new Date();
    const all = monthsSpanned(transactions, today);
    // N complete months plus the one in progress.
    const keys = range ? all.slice(-(range + 1)) : all;
    return computeIncome({ transactions, incomeCategories, monthKeys: keys, today });
  }, [transactions, incomeCategories, range]);

  if (loading && !result) return <div className={styles.empty}>Loading transactions…</div>;
  if (!result) return <div className={styles.empty}>No transactions yet.</div>;

  const { months, sources, sourceOrder, summary, current, deposits, credits } = result;
  const colorOf = src => {
    const i = sourceOrder.indexOf(src);
    return i >= 0 && i < TOP_N ? SERIES[i] : OTHER;
  };
  const shownDeposits = showAll ? deposits : deposits.slice(0, 15);

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
            <div className={styles.cardHint}>Stacked by source. The tick on each bar is the same month a year earlier.</div>
          </div>
          <div className={styles.legend}>
            {sourceOrder.slice(0, TOP_N).map((s, i) => <span key={s}><i style={{ background: SERIES[i] }} />{s}</span>)}
            {sourceOrder.length > TOP_N && <span><i style={{ background: OTHER }} />Other</span>}
            <span><i className={styles.legendTick} />A year earlier</span>
          </div>
        </div>
        <MonthlyChart months={months} order={sourceOrder} colorOf={colorOf} />
      </section>

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

/* Stacked bars by source, top three named and the rest as Other, with a tick
   for the same month a year earlier. */
function MonthlyChart({ months, order, colorOf }) {
  const [ref, width] = useMeasuredWidth();
  const [hover, setHover] = useState(null);
  const H = 280;
  const pad = { top: 16, right: 8, bottom: 26, left: 48 };
  const innerW = width - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(...months.map(m => Math.max(m.total, m.lastYear)), 1));
  const step = innerW / months.length;
  const barW = Math.max(4, Math.min(34, step * 0.62));
  const y = v => pad.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  const labelEvery = Math.ceil(months.length / Math.floor(innerW / 52));
  const named = order.slice(0, TOP_N);
  const segmentsOf = m => {
    const segs = named.map(s => ({ source: s, value: m.bySource[s] || 0 }));
    const other = Object.entries(m.bySource).filter(([s]) => !named.includes(s)).reduce((a, [, v]) => a + v, 0);
    if (other) segs.push({ source: 'Other', value: other });
    return segs.filter(s => s.value > 0);
  };

  return (
    <div ref={ref} className={styles.chartWrap}>
      <svg width={width} height={H} role="img" aria-label="Income by month, stacked by source">
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--color-surface-alt)" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className={styles.axisText}>{axis(t)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const cx = pad.left + step * i + step / 2;
          const x0 = cx - barW / 2;
          let base = 0;
          const segs = segmentsOf(m);
          return (
            <g key={m.key} opacity={m.partial ? 0.5 : 1}>
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
                    key={s.source}
                    d={`M${x0},${top + hh} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top + r} V${top + hh} Z`}
                    fill={s.source === 'Other' ? OTHER : colorOf(s.source)}
                  />
                );
              })}
              {m.lastYear > 0 && (
                <line x1={x0 - 3} x2={x0 + barW + 3} y1={y(m.lastYear)} y2={y(m.lastYear)} stroke="var(--color-text-primary)" strokeWidth={2} strokeLinecap="round" />
              )}
            </g>
          );
        })}
        {months.map((m, i) => i % labelEvery === 0 && (
          <text key={m.key} x={pad.left + step * i + step / 2} y={H - 8} textAnchor="middle" className={styles.axisText}>
            {short(m.key)}{m.partial ? '*' : ''}
          </text>
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--color-text-muted)" />
        {months.map((m, i) => (
          <rect
            key={m.key}
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
      {hover != null && (() => {
        const m = months[hover];
        const left = Math.min(width - 230, Math.max(0, pad.left + step * hover + step / 2 - 115));
        return (
          <div className={styles.tooltip} style={{ left, top: 4 }}>
            <div className={styles.tooltipTitle}>{long(m.key)}{m.partial ? ' (so far)' : ''}</div>
            {segmentsOf(m).reverse().map(s => (
              <div key={s.source}><i style={{ background: s.source === 'Other' ? OTHER : colorOf(s.source) }} />{s.source}<b>{money(s.value)}</b></div>
            ))}
            <div className={styles.tooltipTotal}>Total<b>{money(m.total)}</b></div>
            {m.lastYear > 0 && <div className={styles.muted}>A year earlier<b>{money(m.lastYear)}</b></div>}
          </div>
        );
      })()}
      {months.some(m => m.partial) && <div className={styles.chartFoot}>* month in progress</div>}
    </div>
  );
}
