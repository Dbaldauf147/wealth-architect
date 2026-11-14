import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { useBudgets } from '../hooks/useBudgets';
import { projectMonthSpending } from '../lib/spendProjection';
import { BudgetsPage } from './BudgetsPage';
import { TrendsPage } from './TrendsPage';
import styles from './OvershotPage.module.css';
import own from './SpendingPage.module.css';

/* Budgets and Spending Trends on one page, behind subtabs, with "This month"
   in front: where this month's spending is heading (lib/spendProjection). The
   two older pages render unchanged inside their tabs. The page always opens
   on This month — unless it was reached by the old #trends link, which opens
   Trends. */

const TABS = [
  { id: 'month', label: 'This month' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'trends', label: 'Trends' },
];

const SPENT = '#eb6834';
const TYPICAL = '#64748b';
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));
const axis = n => (n >= 1000 ? `$${Math.round(n / 100) / 10}k` : `$${Math.round(n)}`);
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = MONTH_LONG.map(m => m.slice(0, 3));
const longMonth = key => { const [y, m] = key.split('-').map(Number); return `${MONTH_LONG[m - 1]} ${y}`; };
const shortMonth = key => MONTH_SHORT[Number(key.slice(5)) - 1];

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function useMeasuredWidth(initial = 320) {
  const ref = useRef(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/* The month so far (solid), where it's heading (dashed) and the usual shape
   of a month (grey), all cumulative by day. */
function PaceChart({ p }) {
  const [ref, width] = useMeasuredWidth();
  const [hover, setHover] = useState(null);
  const H = 260;
  const pad = { top: 16, right: 64, bottom: 26, left: 48 };
  const innerW = width - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(1, p.projected, p.typical, p.soFar));
  const x = d => pad.left + (p.daysInMonth > 1 ? ((d - 1) / (p.daysInMonth - 1)) * innerW : 0);
  const y = v => pad.top + innerH - (v / max) * innerH;
  const line = (rows, f) => rows.filter(r => r[f] != null).map((r, i) => `${i ? 'L' : 'M'}${x(r.day).toFixed(1)},${y(r[f]).toFixed(1)}`).join(' ');
  const dayStep = Math.max(1, Math.ceil(p.daysInMonth / Math.max(1, Math.floor(innerW / 44))));
  const h = hover != null ? p.daily[hover] : null;
  const onMove = e => {
    const box = e.currentTarget.getBoundingClientRect();
    const d = Math.round(((e.clientX - box.left - pad.left) / innerW) * (p.daysInMonth - 1)) + 1;
    setHover(Math.max(1, Math.min(p.daysInMonth, d)) - 1);
  };
  return (
    <div ref={ref} className={styles.chartWrap} data-testid="spend-pace-chart">
      <svg width={width} height={H} role="img" aria-label="Cumulative spending this month: so far, projected and typical" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map(f => f * max).map(t => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--color-surface-alt)" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className={styles.axisText}>{axis(t)}</text>
          </g>
        ))}
        {p.daily.filter(r => r.day === 1 || r.day % dayStep === 0).map(r => (
          <text key={r.day} x={x(r.day)} y={H - 8} textAnchor="middle" className={styles.axisText} fontWeight={r.day === p.day ? 700 : undefined}>{r.day}</text>
        ))}
        <line x1={x(p.day)} x2={x(p.day)} y1={pad.top} y2={pad.top + innerH} stroke="var(--color-text-muted)" strokeDasharray="2 3" />
        <text x={x(p.day)} y={pad.top - 4} textAnchor="middle" className={styles.axisText}>today</text>
        {p.basis.length > 0 && <path d={line(p.daily, 'typical')} fill="none" stroke={TYPICAL} strokeWidth={1.5} opacity={0.7} />}
        <path d={line(p.daily, 'projected')} fill="none" stroke={SPENT} strokeWidth={2} strokeDasharray="5 4" />
        <path d={line(p.daily, 'actual')} fill="none" stroke={SPENT} strokeWidth={2.5} />
        <circle cx={x(p.day)} cy={y(p.soFar)} r={4} fill={SPENT} stroke="var(--color-surface)" strokeWidth={2} />
        <text x={x(p.daysInMonth) + 6} y={y(p.projected) + 4} className={styles.axisText} fontWeight={700} fill={SPENT}>{money(p.projected)}</text>
        {h && <line x1={x(h.day)} x2={x(h.day)} y1={pad.top} y2={pad.top + innerH} stroke="var(--color-text-primary)" strokeWidth={1} opacity={0.35} />}
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--color-text-muted)" />
      </svg>
      {h && (
        <div className={styles.tooltip} style={{ left: Math.min(width - 230, Math.max(0, x(h.day) - 115)), top: 4 }}>
          <div className={styles.tooltipTitle}>{shortMonth(p.key)} {h.day}</div>
          {h.actual != null && <div><i style={{ background: SPENT }} />Spent by then <b>{money(h.actual)}</b></div>}
          {h.actual == null && <div><i className={styles.legendProjected} style={{ borderColor: SPENT, background: 'transparent' }} />Projected by then <b>{money(h.projected)}</b></div>}
          {p.basis.length > 0 && <div><i style={{ background: TYPICAL }} />Usually by then <b>{money(h.typical)}</b></div>}
        </div>
      )}
    </div>
  );
}

function ThisMonth() {
  const { transactions, loading } = useData();
  const { budgets } = useBudgets();
  const p = useMemo(() => (transactions?.length ? projectMonthSpending({ transactions, today: new Date() }) : null), [transactions]);
  // Monthly budgets by category name, as the Budgets tab matches them.
  const limits = useMemo(() => {
    const out = new Map();
    for (const b of budgets || []) {
      if ((b.period || 'monthly') === 'monthly' && b.monthlyLimit > 0 && b.name) out.set(b.name.toLowerCase(), b.monthlyLimit);
    }
    return out;
  }, [budgets]);

  if (loading && !p) return <div className={styles.empty}>Loading transactions…</div>;
  if (!p || (!p.categories.length)) return <div className={styles.empty}>No spending to project yet.</div>;

  const rows = p.categories.map(c => ({ ...c, budget: limits.get(c.category.toLowerCase()) ?? null }));
  const hasBudgets = rows.some(r => r.budget != null);
  const overBudget = rows.filter(r => r.budget != null && r.projected > r.budget);
  const budgetTotal = rows.reduce((s, r) => s + (r.budget || 0), 0);
  const delta = Math.round((p.projected - p.typical) * 100) / 100;
  const hasBasis = p.basis.length > 0;
  const basisText = hasBasis
    ? `${p.basis.length === 1 ? shortMonth(p.basis[0]) : `${shortMonth(p.basis[0])}–${shortMonth(p.basis[p.basis.length - 1])}`}`
    : null;
  const scale = Math.max(1, ...rows.map(r => Math.max(r.projected, r.typical, r.budget || 0)));

  return (
    <div className={styles.page} data-testid="spend-this-month">
      <div className={styles.hero}>
        <div className={styles.heroLabel}>{longMonth(p.key)} · day {p.day} of {p.daysInMonth}</div>
        <div className={styles.heroTitle}>
          {hasBasis
            ? <>On track to spend {money(p.projected)} this month</>
            : <>{money(p.soFar)} spent so far this month</>}
        </div>
        <div className={styles.heroSubtitle}>
          {hasBasis
            ? <>What’s been spent so far, plus what each category usually spends from day {p.day + 1} to the end of a month (the average of {basisText}). Bills that have already landed, like rent, add nothing more.</>
            : <>There isn’t a complete earlier month to project the rest of this one from yet.</>}
        </div>
        <div className={styles.heroStats}>
          <div>
            <div className={styles.heroStatValue} data-testid="spend-so-far">{money(p.soFar)}</div>
            <div className={styles.heroStatLabel}>Spent so far</div>
          </div>
          <div>
            <div className={styles.heroStatValue} data-testid="spend-remaining">{money(p.remaining)}</div>
            <div className={styles.heroStatLabel}>Still expected · {p.daysLeft} day{p.daysLeft === 1 ? '' : 's'} left</div>
          </div>
          <div>
            <div className={styles.heroStatValue} data-testid="spend-projected">{money(p.projected)}</div>
            <div className={styles.heroStatLabel}>Projected for the month</div>
          </div>
          {hasBasis && (
            <div>
              <div className={`${styles.heroStatValue} ${delta > 0.5 ? styles.heroBad : delta < -0.5 ? styles.heroGood : ''}`}>{signed(delta)}</div>
              <div className={styles.heroStatLabel}>vs a typical month ({money(p.typical)})</div>
            </div>
          )}
          {hasBudgets && (
            <div>
              <div className={`${styles.heroStatValue} ${overBudget.length ? styles.heroBad : styles.heroGood}`}>{overBudget.length}</div>
              <div className={styles.heroStatLabel}>budget{overBudget.length === 1 ? '' : 's'} projected to go over</div>
            </div>
          )}
        </div>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>Where the month is heading</h2>
            <div className={styles.cardHint}>Running total by day. The dashed line follows the usual shape of the rest of a month from today’s total.</div>
          </div>
          <div className={styles.legend}>
            <span><i className={own.legendLine} style={{ borderColor: SPENT }} />Spent so far</span>
            <span><i className={`${own.legendLine} ${own.legendDash}`} style={{ borderColor: SPENT }} />Projected</span>
            {hasBasis && <span><i className={own.legendLine} style={{ borderColor: TYPICAL }} />Typical month</span>}
          </div>
        </div>
        <PaceChart p={p} />
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>Projected spending by category</h2>
            <div className={styles.cardHint}>
              Largest projection first. The bar is the projection (solid = already spent); the tick is a typical month{hasBudgets ? ', and the budget where there is one' : ''}.
            </div>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className={styles.table} data-testid="spend-projection-table">
            <thead>
              <tr>
                <th>Category</th>
                <th className={styles.num}>Spent so far</th>
                <th className={styles.num}>Still expected</th>
                <th className={styles.num}>Projected</th>
                <th className={styles.num}>Typical month</th>
                <th className={styles.num}>vs typical</th>
                {hasBudgets && <th className={styles.num}>Budget</th>}
                {hasBudgets && <th className={styles.num}>vs budget</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const over = r.budget != null && r.projected > r.budget;
                return (
                  <tr key={r.category} data-category={r.category}>
                    <td>
                      <div className={own.catCell}>
                        <span>{r.category}</span>
                        <div className={own.track} aria-hidden="true">
                          <i style={{ width: `${(r.projected / scale) * 100}%`, background: over ? '#d03b3b' : SPENT, opacity: 0.3 }} />
                          <i style={{ width: `${(r.soFar / scale) * 100}%`, background: over ? '#d03b3b' : SPENT }} />
                          {r.typical > 0 && <i style={{ left: `calc(${(r.typical / scale) * 100}% - 1px)`, width: 2, background: TYPICAL, borderRadius: 0 }} />}
                        </div>
                      </div>
                    </td>
                    <td className={styles.num}>{money(r.soFar)}</td>
                    <td className={styles.num}>{r.remaining > 0.5 ? money(r.remaining) : <span className={styles.muted}>—</span>}</td>
                    <td className={styles.num}><b>{money(r.projected)}</b></td>
                    <td className={styles.num}>{r.typical > 0.5 ? money(r.typical) : <span className={styles.muted}>—</span>}</td>
                    <td className={`${styles.num} ${r.delta > 0.5 ? own.over : r.delta < -0.5 ? own.under : ''}`} style={r.delta > 0.5 ? { fontWeight: 400 } : undefined}>{hasBasis ? signed(r.delta) : <span className={styles.muted}>—</span>}</td>
                    {hasBudgets && <td className={styles.num}>{r.budget != null ? money(r.budget) : <span className={styles.muted}>—</span>}</td>}
                    {hasBudgets && (
                      <td className={`${styles.num} ${over ? own.over : r.budget != null ? own.under : ''}`}>
                        {r.budget != null ? (over ? `Over by ${money(r.projected - r.budget)}` : `${money(r.budget - r.projected)} left`) : <span className={styles.muted}>—</span>}
                      </td>
                    )}
                  </tr>
                );
              })}
              <tr className={own.totalRow}>
                <td>Total</td>
                <td className={styles.num}>{money(p.soFar)}</td>
                <td className={styles.num}>{money(p.remaining)}</td>
                <td className={styles.num}>{money(p.projected)}</td>
                <td className={styles.num}>{money(p.typical)}</td>
                <td className={styles.num}>{hasBasis ? signed(delta) : ''}</td>
                {hasBudgets && <td className={styles.num}>{money(budgetTotal)}</td>}
                {hasBudgets && <td className={styles.num} />}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function SpendingPage({ initialTab = 'month' }) {
  const [tab, setTab] = useState(TABS.some(t => t.id === initialTab) ? initialTab : 'month');
  return (
    <div className={own.wrap}>
      <div className={own.tabs} role="tablist" aria-label="Budgets and trends">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`${own.tab} ${tab === t.id ? own.tabActive : ''}`} onClick={() => setTab(t.id)} data-testid={`spending-tab-${t.id}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'month' && <ThisMonth />}
      {tab === 'budgets' && <BudgetsPage />}
      {tab === 'trends' && <TrendsPage />}
    </div>
  );
}
