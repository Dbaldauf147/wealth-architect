import { useEffect, useMemo, useRef, useState } from 'react';
import { useCommissions } from '../hooks/useCommissions';
import { useData } from '../contexts/DataContext';
import { earnedByMonth, monthLabel, payMonthOf, ymKey, expectedPayouts } from '../lib/commissions';
import { computeIncome, commissionTakeHome, monthKeysEnding, monthKeyFor } from '../lib/income';
import {
  baseSalary, paySchedule, commissionRows, chartPoints, rawSheetRows, chartSheetRows,
  expectedVsActual, expectedVsActualTotals, expectedVsActualSheetRows,
  payByMonth, payByMonthSheetRows, payByMonthPaycheckRows,
  CHART_RANGES, STATUSES,
} from '../lib/commissionSchedule';
import { downloadXlsx } from '../lib/xlsx';
import styles from './IncomePage.module.css';
import own from './CommissionsPage.module.css';

/* The Prospect Tracker's Commissions table, read-only. It's edited in the
   tracker; this page reads it live through /api/commissions (lib/commissions
   decides which year each month column is and when it's paid). */

const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const dayY = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const shortDate = s => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—');
const pct = r => (r == null ? '—' : `${Math.round(r * 1000) / 10}%`);
const VIEWS = [
  { id: 'active', label: 'Active' },
  { id: 'all', label: 'All' },
];

function Stat({ value, label, sub }) {
  return (
    <div>
      <div className={styles.heroStatValue}>{value}</div>
      <div className={styles.heroStatLabel}>{label}</div>
      {sub && <div className={styles.heroStatSub}>{sub}</div>}
    </div>
  );
}

const cents = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const dayShort = d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const axis = n => (n >= 1000 ? `$${Math.round(n / 100) / 10}k` : `$${Math.round(n)}`);
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortKey = key => { const [y, m] = key.split('-'); return `${MONTH_SHORT[m - 1]} ${y.slice(2)}`; };
const asDate = s => new Date(`${s}T00:00:00`);
// Chart series: paid and recorded solid, projected faded and dashed.
const STATUS_STYLE = {
  paid: { color: '#2a78d6' },
  recorded: { color: '#eb6834' },
  projected: { color: '#2a78d6', faded: true },
};

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(s => s * p).find(s => s >= v);
}

function useMeasuredWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = () => setWidth(Math.max(320, Math.round(el.clientWidth || 320)));
    apply();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/* Mid-month paycheck = base salary; the history shows it holding steady. */
function BaseSalaryCard({ base }) {
  return (
    <section className={styles.card} data-testid="commissions-base-salary">
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>Base salary</h2>
          <div className={styles.cardHint}>
            The mid-month paycheck, which never carries commission. The month-end paycheck is the same base plus last month’s commission, after tax.
          </div>
        </div>
      </div>
      {!base ? (
        <div className={styles.muted}>No mid-month payroll deposit found in your transactions yet.</div>
      ) : (
        <>
          <div className={own.salaryRow}>
            <div>
              <div className={own.salaryValue}>{cents(base.amount)}</div>
              <div className={own.salaryLabel}>per mid-month paycheck, take-home · usually the {base.day}th</div>
            </div>
            <div>
              <div className={own.salaryValue}>{money(base.amount * 2)}</div>
              <div className={own.salaryLabel}>a month in base (two paychecks)</div>
            </div>
            <div>
              <div className={own.salaryValue}>{money(base.perYear)}</div>
              <div className={own.salaryLabel}>a year in base, take-home</div>
            </div>
          </div>
          {base.stale && <div className={own.hint}>No mid-month deposit since {dayY(base.last.date)}, so this may be out of date.</div>}
          <div className={own.history} aria-label="Recent mid-month paychecks">
            {base.history.slice(0, 8).map(h => (
              <span key={h.date.getTime()} className={own.historyItem}>{h.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}<b>{cents(h.amount)}</b></span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* Every payday ahead: mid-month (base) and month-end (base + commission). */
function PayScheduleCard({ schedule, takeHome }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? schedule : schedule.slice(0, 8);
  const rate = Math.round((takeHome ?? 0.6) * 100);
  return (
    <section className={styles.card} data-testid="commissions-pay-schedule">
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>Pay schedule</h2>
          <div className={styles.cardHint}>
            Twice a month for the next 12 months. Commission take-home is the pre-tax amount at {rate}%, the share past month-end paychecks actually carried
            {takeHome == null ? ' (a default, until there’s history to measure)' : ''}. Weekend paydays move to the Friday before.
          </div>
        </div>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Paycheck</th>
              <th className={styles.num}>Base</th>
              <th className={styles.num}>Commission (pre-tax)</th>
              <th className={styles.num}>Commission take-home</th>
              <th className={styles.num}>Expected total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(p => (
              <tr key={`${p.dateKey}-${p.kind}`}>
                <td className={styles.nowrap}>{dayShort(p.date)}</td>
                <td className={styles.nowrap}>
                  <i className={p.kind === 'mid' ? own.kindMid : own.kindEnd} />
                  {p.kind === 'mid' ? 'Mid-month' : 'Month-end'}
                  {p.kind === 'end' && p.earnedMonth && <span className={styles.muted}> · {monthLabel(p.earnedMonth, { month: 'short' })} commission</span>}
                </td>
                <td className={styles.num}>{cents(p.base)}</td>
                <td className={styles.num}>
                  {p.kind === 'mid' ? <span className={styles.muted}>—</span> : p.commissionPreTax ? <>{cents(p.commissionPreTax)}{p.projected && <span className={styles.muted}> (projected)</span>}</> : <span className={styles.muted}>$0</span>}
                </td>
                <td className={styles.num}>{p.kind === 'mid' ? <span className={styles.muted}>—</span> : cents(p.commissionTakeHome)}</td>
                <td className={styles.num}><b>{cents(p.total)}</b></td>
                <td className={styles.nowrap}>
                  {p.status === 'received'
                    ? <span className={own.statusReceived}>Received {cents(p.received)}</span>
                    : <span className={own.statusExpected}>Expected</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {schedule.length > 8 && (
        <button type="button" className={styles.linkBtn} onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Show fewer' : `Show all ${schedule.length} paydays`}
        </button>
      )}
    </section>
  );
}

/* Stacked bars by status, one per pay month. Click (or Enter) selects one. */
function CommissionChart({ points, selected, onSelect }) {
  const [ref, width] = useMeasuredWidth();
  const H = 260;
  const pad = { top: 14, right: 8, bottom: 26, left: 52 };
  const innerW = width - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(1, ...points.map(p => p.amount)));
  const step = innerW / Math.max(1, points.length);
  const barW = Math.max(4, Math.min(30, step * 0.62));
  const y = v => pad.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(innerW / 52))));
  const nowKey = monthKeyFor(new Date());

  return (
    <div ref={ref} className={styles.chartWrap} data-testid="commissions-chart">
      <svg width={width} height={H} role="img" aria-label="Commission by the paycheck it lands in">
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--color-surface-alt)" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className={styles.axisText}>{axis(t)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const cx = pad.left + step * i + step / 2;
          const x0 = cx - barW / 2;
          let acc = 0;
          const isSel = selected === p.payMonth;
          const dim = selected && !isSel;
          return (
            <g
              key={p.payMonth}
              className={own.bar}
              data-month={p.payMonth}
              tabIndex={p.amount > 0 ? 0 : -1}
              role="button"
              aria-pressed={isSel}
              aria-label={`${monthLabel(p.payMonth)} paycheck: ${cents(p.amount)} commission`}
              onClick={() => onSelect(isSel ? null : p.payMonth)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(isSel ? null : p.payMonth); } }}
              opacity={dim ? 0.35 : 1}
            >
              <title>{`${monthLabel(p.payMonth)} paycheck · ${cents(p.amount)} · click for the deals`}</title>
              {['paid', 'recorded', 'projected'].map(s => {
                const v = p.byStatus[s];
                if (!(v > 0)) return null;
                const top = y(acc + v);
                const h = y(acc) - top;
                acc += v;
                const st = STATUS_STYLE[s];
                return (
                  <rect key={s} x={x0} y={top} width={barW} height={Math.max(0, h - 1)} rx={2}
                    fill={st.color} fillOpacity={st.faded ? 0.3 : 1}
                    stroke={st.faded ? st.color : 'none'} strokeDasharray={st.faded ? '3 2' : undefined} />
                );
              })}
              {/* Whole column is the hit target, so thin or empty bars are still clickable. */}
              <rect x={pad.left + step * i} y={pad.top} width={step} height={innerH} fill="transparent"
                stroke={isSel ? 'var(--color-text-primary)' : 'none'} strokeWidth={isSel ? 1 : 0} strokeDasharray="2 3" />
            </g>
          );
        })}
        {points.map((p, i) => i % labelEvery === 0 && (
          <text key={p.payMonth} x={pad.left + step * i + step / 2} y={H - 8} textAnchor="middle" className={styles.axisText}
            fontWeight={p.payMonth === nowKey ? 700 : undefined}>
            {shortKey(p.payMonth)}
          </text>
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--color-text-muted)" />
      </svg>
    </div>
  );
}

/* Expected vs actual: two bars per pay month — what the tracker said the
   month-end paycheck would carry (take-home) and what it really carried above
   base salary. Click (or Enter) selects a month. */
function ExpectedVsActualChart({ points, selected, onSelect }) {
  const [ref, width] = useMeasuredWidth();
  const H = 260;
  const pad = { top: 14, right: 8, bottom: 26, left: 52 };
  const innerW = width - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(1, ...points.map(p => Math.max(p.expectedTakeHome, p.actual ? p.actual.commission : 0))));
  const step = innerW / Math.max(1, points.length);
  const barW = Math.max(3, Math.min(16, step * 0.32));
  const y = v => pad.top + innerH - (Math.max(0, v) / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(innerW / 52))));
  const nowKey = monthKeyFor(new Date());
  const bar = (x, v, style) => (v > 0 ? <rect x={x} y={y(v)} width={barW} height={Math.max(0, y(0) - y(v))} rx={2} {...style} /> : null);

  return (
    <div ref={ref} className={styles.chartWrap} data-testid="commissions-eva-chart">
      <svg width={width} height={H} role="img" aria-label="Expected versus actual commission by paycheck">
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--color-surface-alt)" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className={styles.axisText}>{axis(t)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const cx = pad.left + step * i + step / 2;
          const isSel = selected === p.payMonth;
          const dim = selected && !isSel;
          const label = `${monthLabel(p.payMonth)} paycheck: expected ${cents(p.expectedTakeHome)}, ${p.actual ? `actual ${cents(p.actual.commission)}` : 'not paid yet'}`;
          return (
            <g key={p.payMonth} className={own.bar} data-month={p.payMonth} tabIndex={0} role="button" aria-pressed={isSel} aria-label={label}
              onClick={() => onSelect(isSel ? null : p.payMonth)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(isSel ? null : p.payMonth); } }}
              opacity={dim ? 0.35 : 1}>
              <title>{`${label} · click for details`}</title>
              {bar(cx - barW - 1, p.expectedTakeHome, { fill: EVA.expected, fillOpacity: 0.3, stroke: EVA.expected, strokeDasharray: '3 2' })}
              {p.actual && bar(cx + 1, p.actual.commission, { fill: EVA.actual })}
              <rect x={pad.left + step * i} y={pad.top} width={step} height={innerH} fill="transparent"
                stroke={isSel ? 'var(--color-text-primary)' : 'none'} strokeWidth={isSel ? 1 : 0} strokeDasharray="2 3" />
            </g>
          );
        })}
        {points.map((p, i) => i % labelEvery === 0 && (
          <text key={p.payMonth} x={pad.left + step * i + step / 2} y={H - 8} textAnchor="middle" className={styles.axisText}
            fontWeight={p.payMonth === nowKey ? 700 : undefined}>
            {shortKey(p.payMonth)}
          </text>
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--color-text-muted)" />
      </svg>
    </div>
  );
}

const EVA = { expected: '#eb6834', actual: '#2a78d6' };
// Total pay: base and commission in their own colours; still-to-come is the
// same colour, faded and dashed.
const PAY = { base: '#2a78d6', commission: '#eb6834' };
const CHART_VIEWS = [
  { id: 'status', label: 'By status' },
  { id: 'eva', label: 'Expected vs actual' },
  { id: 'pay', label: 'Total pay' },
];
const pctOf = n => `${Math.round(n * 100)}%`;

/* Total pay, take-home: per paycheck (twice a month) or per month. Each slot
   has two bars side by side: on the left what it was expected to carry (faded,
   dashed), on the right what actually landed (solid). Base salary sits at the
   bottom of each bar with commission on top. A paycheck still to come has only
   its expected bar. Clicking either bar selects the whole month. */
const sumOf = v => (v ? v.base + v.commission : 0);
function TotalPayChart({ slots, selected, onSelect, perPaycheck }) {
  const [ref, width] = useMeasuredWidth();
  const H = 280;
  const pad = { top: 14, right: 8, bottom: 26, left: 52 };
  const innerW = width - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(1, ...slots.map(s => Math.max(sumOf(s.expected), sumOf(s.actual)))));
  const step = innerW / Math.max(1, slots.length);
  const barW = Math.max(2, Math.min(perPaycheck ? 14 : 20, step * 0.36));
  const gap = Math.max(1, Math.min(3, step * 0.06));
  const y = v => pad.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  const per = perPaycheck ? 2 : 1;
  const monthW = step * per;
  const months = slots.filter((s, i) => i % per === 0).map(s => s.payMonth);
  const labelEvery = Math.max(1, Math.ceil(months.length / Math.max(1, Math.floor(innerW / 52))));
  const nowKey = monthKeyFor(new Date());
  const stack = (x, v, faded, keyBase) => {
    if (!v) return null;
    let acc = 0;
    const segs = [{ k: 'base', v: v.base, color: PAY.base }, { k: 'comm', v: v.commission, color: PAY.commission }].filter(sg => sg.v > 0);
    return segs.map((sg, j) => {
      const top = y(acc + sg.v);
      const h = y(acc) - top;
      acc += sg.v;
      // 2px gap between stacked pieces so base and commission read as two.
      const hh = Math.max(0, h - (j > 0 ? 2 : 0));
      if (hh <= 0) return null;
      return (
        <rect key={`${keyBase}-${sg.k}`} data-part={`${keyBase}-${sg.k}`} x={x} y={top} width={barW} height={hh} rx={j === segs.length - 1 ? 2 : 0}
          fill={sg.color} fillOpacity={faded ? 0.28 : 1}
          stroke={faded ? sg.color : 'none'} strokeDasharray={faded ? '3 2' : undefined} />
      );
    });
  };

  return (
    <div ref={ref} className={styles.chartWrap} data-testid="commissions-pay-chart">
      <svg width={width} height={H} role="img" aria-label={`Total pay ${perPaycheck ? 'by paycheck' : 'by month'}: expected beside actual, base salary with commission on top`}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--color-surface-alt)" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className={styles.axisText}>{axis(t)}</text>
          </g>
        ))}
        {perPaycheck && months.map((m, i) => i > 0 && (
          <line key={`sep-${m}`} x1={pad.left + monthW * i} x2={pad.left + monthW * i} y1={pad.top} y2={y(0)} stroke="var(--color-surface-alt)" />
        ))}
        {slots.map((sl, i) => {
          const cx = pad.left + step * i + step / 2;
          const isSel = selected === sl.payMonth;
          const dim = selected && !isSel;
          const label = `${sl.label}: ${sl.expected ? `expected ${cents(sumOf(sl.expected))}` : 'no expected figure'}, ${sl.actual ? `actual ${cents(sumOf(sl.actual))}` : sl.status === 'expected' ? 'still to come' : 'nothing landed'}`;
          return (
            <g key={sl.id} className={own.bar} data-month={sl.payMonth} data-slot={sl.id} tabIndex={sl.expected || sl.actual ? 0 : -1} role="button" aria-pressed={isSel} aria-label={label}
              onClick={() => onSelect(isSel ? null : sl.payMonth)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(isSel ? null : sl.payMonth); } }}
              opacity={dim ? 0.35 : 1}>
              <title>{`${label} · click for details`}</title>
              {stack(cx - barW - gap / 2, sl.expected, true, 'exp')}
              {stack(cx + gap / 2, sl.actual, false, 'act')}
              <rect x={pad.left + step * i} y={pad.top} width={step} height={innerH} fill="transparent" />
            </g>
          );
        })}
        {selected && months.includes(selected) && (
          <rect x={pad.left + monthW * months.indexOf(selected)} y={pad.top} width={monthW} height={innerH} fill="none" pointerEvents="none"
            stroke="var(--color-text-primary)" strokeWidth={1} strokeDasharray="2 3" />
        )}
        {months.map((m, i) => i % labelEvery === 0 && (
          <text key={m} x={pad.left + monthW * i + monthW / 2} y={H - 8} textAnchor="middle" className={styles.axisText}
            fontWeight={m === nowKey ? 700 : undefined}>
            {shortKey(m)}
          </text>
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--color-text-muted)" />
      </svg>
    </div>
  );
}
const PAY_GRAINS = [
  { id: 'paycheck', label: 'Per paycheck' },
  { id: 'month', label: 'Per month' },
];
const STATUS_TEXT = { received: 'Received', expected: 'Expected', missed: 'Not found', 'no-data': 'Before history' };
const signed = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${cents(Math.abs(n))}`;
const diffColor = n => (n < -0.5 ? '#b91c1c' : n > 0.5 ? '#16a34a' : 'var(--color-text-secondary)');

function CommissionChartCard({ commissions, takeHome, paychecks, base }) {
  const [chartView, setChartView] = useState('status');
  const [payGrain, setPayGrain] = useState('paycheck');
  const [range, setRange] = useState('around');
  const [account, setAccount] = useState('');
  const [statuses, setStatuses] = useState(() => new Set(STATUSES.map(s => s.id)));
  const [selected, setSelected] = useState(null);

  const rows = useMemo(() => commissionRows(commissions, new Date()), [commissions]);
  const accounts = useMemo(() => [...new Set(rows.map(r => r.account).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [rows]);
  const statusPoints = useMemo(
    () => chartPoints({ rows, accounts: account ? new Set([account]) : null, statuses, range, today: new Date() }),
    [rows, account, statuses, range],
  );
  const evaPoints = useMemo(
    () => expectedVsActual({ rows, paychecks, takeHome, range, today: new Date() }),
    [rows, paychecks, takeHome, range],
  );
  const payPoints = useMemo(
    () => payByMonth({ rows, paychecks, base, takeHome, range, today: new Date() }),
    [rows, paychecks, base, takeHome, range],
  );
  const eva = chartView === 'eva';
  const isPay = chartView === 'pay';
  // Views that are about whole paychecks can't be narrowed to one account.
  const wholePaycheck = eva || isPay;
  const points = eva ? evaPoints : isPay ? payPoints : statusPoints;
  const evaTotals = useMemo(() => expectedVsActualTotals(evaPoints), [evaPoints]);
  const payTotals = useMemo(() => {
    const b = payPoints.reduce((s, p) => s + p.base.actual + p.base.expected, 0);
    const c = payPoints.reduce((s, p) => s + p.commission.actual + p.commission.expected, 0);
    return { base: b, commission: c, total: b + c, share: b + c > 0 ? c / (b + c) : 0 };
  }, [payPoints]);
  const sel = points.find(p => p.payMonth === selected) || null;
  const perPaycheck = payGrain === 'paycheck';
  const paySlots = useMemo(() => (perPaycheck
    ? payPoints.flatMap(p => p.slots.map(sl => ({
      ...sl,
      label: `${sl.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} ${sl.kind === 'mid' ? 'mid-month' : 'month-end'} paycheck`,
    })))
    : payPoints.map(p => ({
      id: p.payMonth, payMonth: p.payMonth, label: monthLabel(p.payMonth),
      status: p.landed.length ? 'received' : p.expectedSlots ? 'expected' : 'missed',
      expected: p.planned,
      actual: p.landed.length ? { base: p.base.actual, commission: p.commission.actual } : null,
    }))), [payPoints, perPaycheck]);
  const total = statusPoints.reduce((s, p) => s + p.amount, 0);
  const rate = takeHome ?? 0.6;

  const toggleStatus = id => setStatuses(prev => {
    const next = new Set(prev);
    if (next.has(id)) { if (next.size > 1) next.delete(id); } else next.add(id);
    return next;
  });
  const filterNote = [
    CHART_RANGES.find(r => r.id === range)?.label,
    account || 'all accounts',
    STATUSES.filter(s => statuses.has(s.id)).map(s => s.label).join(', '),
  ].join(' · ');

  const today = new Date().toISOString().slice(0, 10);
  const rateNote = `Take-home at ${Math.round(rate * 100)}% of pre-tax, the share past month-end paychecks carried`;
  const PAY_COLS = [10, 16, 16, 20, 20, 14, 16, 18, 18];
  const PAYCHECK_COLS = [10, 12, 12, 14, 14, 16, 14, 14, 14, 14, 12];
  const exportChart = () => downloadXlsx(isPay ? [
    { name: 'Total pay', rows: [[{ v: 'Total pay: base salary + commission (take-home)', s: 'title' }], [{ v: `${CHART_RANGES.find(r => r.id === range)?.label} · received = what landed; expected = usual base + ${rateNote.toLowerCase()}`, s: 'muted' }], [], ...payByMonthSheetRows(points)], cols: PAY_COLS },
    { name: 'Paychecks', rows: payByMonthPaycheckRows(points), cols: PAYCHECK_COLS },
    { name: 'Deals', rows: rawSheetRows(points, takeHome), cols: [12, 10, 12, 28, 28, 20, 20, 14] },
  ] : eva ? [
    { name: 'Expected vs actual', rows: [[{ v: 'Commission: expected vs actual', s: 'title' }], [{ v: `${CHART_RANGES.find(r => r.id === range)?.label} · ${rateNote}. Actual = month-end deposit minus base salary.`, s: 'muted' }], [], ...expectedVsActualSheetRows(points)], cols: [12, 10, 12, 16, 16, 16, 14, 22, 12, 8] },
    { name: 'Raw data', rows: rawSheetRows(points, takeHome), cols: [12, 10, 12, 28, 28, 20, 20, 14] },
  ] : [
    { name: 'Chart', rows: [[{ v: 'Commissions by paycheck', s: 'title' }], [{ v: filterNote, s: 'muted' }], [], ...chartSheetRows(points, takeHome)], cols: [12, 10, 12, 12, 20, 12, 16, 14, 8] },
    { name: 'Raw data', rows: rawSheetRows(points, takeHome), cols: [12, 10, 12, 28, 28, 20, 20, 14] },
  ], `commissions-${isPay ? 'total-pay' : eva ? 'expected-vs-actual' : 'chart'}-${today}`);
  const exportPoint = () => sel && downloadXlsx([
    ...(isPay ? [
      { name: 'Total pay', rows: payByMonthSheetRows([sel]), cols: PAY_COLS },
      { name: 'Paychecks', rows: payByMonthPaycheckRows([sel]), cols: PAYCHECK_COLS },
    ] : []),
    ...(eva ? [{ name: 'Expected vs actual', rows: expectedVsActualSheetRows([sel]), cols: [12, 10, 12, 16, 16, 16, 14, 22, 12, 8] }] : []),
    { name: wholePaycheck ? 'Deals' : monthLabel(sel.payMonth, { month: 'short', year: 'numeric' }), rows: rawSheetRows([sel], takeHome), cols: [12, 10, 12, 28, 28, 20, 20, 14] },
  ], `commissions-${sel.payMonth}${isPay ? '-total-pay' : eva ? '-paycheck-expected-vs-actual' : '-paycheck'}`);
  const switchView = id => { setChartView(id); setSelected(null); };

  return (
    <section className={styles.card} data-testid="commissions-chart-card">
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>{isPay ? 'Total pay: base + commission' : eva ? 'Expected vs actual commissions' : 'Expected commissions'}</h2>
          <div className={styles.cardHint}>
            {isPay ? (
              <>
                Take-home {perPaycheck ? 'for each paycheck, twice a month' : 'by month, both paychecks together'}: base salary with commission on top. Each {perPaycheck ? 'paycheck' : 'month'} shows what was expected (faded, left) beside what actually landed (solid, right); one still to come has only its expected bar.
                {payTotals.total > 0 && <> Across what’s shown: {money(payTotals.total)} total, {money(payTotals.base)} base and {money(payTotals.commission)} commission ({pctOf(payTotals.share)} of pay).</>}
              </>
            ) : eva ? (
              <>
                Each month-end paycheck: the commission the tracker expected (take-home) beside what the paycheck actually carried above base salary.
                {evaTotals.months > 0 && (
                  <> Across the {evaTotals.months} paid month{evaTotals.months === 1 ? '' : 's'} shown: expected {money(evaTotals.expected)}, received {money(evaTotals.actual)}{' '}
                    (<span style={{ color: diffColor(evaTotals.diff), fontWeight: 700 }}>{signed(evaTotals.diff)}</span>).</>
                )}
              </>
            ) : (
              <>Pre-tax, by the month-end paycheck each lands in. {money(total)} across what’s shown. Click a bar to see the deals behind it and export them.</>
            )}
          </div>
        </div>
        <button type="button" className={own.exportBtn} onClick={exportChart} disabled={!points.length} data-testid="export-chart">
          Export chart data
        </button>
      </div>

      <div className={own.filters}>
        <div className={styles.segment} role="group" aria-label="Chart view" data-testid="chart-view">
          {CHART_VIEWS.map(v => (
            <button key={v.id} type="button" className={`${styles.segmentBtn} ${chartView === v.id ? styles.segmentActive : ''}`} aria-pressed={chartView === v.id} onClick={() => switchView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        <div className={styles.segment} role="group" aria-label="Range">
          {CHART_RANGES.map(r => (
            <button key={r.id} type="button" className={`${styles.segmentBtn} ${range === r.id ? styles.segmentActive : ''}`} onClick={() => { setRange(r.id); setSelected(null); }}>
              {r.label}
            </button>
          ))}
        </div>
        {isPay ? (
          <>
            <div className={styles.segment} role="group" aria-label="Pay grouping" data-testid="pay-grain">
              {PAY_GRAINS.map(g => (
                <button key={g.id} type="button" className={`${styles.segmentBtn} ${payGrain === g.id ? styles.segmentActive : ''}`} aria-pressed={payGrain === g.id} onClick={() => setPayGrain(g.id)}>
                  {g.label}
                </button>
              ))}
            </div>
            <span className={own.chip} style={{ cursor: 'default' }}><i style={{ background: PAY.base }} />Base salary</span>
            <span className={own.chip} style={{ cursor: 'default' }}><i style={{ background: PAY.commission }} />Commission</span>
            <span className={own.chip} style={{ cursor: 'default' }}><i style={{ background: 'transparent', border: '1.5px dashed var(--color-text-secondary)' }} />Expected (left)</span>
            <span className={own.chip} style={{ cursor: 'default' }}><i style={{ background: 'var(--color-text-secondary)' }} />Actual (right)</span>
            <span className={own.hint} style={{ marginTop: 0 }}>All accounts: a paycheck can’t be split by account.</span>
          </>
        ) : eva ? (
          <>
            <span className={own.chip} style={{ cursor: 'default' }}><i style={{ background: EVA.expected, opacity: 0.35, border: `1px dashed ${EVA.expected}` }} />Expected (take-home)</span>
            <span className={own.chip} style={{ cursor: 'default' }}><i style={{ background: EVA.actual }} />Actual, in the paycheck</span>
            <span className={own.hint} style={{ marginTop: 0 }}>All accounts: a paycheck can’t be split by account.</span>
          </>
        ) : (
        <select className={own.select} value={account} onChange={e => { setAccount(e.target.value); setSelected(null); }} aria-label="Account" data-testid="account-filter">
          <option value="">All accounts</option>
          {accounts.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        )}
        {!wholePaycheck && STATUSES.map(s => {
          const st = STATUS_STYLE[s.id];
          const on = statuses.has(s.id);
          return (
            <button key={s.id} type="button" className={`${own.chip} ${on ? '' : own.chipOff}`} aria-pressed={on} onClick={() => toggleStatus(s.id)}>
              <i style={{ background: st.color, opacity: st.faded ? 0.35 : 1, border: st.faded ? `1px dashed ${st.color}` : 'none' }} />
              {s.label}
            </button>
          );
        })}
      </div>

      {!points.length ? (
        <div className={styles.muted}>Nothing matches these filters.</div>
      ) : isPay ? (
        <TotalPayChart slots={paySlots} selected={selected} onSelect={setSelected} perPaycheck={perPaycheck} />
      ) : eva ? (
        <ExpectedVsActualChart points={points} selected={selected} onSelect={setSelected} />
      ) : (
        <CommissionChart points={points} selected={selected} onSelect={setSelected} />
      )}

      {sel ? (
        <div className={own.detail} data-testid="commissions-chart-detail">
          <div className={own.detailHead}>
            <div>
              <div className={own.detailTitle}>
                {isPay
                  ? <>{monthLabel(sel.payMonth)} · {cents(sel.total)} total pay · {pctOf(sel.commissionShare)} commission</>
                  : eva
                  ? <>{monthLabel(sel.payMonth)} paycheck · expected {cents(sel.expectedTakeHome)}, {sel.actual ? <>actual {cents(sel.actual.commission)} <span style={{ color: diffColor(sel.diff) }}>({signed(sel.diff)})</span></> : 'not paid yet'}</>
                  : <>{monthLabel(sel.payMonth)} paycheck · {cents(sel.amount)} pre-tax</>}
              </div>
              <div className={styles.cardHint}>
                {isPay
                  ? <>Base {cents(sel.base.actual + sel.base.expected)}{sel.base.expected ? ` (${cents(sel.base.expected)} still to come)` : ''} · commission {cents(sel.commission.actual + sel.commission.expected)}{sel.commission.expected ? ` expected, ${cents(sel.expectedPreTax)} pre-tax × ${Math.round(rate * 100)}%` : ' received'}</>
                  : eva
                  ? (sel.actual
                    ? <>Landed {dayY(sel.actual.date)}: {cents(sel.actual.deposit)} deposit − {cents(sel.actual.base)} base salary = {cents(sel.actual.commission)} commission. Expected {cents(sel.expectedPreTax)} pre-tax × {Math.round(rate * 100)}%.</>
                    : <>Due {dayY(asDate(sel.payDate))}. Expected {cents(sel.expectedPreTax)} pre-tax × {Math.round(rate * 100)}%. No month-end deposit yet.</>)
                  : <>Lands {dayY(asDate(sel.payDate))} · about {cents(sel.amount * rate)} take-home · {sel.rows.length} deal{sel.rows.length === 1 ? '' : 's'}</>}
              </div>
            </div>
            <div className={own.detailActions}>
              <button type="button" className={own.exportBtn} onClick={exportPoint} disabled={!sel.rows.length && !(eva && sel.actual) && !(isPay && sel.total > 0)} data-testid="export-point">{isPay ? 'Export this month' : 'Export this paycheck'}</button>
              <button type="button" className={styles.linkBtn} style={{ marginTop: 0 }} onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
          {isPay && sel.slots.some(sl => sl.expected || sl.actual) && (
            <div className={styles.tableWrap} style={{ marginBottom: 12 }}>
              <table className={styles.table} data-testid="pay-paychecks">
                <thead>
                  <tr>
                    <th>Paycheck</th>
                    <th>Status</th>
                    <th className={styles.num}>Expected</th>
                    <th className={styles.num}>Deposit</th>
                    <th className={styles.num}>Base</th>
                    <th className={styles.num}>Commission</th>
                    <th className={styles.num}>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {sel.slots.map(sl => (
                    <tr key={sl.id}>
                      <td className={styles.nowrap}><i className={sl.kind === 'mid' ? own.kindMid : own.kindEnd} />{sl.kind === 'mid' ? 'Mid-month' : 'Month-end'} <span className={styles.muted}>· {dayY(sl.date)}</span></td>
                      <td>{sl.status === 'received' ? <span className={own.statusReceived}>Received</span> : <span className={own.statusExpected}>{STATUS_TEXT[sl.status]}</span>}</td>
                      <td className={styles.num}>{sl.expected ? <>{cents(sumOf(sl.expected))}{sl.expected.commission > 0 && <span className={styles.muted}> ({cents(sl.expected.commission)} comm.)</span>}</> : <span className={styles.muted}>—</span>}</td>
                      <td className={styles.num}>{sl.actual ? cents(sl.actual.deposit) : <span className={styles.muted}>—</span>}</td>
                      <td className={styles.num}>{sl.actual ? cents(sl.actual.base) : <span className={styles.muted}>—</span>}</td>
                      <td className={styles.num}>{sl.actual ? (sl.actual.commission ? cents(sl.actual.commission) : <span className={styles.muted}>—</span>) : <span className={styles.muted}>—</span>}</td>
                      <td className={styles.num} style={{ color: sl.diff == null ? undefined : diffColor(sl.diff), fontWeight: sl.diff == null ? undefined : 700 }}>{sl.diff == null ? <span className={styles.muted}>—</span> : signed(sl.diff)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {sel.rows.length ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Project</th>
                    <th>Earned</th>
                    <th>Status</th>
                    <th className={styles.num}>Pre-tax</th>
                    <th className={styles.num}>Est. take-home</th>
                  </tr>
                </thead>
                <tbody>
                  {sel.rows.map((r, i) => (
                    <tr key={`${r.account}-${r.project}-${i}`}>
                      <td>{r.account || '—'}</td>
                      <td className={styles.muted}>{r.project || '—'}</td>
                      <td className={styles.nowrap}>{monthLabel(r.earnedMonth, { month: 'short', year: 'numeric' })}</td>
                      <td className={styles.nowrap}>{STATUSES.find(s => s.id === r.status)?.label}</td>
                      <td className={styles.num}>{cents(r.amount)}</td>
                      <td className={styles.num}>{cents(r.amount * rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.muted}>{wholePaycheck ? 'The tracker expected no commission in this paycheck.' : 'No commission in this paycheck with the current filters.'}</div>
          )}
        </div>
      ) : points.length > 0 && <div className={own.hint}>Tip: click any bar to see {isPay ? 'its paychecks and deals and export them.' : eva ? 'how the paycheck compares and export its deals.' : 'and export its deals.'}</div>}
    </section>
  );
}

export function CommissionsPage() {
  const { loading, error, updatedAt, commissions, payouts } = useCommissions();
  const { transactions, incomeCategories } = useData();
  const [view, setView] = useState('all');
  const [sort, setSort] = useState('recent');

  const today = new Date();

  // Paychecks split into base + commission exactly as the Income page does.
  const pay = useMemo(() => {
    if (!transactions?.length) return { base: null, schedule: [], takeHome: null, paychecks: [] };
    const now = new Date();
    const { paychecks } = computeIncome({ transactions, incomeCategories, monthKeys: monthKeysEnding(monthKeyFor(now), 13), today: now });
    const base = baseSalary(paychecks, now);
    const takeHome = commissionTakeHome(paychecks, payouts, now);
    const schedule = paySchedule({ base, paychecks, expected: expectedPayouts(commissions, now), takeHome, today: now });
    return { base, schedule, takeHome, paychecks };
  }, [transactions, incomeCategories, commissions, payouts]);
  const byMonth = useMemo(() => earnedByMonth(commissions), [commissions]);
  // The last 12 months that have ended, oldest first.
  const last12 = useMemo(() => {
    const out = [];
    for (let i = 12; i >= 1; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const key = ymKey(d.getFullYear(), d.getMonth());
      out.push({ key, amount: byMonth[key] || 0 });
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byMonth]);
  const total12 = last12.reduce((s, m) => s + m.amount, 0);
  const ytd = Object.entries(byMonth).filter(([k]) => k.startsWith(`${today.getFullYear()}-`)).reduce((s, [, v]) => s + v, 0);
  const latest = payouts.length ? payouts[payouts.length - 1] : null;
  const max = Math.max(1, ...last12.map(m => m.amount));

  const rows = useMemo(() => {
    const list = commissions.filter(c => (view === 'active' ? c.active : true));
    const key = sort === 'total' ? (c => -c.total) : (c => -(c.lastPaid ? Number(c.lastPaid.replace('-', '')) : 0));
    return [...list].sort((a, b) => key(a) - key(b) || a.account.localeCompare(b.account));
  }, [commissions, view, sort]);

  if (loading && !commissions.length) return <div className={styles.empty}>Reading the Prospect Tracker…</div>;
  if (error && !commissions.length) return <div className={styles.empty}>Couldn’t read the Prospect Tracker: {error}</div>;
  if (!commissions.length) return <div className={styles.empty}>The tracker’s Commissions table is empty.</div>;

  return (
    <div className={styles.page}>
      <div className={styles.hero} data-testid="commissions-hero">
        <div className={styles.heroLabel}>Commissions</div>
        <h1 className={styles.heroTitle}>
          {money(total12)}
          <span className={styles.heroTitleSub}> earned over the last 12 months, before tax</span>
        </h1>
        <div className={styles.heroStats}>
          <Stat value={money(ytd)} label={`${today.getFullYear()} so far`} />
          <Stat value={money(total12 / 12)} label="Average a month" />
          {latest && (
            <Stat
              value={money(latest.amount)}
              label={`Latest: ${monthLabel(latest.earnedMonth)}`}
              sub={`paid in the ${monthLabel(payMonthOf(latest.earnedMonth), { month: 'short', year: 'numeric' })} month-end paycheck`}
            />
          )}
          <Stat value={commissions.filter(c => c.active).length} label="Active" sub={`of ${commissions.length} in the tracker`} />
          {pay.base && <Stat value={cents(pay.base.amount)} label="Base salary" sub={`mid-month paycheck, usually the ${pay.base.day}th`} />}
        </div>
      </div>

      <BaseSalaryCard base={pay.base} />
      {pay.schedule.length > 0 && <PayScheduleCard schedule={pay.schedule} takeHome={pay.takeHome} />}
      <CommissionChartCard commissions={commissions} takeHome={pay.takeHome} paychecks={pay.paychecks} base={pay.base} />

      <div className={styles.controls}>
        <div className={styles.segment} role="group" aria-label="Which commissions">
          {VIEWS.map(v => (
            <button key={v.id} type="button" className={`${styles.segmentBtn} ${view === v.id ? styles.segmentActive : ''}`} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        <div className={styles.segment} role="group" aria-label="Sort">
          {[{ id: 'recent', label: 'Latest paid' }, { id: 'total', label: 'Biggest' }].map(s => (
            <button key={s.id} type="button" className={`${styles.segmentBtn} ${sort === s.id ? styles.segmentActive : ''}`} onClick={() => setSort(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className={styles.controlsNote}>
          Read from the Prospect Tracker{updatedAt ? ` (last edited there ${dayY(new Date(updatedAt))})` : ''}; edit it there.
          {error && ` Couldn’t refresh just now (${error}) — showing the last copy.`}
        </div>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>By month earned</h2>
            <div className={styles.cardHint}>Each is paid in the following month’s month-end paycheck.</div>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="commissions-months">
            <tbody>
              {[...last12].reverse().map(m => (
                <tr key={m.key}>
                  <td className={styles.nowrap}>{monthLabel(m.key, { month: 'short', year: 'numeric' })}</td>
                  <td className={styles.shareCell}>
                    <div className={styles.shareBar}><div style={{ width: `${Math.max(m.amount ? 2 : 0, (m.amount / max) * 100)}%`, background: '#2a78d6' }} /></div>
                  </td>
                  <td className={styles.num}>{m.amount ? money(m.amount) : <span className={styles.muted}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>{view === 'active' ? 'Active commissions' : 'Every commission'}</h2>
            <div className={styles.cardHint}>
              Active: the window hasn’t ended, or it paid within the last two months.
            </div>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="commissions-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Project</th>
                <th className={styles.num}>Rate</th>
                <th>Window</th>
                <th>Status</th>
                <th>Last paid</th>
                <th className={styles.num}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(c => (
                <tr key={c.id}>
                  <td>{c.account || '—'}</td>
                  <td className={styles.muted}>{c.project || '—'}</td>
                  <td className={styles.num}>{pct(c.rate)}</td>
                  <td className={styles.nowrap}>{shortDate(c.start)} – {shortDate(c.end)}</td>
                  <td>{c.active ? 'Active' : <span className={styles.muted}>Ended</span>}</td>
                  <td className={styles.nowrap}>
                    {c.lastPaid ? <>{monthLabel(c.lastPaid, { month: 'short', year: 'numeric' })} <span className={styles.muted}>{money(c.months[c.lastPaid])}</span></> : <span className={styles.muted}>—</span>}
                  </td>
                  <td className={styles.num}>{money(c.total)}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={7} className={styles.muted}>None {view === 'active' ? 'active' : ''} right now.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
