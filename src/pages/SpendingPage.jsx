import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { useBudgets } from '../hooks/useBudgets';
import { projectMonthSpending, sumDaily, withExpected } from '../lib/spendProjection';
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
const LINE = 'var(--color-text-primary)';
// One colour per category, by its rank in the projection (the app's
// categorical dataviz slots, then a second round of distinct hues).
const CAT_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#8b5cf6', '#e0a40b', '#e0457b', '#0ea5b7', '#6b7280', '#84cc16', '#b45309', '#4f46e5', '#be185d', '#0f766e', '#a16207'];
// Categories switched off on the This month tab: a view preference, kept in
// this browser only. The page says so whenever any are off.
const HIDDEN_KEY = 'wa-spend-month-hidden';
// Your own expected month total per category, in place of the projection:
// kept in this browser, and standing until cleared.
const EXPECTED_KEY = 'wa-spend-month-expected';
function loadExpected() {
  try {
    const v = JSON.parse(localStorage.getItem(EXPECTED_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
// Your targets: one for the whole month and one per category. Standing numbers
// (not tied to a month), kept in this browser like the expected values.
const TARGETS_KEY = 'wa-spend-month-targets';
function loadTargets() {
  try {
    const v = JSON.parse(localStorage.getItem(TARGETS_KEY) || '{}');
    const cats = v && typeof v.categories === 'object' && v.categories && !Array.isArray(v.categories) ? v.categories : {};
    return { total: v && v.total > 0 ? v.total : null, categories: cats };
  } catch { return { total: null, categories: {} }; }
}
const TARGET = 'var(--color-secondary, #0058be)';
function loadHidden() {
  try { const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]'); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); }
}
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));
const axis = n => (n >= 1000 ? `$${Math.round(n / 100) / 10}k` : `$${Math.round(n)}`);
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = MONTH_LONG.map(m => m.slice(0, 3));
const longMonth = key => { const [y, m] = key.split('-').map(Number); return `${MONTH_LONG[m - 1]} ${y}`; };
const shortMonth = key => MONTH_SHORT[Number(key.slice(5)) - 1];

// A y axis that hugs the data: a round step that gives about five gridlines,
// and a top that is the first step above the highest value (so $5.7k tops out
// at $6k, not $10k).
function tightAxis(top) {
  const v = top > 0.5 ? top : 100; // nothing switched on: a plain $0–$100 axis
  const raw = v / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find(f => f * pow >= raw) * pow;
  const max = Math.ceil(v / step - 1e-9) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step) };
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

/* The month by day, stacked by category: solid up to today, faded where it's
   projected. The outline is the total (solid so far, dashed projected) and the
   dotted line is the usual shape of a month for the same categories. */
function PaceChart({ p, cats, daily, totals, target, onPick, focused }) {
  const [ref, width] = useMeasuredWidth();
  const [hover, setHover] = useState(null);
  const H = 320;
  const pad = { top: 18, right: 64, bottom: 26, left: 48 };
  const innerW = width - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const hasBasis = p.basis.length > 0;
  // Scaled to whatever is switched on, typical line included.
  const { max, ticks } = tightAxis(Math.max(totals.projected, totals.soFar, target || 0, ...(hasBasis ? daily.map(r => r.typical) : [0])));
  const x = d => pad.left + (p.daysInMonth > 1 ? ((d - 1) / (p.daysInMonth - 1)) * innerW : 0);
  const y = v => pad.top + innerH - (v / max) * innerH;
  const line = (rows, f) => rows.filter(r => r[f] != null).map((r, i) => `${i ? 'L' : 'M'}${x(r.day).toFixed(1)},${y(r[f]).toFixed(1)}`).join(' ');
  // Each category's band: its running total (actual, then projected) on top
  // of the ones below it. Largest at the bottom.
  const bands = useMemo(() => {
    const floor = Array(p.daysInMonth).fill(0);
    return cats.map(c => {
      const lower = [...floor];
      const upper = c.daily.map((r, i) => (floor[i] += r.actual ?? r.projected ?? 0));
      return { category: c.category, color: c.color, lower, upper: [...upper] };
    });
  }, [cats, p.daysInMonth]);
  const area = b => {
    const up = b.upper.map((v, i) => `${i ? 'L' : 'M'}${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const down = b.lower.map((v, i) => `L${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).reverse().join(' ');
    return `${up} ${down} Z`;
  };
  const dayStep = Math.max(1, Math.ceil(p.daysInMonth / Math.max(1, Math.floor(innerW / 44))));
  const h = hover != null ? daily[hover] : null;
  const onMove = e => {
    const box = e.currentTarget.getBoundingClientRect();
    const d = Math.round(((e.clientX - box.left - pad.left) / innerW) * (p.daysInMonth - 1)) + 1;
    setHover(Math.max(1, Math.min(p.daysInMonth, d)) - 1);
  };
  const xToday = x(p.day);
  const hoverCats = h ? cats.map(c => ({ ...c, v: c.daily[hover].actual ?? c.daily[hover].projected ?? 0 })).filter(c => c.v > 0.5).sort((a, b) => b.v - a.v) : [];
  return (
    <div ref={ref} className={styles.chartWrap} data-testid="spend-pace-chart">
      <svg width={width} height={H} role="img" aria-label={focused ? `Cumulative ${focused} spending this month: so far and projected` : 'Cumulative spending this month by category: so far and projected'} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <clipPath id="spend-past"><rect x={pad.left} y={0} width={Math.max(0, xToday - pad.left)} height={H} /></clipPath>
          <clipPath id="spend-future"><rect x={xToday} y={0} width={Math.max(0, width - xToday)} height={H} /></clipPath>
        </defs>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--color-surface-alt)" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className={styles.axisText} data-axis-tick>{axis(t)}</text>
          </g>
        ))}
        {daily.filter(r => r.day === 1 || r.day % dayStep === 0).map(r => (
          <text key={r.day} x={x(r.day)} y={H - 8} textAnchor="middle" className={styles.axisText} fontWeight={r.day === p.day ? 700 : undefined}>{r.day}</text>
        ))}
        <g clipPath="url(#spend-past)">
          {bands.map(b => <path key={b.category} data-band={b.category} d={area(b)} fill={b.color} fillOpacity={0.9} stroke="var(--color-surface)" strokeWidth={0.75} onClick={() => onPick?.(b.category)} style={onPick ? { cursor: 'pointer' } : undefined} />)}
        </g>
        <g clipPath="url(#spend-future)">
          {bands.map(b => <path key={b.category} data-band-projected={b.category} d={area(b)} fill={b.color} fillOpacity={0.38} stroke="var(--color-surface)" strokeWidth={0.75} onClick={() => onPick?.(b.category)} style={onPick ? { cursor: 'pointer' } : undefined} />)}
        </g>
        <line x1={xToday} x2={xToday} y1={pad.top} y2={pad.top + innerH} stroke="var(--color-text-muted)" strokeDasharray="2 3" />
        <text x={xToday} y={pad.top - 5} textAnchor="middle" className={styles.axisText}>today</text>
        {hasBasis && <path d={line(daily, 'typical')} fill="none" stroke={LINE} strokeWidth={1.5} strokeDasharray="1.5 4" strokeLinecap="round" />}
        <path d={line(daily, 'projected')} fill="none" stroke={LINE} strokeWidth={1.75} strokeDasharray="5 4" />
        <path d={line(daily, 'actual')} fill="none" stroke={LINE} strokeWidth={2.25} />
        {target != null && (
          <g data-testid="spend-target-line">
            <line x1={pad.left} x2={width - pad.right} y1={y(target)} y2={y(target)} stroke={TARGET} strokeWidth={1.75} strokeDasharray="10 4" />
            <text x={pad.left + 6} y={y(target) - 6} className={own.targetLabel} style={{ fill: TARGET }}>Target {money(target)}</text>
          </g>
        )}
        {daily.length > 0 && <text x={x(p.daysInMonth) + 6} y={y(totals.projected) + 4} className={styles.axisText} fontWeight={700} style={{ fill: LINE }}>{money(totals.projected)}</text>}
        {h && <line x1={x(h.day)} x2={x(h.day)} y1={pad.top} y2={pad.top + innerH} stroke="var(--color-text-primary)" strokeWidth={1} opacity={0.35} />}
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--color-text-muted)" />
      </svg>
      {h && (
        <div className={styles.tooltip} style={{ left: Math.min(width - 230, Math.max(0, x(h.day) + (x(h.day) > width / 2 ? -246 : 16))), top: 4 }} data-testid="spend-pace-tooltip">
          <div className={styles.tooltipTitle}>{shortMonth(p.key)} {h.day}</div>
          <div>{h.actual != null ? 'Spent by then' : 'Projected by then'} <b>{money(h.actual ?? h.projected)}</b></div>
          {hasBasis && <div>Usually by then <b>{money(h.typical)}</b></div>}
          {target != null && <div>Your target <b>{money(target)}</b></div>}
          {hoverCats.slice(0, 8).map(c => <div key={c.category}><i style={{ background: c.color, opacity: h.actual != null ? 1 : 0.5 }} />{c.category} <b>{money(c.v)}</b></div>)}
          {onPick && <div className={styles.muted}>{focused ? 'Click the chart to go back to all categories' : 'Click a category to see it on its own'}</div>}
          {hoverCats.length > 8 && <div className={styles.muted}>{hoverCats.length - 8} more <b>{money(hoverCats.slice(8).reduce((t, c) => t + c.v, 0))}</b></div>}
        </div>
      )}
    </div>
  );
}

function ThisMonth() {
  const { transactions, loading } = useData();
  const { budgets } = useBudgets();
  const full = useMemo(() => (transactions?.length ? projectMonthSpending({ transactions, today: new Date() }) : null), [transactions]);
  const [hidden, setHidden] = useState(loadHidden);
  const saveHidden = next => { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next])); } catch { /* private mode */ } return next; };
  const toggleCat = c => setHidden(prev => { const next = new Set(prev); if (next.has(c)) next.delete(c); else next.add(c); return saveHidden(next); });
  const [expected, setExpected] = useState(loadExpected);
  const setExpectedFor = (c, raw) => setExpected(prev => {
    const next = { ...prev };
    const v = Number(raw);
    if (raw === '' || raw == null || !(v >= 0)) delete next[c]; else next[c] = Math.round(v * 100) / 100;
    try { localStorage.setItem(EXPECTED_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });
  const [targets, setTargets] = useState(loadTargets);
  const saveTargets = next => { try { localStorage.setItem(TARGETS_KEY, JSON.stringify(next)); } catch { /* private mode */ } return next; };
  const amount = raw => { const v = Number(raw); return raw === '' || raw == null || !(v > 0) ? null : Math.round(v * 100) / 100; };
  const setTotalTarget = raw => setTargets(prev => saveTargets({ ...prev, total: amount(raw) }));
  const setTargetFor = (c, raw) => setTargets(prev => {
    const categories = { ...prev.categories };
    const v = amount(raw);
    if (v == null) delete categories[c]; else categories[c] = v;
    return saveTargets({ ...prev, categories });
  });
  // A category picked on the chart: the chart shows it alone, with its own
  // target. Not kept between visits.
  const [focus, setFocus] = useState(null);
  // The projection over just the categories that are switched on.
  const view = useMemo(() => {
    if (!full) return null;
    // Colours go by the automatic ranking, so setting a value doesn't recolour anything.
    const all = full.categories.map((c, i) => ({ ...withExpected(c, expected[c.category]), color: CAT_COLORS[i % CAT_COLORS.length] }));
    const cats = all.filter(c => !hidden.has(c.category));
    const r2 = n => Math.round(n * 100) / 100;
    const total = f => r2(cats.reduce((s2, c) => s2 + c[f], 0));
    return { all, cats, daily: sumDaily(cats), p: { ...full, soFar: total('soFar'), remaining: total('remaining'), projected: total('projected'), typical: total('typical') } };
  }, [full, hidden, expected]);
  const p = view?.p || null;
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

  const rows = view.all.map(c => ({ ...c, off: hidden.has(c.category), budget: limits.get(c.category.toLowerCase()) ?? null, target: targets.categories[c.category] > 0 ? targets.categories[c.category] : null }));
  const shown = rows.filter(r => !r.off);
  const offCount = rows.length - shown.length;
  const hasBudgets = rows.some(r => r.budget != null);
  const overBudget = shown.filter(r => r.budget != null && r.projected > r.budget);
  const budgetTotal = shown.reduce((s, r) => s + (r.budget || 0), 0);
  const delta = Math.round((p.projected - p.typical) * 100) / 100;
  const target = targets.total;
  const targetGap = target != null ? Math.round((p.projected - target) * 100) / 100 : null;
  const withTarget = shown.filter(r => r.target != null);
  const overTarget = withTarget.filter(r => r.projected > r.target + 0.005);
  const anyCatTarget = rows.some(r => r.target != null);
  const catTargetTotal = withTarget.reduce((s, r) => s + r.target, 0);
  // Only a category that is switched on can be shown alone.
  const focusRow = shown.find(r => r.category === focus) || null;
  const focusCats = focusRow ? view.cats.filter(c => c.category === focusRow.category) : null;
  const focusGap = focusRow?.target != null ? Math.round((focusRow.projected - focusRow.target) * 100) / 100 : null;
  const hasBasis = p.basis.length > 0;
  const basisText = hasBasis
    ? `${p.basis.length === 1 ? shortMonth(p.basis[0]) : `${shortMonth(p.basis[0])}–${shortMonth(p.basis[p.basis.length - 1])}`}`
    : null;
  const scale = Math.max(1, ...rows.map(r => Math.max(r.projected, r.typical, r.budget || 0)));

  return (
    <div className={styles.page} data-testid="spend-this-month">
      <div className={styles.hero}>
        <div className={styles.heroLabel}>{longMonth(p.key)} · day {p.day} of {p.daysInMonth}{offCount > 0 && <span data-testid="spend-hidden-note"> · {offCount} of {rows.length} categories switched off</span>}</div>
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
          {target != null && (
            <div data-testid="spend-vs-target">
              <div className={`${styles.heroStatValue} ${targetGap > 0.5 ? styles.heroBad : styles.heroGood}`}>{targetGap > 0.5 ? `${money(targetGap)} over` : targetGap < -0.5 ? `${money(-targetGap)} under` : 'On target'}</div>
              <div className={styles.heroStatLabel}>your target ({money(target)}){p.soFar > target ? ' · already past it' : ''}</div>
            </div>
          )}
          {withTarget.length > 0 && (
            <div data-testid="spend-targets-over">
              <div className={`${styles.heroStatValue} ${overTarget.length ? styles.heroBad : styles.heroGood}`}>{overTarget.length} of {withTarget.length}</div>
              <div className={styles.heroStatLabel}>category target{withTarget.length === 1 ? '' : 's'} projected to go over</div>
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
            <div className={styles.cardHint}>Running total by day, a colour per category: solid is what’s been spent, faded is what’s projected from today on. Click a category in the chart to see it on its own, with its target; click its name below to switch it off everywhere on this tab.</div>
          </div>
          <div className={own.headRight}>
          {focusRow && (
            <div className={own.focusTarget} data-testid="spend-focus-target">
              <label htmlFor="spend-focus-target-input"><i style={{ background: focusRow.color }} />{focusRow.category} target</label>
              <span className={own.expectedCell}>
                <span className={styles.muted}>$</span>
                <input id="spend-focus-target-input" type="number" min={0} step={10} inputMode="decimal" className={`${own.expectedInput} ${own.targetInput}`} data-testid="spend-focus-target-input"
                  value={focusRow.target ?? ''} placeholder="Set a target" onChange={e => setTargetFor(focusRow.category, e.target.value)} />
                {focusRow.target != null && <button type="button" className={own.clearBtn} onClick={() => setTargetFor(focusRow.category, '')} aria-label={`Clear your ${focusRow.category} target`} title="Remove the target">×</button>}
              </span>
              {focusRow.target != null && (
                <span className={focusGap > 0.005 ? own.overText : own.underText} data-testid="spend-focus-target-status">
                  {focusRow.soFar > focusRow.target + 0.005 ? `Already over by ${money(focusRow.soFar - focusRow.target)}` : focusGap > 0.005 ? `Heading over by ${money(focusGap)}` : `${money(-focusGap)} to spare`}
                </span>
              )}
            </div>
          )}
          <div className={styles.legend}>
            <span><i className={own.legendLine} style={{ borderColor: LINE }} />Spent so far</span>
            <span><i className={`${own.legendLine} ${own.legendDash}`} style={{ borderColor: LINE }} />Projected</span>
            {hasBasis && <span><i className={`${own.legendLine} ${own.legendDot}`} style={{ borderColor: LINE }} />Typical month</span>}
            {(focusRow ? focusRow.target : target) != null && <span><i className={`${own.legendLine} ${own.legendDash}`} style={{ borderColor: TARGET }} />Target</span>}
          </div>
          </div>
        </div>
        {focusRow && (
          <div className={own.targetRow} data-testid="spend-focus-note">
            <span>Showing only <b>{focusRow.category}</b>: {money(focusRow.soFar)} spent, {money(focusRow.projected)} projected.</span>
            <button type="button" className={own.chipLink} onClick={() => setFocus(null)} data-testid="spend-focus-clear">← All categories</button>
          </div>
        )}
        <div className={own.targetRow} hidden={!!focusRow}>
          <label htmlFor="spend-target-total">Target for the month</label>
          <span className={own.expectedCell}>
            <span className={styles.muted}>$</span>
            <input id="spend-target-total" type="number" min={0} step={50} inputMode="decimal" className={`${own.expectedInput} ${own.targetInput}`} data-testid="spend-target-input"
              value={target ?? ''} placeholder="Set a target" onChange={e => setTotalTarget(e.target.value)} />
            {target != null && <button type="button" className={own.clearBtn} onClick={() => setTotalTarget('')} aria-label="Clear the month target" title="Remove the target">×</button>}
          </span>
          {target != null && (
            <span className={targetGap > 0.5 ? own.overText : own.underText} data-testid="spend-target-status">
              {targetGap > 0.5 ? `Projected to go over by ${money(targetGap)}` : targetGap < -0.5 ? `Projected to come in ${money(-targetGap)} under` : 'Projected to land right on it'}
              {p.daysLeft > 0 && target > p.soFar && <span className={styles.muted}> · {money((target - p.soFar) / p.daysLeft)} a day left to stay on it</span>}
            </span>
          )}
          {target != null && offCount > 0 && <span className={styles.muted}>Compared with the {shown.length} categories switched on.</span>}
          {target == null && anyCatTarget && <button type="button" className={own.chipLink} onClick={() => setTotalTarget(String(catTargetTotal))} data-testid="spend-target-use-sum">Use your category targets ({money(catTargetTotal)})</button>}
        </div>
        <div className={own.chips} data-testid="spend-category-chips">
          {rows.map(r => (
            <button key={r.category} type="button" className={`${own.chip} ${r.off ? own.chipOff : ''}`} aria-pressed={!r.off} onClick={() => toggleCat(r.category)} data-category={r.category}
              title={r.off ? `Show ${r.category}` : `Hide ${r.category} (${money(r.projected)} projected)`}>
              <i style={{ background: r.color }} />{r.category}
            </button>
          ))}
          {offCount > 0 && <button type="button" className={own.chipLink} onClick={() => setHidden(saveHidden(new Set()))} data-testid="spend-show-all">Show all</button>}
          {offCount < rows.length && rows.length > 1 && <button type="button" className={own.chipLink} onClick={() => setHidden(saveHidden(new Set(rows.map(r => r.category))))} data-testid="spend-hide-all">Hide all</button>}
        </div>
        {focusRow
          ? <PaceChart p={p} cats={focusCats} daily={sumDaily(focusCats)} totals={focusRow} target={focusRow.target} focused={focusRow.category} onPick={() => setFocus(null)} />
          : <PaceChart p={p} cats={view.cats} daily={view.daily} totals={p} target={target} onPick={setFocus} />}
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>Projected spending by category</h2>
            <div className={styles.cardHint}>
              Type your own number under Your expected to use it in place of a category’s projection; it stays until you clear it. Set a Target to see whether a category is heading over it. Untick a category to leave it out of the totals and the chart. The bar is the projection (solid = already spent); the tick is a typical month{hasBudgets ? ', and the budget where there is one' : ''}.
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
                <th className={styles.num}>Your expected</th>
                <th className={styles.num}>Target</th>
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
                  <tr key={r.category} data-category={r.category} className={r.off ? own.rowOff : undefined}>
                    <td>
                      <div className={own.catCell}>
                        <label className={own.catName}>
                          <input type="checkbox" checked={!r.off} onChange={() => toggleCat(r.category)} aria-label={`Include ${r.category}`} />
                          <i style={{ background: r.color }} />{r.category}
                        </label>
                        <div className={own.track} aria-hidden="true">
                          <i style={{ width: `${(r.projected / scale) * 100}%`, background: r.color, opacity: 0.35 }} />
                          <i style={{ width: `${(r.soFar / scale) * 100}%`, background: r.color }} />
                          {r.typical > 0 && <i style={{ left: `calc(${(r.typical / scale) * 100}% - 1px)`, width: 2, background: TYPICAL, borderRadius: 0 }} />}
                        </div>
                      </div>
                    </td>
                    <td className={styles.num}>{money(r.soFar)}</td>
                    <td className={styles.num}>{r.remaining > 0.5 ? money(r.remaining) : <span className={styles.muted}>—</span>}</td>
                    <td className={styles.num}>
                      <b>{money(r.projected)}</b>
                      {r.expected != null && <div className={own.setNote}>{r.expected < r.soFar ? 'already past your number' : `yours · auto ${money(r.auto)}`}</div>}
                    </td>
                    <td className={styles.num}>
                      <span className={own.expectedCell}>
                        <span className={styles.muted}>$</span>
                        <input type="number" min={0} step={10} inputMode="decimal" className={own.expectedInput} data-testid="spend-expected-input"
                          value={r.expected ?? ''} placeholder={String(Math.round(r.auto ?? r.projected))}
                          onChange={e => setExpectedFor(r.category, e.target.value)} aria-label={`Your expected ${r.category} spending this month`} />
                        {r.expected != null && <button type="button" className={own.clearBtn} onClick={() => setExpectedFor(r.category, '')} aria-label={`Clear your expected ${r.category} value`} title="Back to the automatic projection">×</button>}
                      </span>
                    </td>
                    <td className={styles.num}>
                      <span className={own.expectedCell}>
                        <span className={styles.muted}>$</span>
                        <input type="number" min={0} step={10} inputMode="decimal" className={own.expectedInput} data-testid="spend-cat-target-input"
                          value={r.target ?? ''} placeholder="—"
                          onChange={e => setTargetFor(r.category, e.target.value)} aria-label={`Your target for ${r.category} this month`} />
                        {r.target != null && <button type="button" className={own.clearBtn} onClick={() => setTargetFor(r.category, '')} aria-label={`Clear your ${r.category} target`} title="Remove the target">×</button>}
                      </span>
                      {r.target != null && (
                        <div className={`${own.setNote} ${r.projected > r.target + 0.005 ? own.overText : own.underText}`} data-testid="spend-cat-target-status">
                          {r.soFar > r.target + 0.005 ? `already over by ${money(r.soFar - r.target)}` : r.projected > r.target + 0.005 ? `heading over by ${money(r.projected - r.target)}` : `${money(r.target - r.projected)} to spare`}
                        </div>
                      )}
                    </td>
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
                <td>Total{offCount > 0 ? ` (${shown.length} of ${rows.length} categories)` : ''}</td>
                <td className={styles.num}>{money(p.soFar)}</td>
                <td className={styles.num}>{money(p.remaining)}</td>
                <td className={styles.num}>{money(p.projected)}</td>
                <td className={styles.num}>{Object.keys(expected).some(c => rows.some(r => r.category === c)) && <button type="button" className={own.chipLink} onClick={() => { setExpected({}); try { localStorage.removeItem(EXPECTED_KEY); } catch { /* private mode */ } }} data-testid="spend-expected-clear-all">Clear all</button>}</td>
                <td className={styles.num} data-testid="spend-cat-target-total">{withTarget.length > 0 && money(catTargetTotal)}</td>
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
      <div className={own.tabs} role="tablist" aria-label="Spending">
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
