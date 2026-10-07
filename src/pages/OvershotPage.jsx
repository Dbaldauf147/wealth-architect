import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { computeOvershot, monthsSpanned } from '../lib/overshot';
import styles from './OvershotPage.module.css';

/* When spending overtakes income. Same income/spending definitions as Cash
   Flow (see lib/overshot.js); this page only asks "which side won, and why". */

// Categorical pair validated with the dataviz palette checker (CVD ΔE 24.7).
// Red is kept for the "over" status, which always carries an icon and label.
const INCOME = '#2a78d6';
const SPENDING = '#eb6834';
const CRITICAL = '#d03b3b';

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
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));
const axis = n => (Math.abs(n) >= 1000 ? `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n) / 100) / 10}k` : `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n))}`);
const dayOf = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// Starts at the minimum and grows to the container: starting wide would prop
// the container open and the measurement would then read its own width back.
function useMeasuredWidth(initial) {
  const ref = useRef(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setWidth(Math.max(320, Math.round(el.clientWidth || initial)));
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [initial]);
  return [ref, width];
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(s => s * p).find(s => s >= v);
}

export function OvershotPage() {
  const { transactions, loading } = useData();
  const [range, setRange] = useState(12);

  const result = useMemo(() => {
    if (!transactions?.length) return null;
    const today = new Date();
    const all = monthsSpanned(transactions, today);
    // The window is N complete months plus the one in progress.
    const keys = range ? all.slice(-(range + 1)) : all;
    return computeOvershot({ transactions, monthKeys: keys, today });
  }, [transactions, range]);

  if (loading && !result) return <div className={styles.empty}>Loading transactions…</div>;
  if (!result || !result.months.length) return <div className={styles.empty}>No transactions yet.</div>;

  const { months, summary, pace } = result;
  const complete = months.filter(m => !m.partial);
  const newestFirst = [...months].reverse();

  return (
    <div className={styles.page}>
      <Hero summary={summary} complete={complete} />

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
          Income and spending counted as on Cash Flow — transfers, card payments and investments are left out, refunds netted in.
        </div>
      </div>

      {pace && <PaceCard pace={pace} />}

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>Income vs spending, by month</h2>
            <div className={styles.cardHint}>Shaded months are the ones where spending overtook income.</div>
          </div>
          <div className={styles.legend}>
            <span><i style={{ background: INCOME }} />Income</span>
            <span><i style={{ background: SPENDING }} />Spending</span>
            <span><i className={styles.legendBand} />Over income</span>
          </div>
        </div>
        <MonthlyChart months={months} />
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>Running surplus</h2>
            <div className={styles.cardHint}>
              Income minus spending, added up month by month from the start of the range. Below the line, you've spent more than you've earned over the period.
            </div>
          </div>
        </div>
        <CumulativeChart months={complete} crossings={summary.crossings} />
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>Month by month</h2>
            <div className={styles.cardHint}>
              For each month over, the day spending passed that month's income, and the categories that ran furthest above their typical month.
            </div>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="overshot-table">
            <thead>
              <tr>
                <th>Month</th>
                <th className={styles.num}>Income</th>
                <th className={styles.num}>Spending</th>
                <th className={styles.num}>Net</th>
                <th>Ran out of income</th>
                <th>What pushed it over</th>
              </tr>
            </thead>
            <tbody>
              {newestFirst.map(m => (
                <tr key={m.key} className={m.over && !m.partial ? styles.rowOver : ''} data-over={m.over && !m.partial ? 'true' : 'false'}>
                  <td className={styles.nowrap}>
                    {long(m.key)}
                    {m.partial
                      ? <div className={styles.muted}>in progress</div>
                      : m.over && <div className={styles.overTag}><span className="material-symbols-outlined">trending_down</span>Over by {money(m.gap)}</div>}
                  </td>
                  <td className={styles.num}>{money(m.income)}</td>
                  <td className={styles.num}>{money(m.spending)}</td>
                  <td className={`${styles.num} ${m.net < 0 ? styles.negText : ''}`}>{signed(m.net)}</td>
                  <td className={styles.nowrap}>
                    {!m.partial && m.runOutDate ? dayOf(m.runOutDate) : '—'}
                  </td>
                  <td>
                    {m.partial || !m.over ? <span className={styles.muted}>—</span> : m.drivers.length ? (
                      <ul className={styles.drivers}>
                        {m.drivers.map(d => (
                          <li key={d.category}>
                            <b>{d.category}</b> {money(d.amount)}
                            <span className={styles.muted}> · {money(d.extra)} over its usual {money(d.typical)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : <span className={styles.muted}>No single category ran high: spending was up across the board, or income came in low.</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Hero({ summary, complete }) {
  const r = summary.rolling;
  const head = {
    above: 'You’re living above your means',
    edge: `${summary.latest ? long(summary.latest) : 'Last month'} overshot, but you’re within your means overall`,
    within: 'You’re living within your means',
    none: 'Not enough history yet',
  }[summary.status];
  const sub = summary.status === 'above'
    ? `Over the last three months you've spent ${money(r.spending)} a month against ${money(r.income)} of income.`
    : summary.status === 'edge'
      ? `Spending beat income that month, but over the last three months income still covers spending${r ? ` (${money(r.income)} in, ${money(r.spending)} out a month)` : ''}.`
      : r
        ? `Over the last three months income has averaged ${money(r.income)} a month and spending ${money(r.spending)}.`
        : 'Income has covered spending in the months so far.';
  const icon = { above: 'warning', edge: 'error', within: 'check_circle', none: 'hourglass_empty' }[summary.status];

  return (
    <div className={`${styles.hero} ${summary.status === 'above' ? styles.heroAbove : ''}`} data-testid="overshot-hero" data-status={summary.status}>
      <div className={styles.heroLabel}>Overshot</div>
      <h1 className={styles.heroTitle}>
        <span className="material-symbols-outlined">{icon}</span>
        {head}
      </h1>
      <p className={styles.heroSubtitle}>{sub}</p>
      <div className={styles.heroStats}>
        <Stat value={`${summary.overCount} of ${summary.completeCount}`} label="Months over income" />
        <Stat value={money(summary.totalGap)} label="Spent beyond income" />
        <Stat
          value={summary.currentStreak ? `${summary.currentStreak} mo` : 'None'}
          label="Current streak"
          sub={summary.longestStreak.length > 1 ? `Longest: ${summary.longestStreak.length} mo (${short(summary.longestStreak.start)} – ${short(summary.longestStreak.end)})` : null}
        />
        <Stat value={signed(summary.net)} label={`Net over ${complete.length} months`} />
      </div>
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

function PaceCard({ pace }) {
  const pct = pace.share != null ? Math.round(pace.share * 100) : null;
  const fill = Math.min(100, pct ?? 0);
  return (
    <section className={`${styles.card} ${styles.pace}`} data-testid="overshot-pace">
      <div className={styles.paceText}>
        <div className={styles.cardTitle}>{long(pace.key)} so far</div>
        <div className={styles.cardHint}>
          {money(pace.spending)} spent{pct != null && <> — {pct}% of a typical month's income ({money(pace.typicalIncome)})</>}
          {pace.income > 0 && <>; {money(pace.income)} has come in</>}. {pace.daysLeft} day{pace.daysLeft === 1 ? '' : 's'} left.
        </div>
        {pace.alreadyOver && (
          <div className={styles.overTag}><span className="material-symbols-outlined">warning</span>Already past a typical month's income</div>
        )}
      </div>
      <div className={styles.paceBar} aria-hidden="true">
        <div style={{ width: `${fill}%`, background: pace.alreadyOver ? CRITICAL : SPENDING }} />
      </div>
    </section>
  );
}

/* Paired bars per month; months over income get a shaded band and a label. */
function MonthlyChart({ months }) {
  const [ref, width] = useMeasuredWidth(320);
  const [hover, setHover] = useState(null);
  const H = 280;
  const pad = { top: 28, right: 8, bottom: 26, left: 48 };
  const innerW = width - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(...months.map(m => Math.max(m.income, m.spending)), 1));
  const step = innerW / months.length;
  const barW = Math.max(3, Math.min(22, (step - 10) / 2));
  const y = v => pad.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  const labelEvery = Math.ceil(months.length / Math.floor(innerW / 52));
  const bar = (x, v, color, opacity) => {
    const top = y(v);
    const h = pad.top + innerH - top;
    if (h <= 0) return null;
    const r = Math.min(4, barW / 2, h);
    // Rounded at the data end only, flat on the baseline.
    return (
      <path
        d={`M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`}
        fill={color}
        opacity={opacity}
      />
    );
  };

  return (
    <div ref={ref} className={styles.chartWrap}>
      <svg width={width} height={H} role="img" aria-label="Monthly income and spending">
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--color-surface-alt)" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className={styles.axisText}>{axis(t)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const cx = pad.left + step * i + step / 2;
          const isOver = m.over && !m.partial;
          return (
            <g key={m.key}>
              {isOver && (
                <>
                  <rect x={cx - step / 2 + 1} y={pad.top} width={step - 2} height={innerH} fill={CRITICAL} opacity={0.08} rx={3} />
                  <text x={cx} y={pad.top - 8} textAnchor="middle" className={styles.overLabel}>▲ {axis(m.gap)}</text>
                </>
              )}
              {bar(cx - barW - 1, m.income, INCOME, m.partial ? 0.45 : 1)}
              {bar(cx + 1, m.spending, SPENDING, m.partial ? 0.45 : 1)}
              {i % labelEvery === 0 && (
                <text x={cx} y={H - 8} textAnchor="middle" className={styles.axisText}>
                  {short(m.key)}{m.partial ? '*' : ''}
                </text>
              )}
              <rect
                x={cx - step / 2}
                y={pad.top}
                width={step}
                height={innerH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--color-text-muted)" />
      </svg>
      {hover != null && (() => {
        const m = months[hover];
        const left = Math.min(width - 200, Math.max(0, pad.left + step * hover + step / 2 - 100));
        return (
          <div className={styles.tooltip} style={{ left, top: 4 }}>
            <div className={styles.tooltipTitle}>{long(m.key)}{m.partial ? ' (so far)' : ''}</div>
            <div><i style={{ background: INCOME }} />Income <b>{money(m.income)}</b></div>
            <div><i style={{ background: SPENDING }} />Spending <b>{money(m.spending)}</b></div>
            <div className={styles.tooltipNet}>
              {m.partial
                ? (m.over ? `Spending ahead by ${money(m.gap)} so far` : `${money(m.net)} ahead so far`)
                : m.over ? `Over by ${money(m.gap)}` : `${money(m.net)} left over`}
            </div>
          </div>
        );
      })()}
      {months.some(m => m.partial) && <div className={styles.chartFoot}>* month in progress</div>}
    </div>
  );
}

/* The running total of income − spending over complete months. */
function CumulativeChart({ months, crossings }) {
  const [ref, width] = useMeasuredWidth(320);
  const [hover, setHover] = useState(null);
  if (months.length < 2) return <div className={styles.muted}>Needs at least two complete months.</div>;
  const H = 220;
  const pad = { top: 16, right: 12, bottom: 26, left: 56 };
  const innerW = width - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const vals = months.map(m => m.cumulative);
  const hi = Math.max(0, ...vals);
  const lo = Math.min(0, ...vals);
  // Ticks on a round step that covers both the high and the low, with zero
  // always on a gridline.
  const stepV = niceMax(Math.max(hi - lo, 1) / 4);
  const top = Math.ceil(hi / stepV) * stepV;
  const bottom = Math.floor(lo / stepV) * stepV;
  const x = i => pad.left + (months.length === 1 ? innerW / 2 : (i / (months.length - 1)) * innerW);
  const y = v => pad.top + ((top - v) / (top - bottom)) * innerH;
  const pts = months.map((m, i) => [x(i), y(m.cumulative)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
  const zero = y(0);
  const area = `${line} L${pts[pts.length - 1][0]},${zero} L${pts[0][0]},${zero} Z`;
  const ticks = [];
  for (let v = top; v >= bottom - stepV / 2; v -= stepV) ticks.push(v);
  const labelEvery = Math.ceil(months.length / Math.floor(innerW / 52));
  const crossKeys = new Map(crossings.map(c => [c.key, c.direction]));
  const onMove = e => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = Math.round(((px - pad.left) / innerW) * (months.length - 1));
    setHover(Math.max(0, Math.min(months.length - 1, i)));
  };

  return (
    <div ref={ref} className={styles.chartWrap}>
      <svg width={width} height={H} role="img" aria-label="Running surplus" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <clipPath id="ov-below"><rect x={0} y={zero} width={width} height={H} /></clipPath>
          <clipPath id="ov-above"><rect x={0} y={0} width={width} height={zero} /></clipPath>
        </defs>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--color-surface-alt)" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className={styles.axisText}>{axis(t)}</text>
          </g>
        ))}
        <path d={area} fill={CRITICAL} opacity={0.14} clipPath="url(#ov-below)" />
        <path d={area} fill={INCOME} opacity={0.1} clipPath="url(#ov-above)" />
        <line x1={pad.left} x2={width - pad.right} y1={zero} y2={zero} stroke="var(--color-text-secondary)" strokeWidth={1} />
        {lo < 0 && (() => {
          // Under the line where it dips lowest, so the label sits on the dip it names.
          const iLow = vals.indexOf(lo);
          const lx = x(iLow);
          const anchor = lx > width - 170 ? 'end' : lx < pad.left + 90 ? 'start' : 'middle';
          return (
            <text x={lx} y={Math.min(H - pad.bottom - 4, Math.max(zero + 14, y(lo) + 16))} textAnchor={anchor} className={styles.belowLabel}>
              ▼ spending ahead of income
            </text>
          );
        })()}
        <path d={line} fill="none" stroke="var(--color-text-primary)" strokeWidth={2} strokeLinejoin="round" />
        {months.map((m, i) => crossKeys.has(m.key) && (
          <g key={m.key}>
            <circle cx={x(i)} cy={y(m.cumulative)} r={5} fill={crossKeys.get(m.key) === 'under' ? CRITICAL : INCOME} stroke="var(--color-surface)" strokeWidth={2} />
            <text
              x={Math.min(width - pad.right - 4, Math.max(pad.left + 4, x(i)))}
              y={crossKeys.get(m.key) === 'under' ? y(m.cumulative) + 18 : y(m.cumulative) - 10}
              textAnchor={x(i) > width - 90 ? 'end' : x(i) < pad.left + 60 ? 'start' : 'middle'}
              className={styles.crossLabel}
            >
              {crossKeys.get(m.key) === 'under' ? 'overtook' : 'back ahead'}
            </text>
          </g>
        ))}
        {months.map((m, i) => i % labelEvery === 0 && (
          <text
            key={m.key}
            x={x(i)}
            y={H - 8}
            textAnchor={i === 0 ? 'start' : i === months.length - 1 ? 'end' : 'middle'}
            className={styles.axisText}
          >
            {short(m.key)}
          </text>
        ))}
        {hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="var(--color-text-muted)" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(months[hover].cumulative)} r={4} fill="var(--color-text-primary)" stroke="var(--color-surface)" strokeWidth={2} />
          </>
        )}
      </svg>
      {hover != null && (() => {
        const m = months[hover];
        const c = crossKeys.get(m.key);
        const left = Math.min(width - 220, Math.max(0, x(hover) - 110));
        return (
          <div className={styles.tooltip} style={{ left, top: 4 }}>
            <div className={styles.tooltipTitle}>{long(m.key)}</div>
            <div>Running surplus <b>{signed(m.cumulative)}</b></div>
            <div>This month <b>{signed(m.net)}</b></div>
            {c && <div className={styles.tooltipNet}>{c === 'under' ? 'Spending overtook income here' : 'Back ahead of spending here'}</div>}
          </div>
        );
      })()}
    </div>
  );
}
