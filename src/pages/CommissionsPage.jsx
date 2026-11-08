import { useEffect, useMemo, useRef, useState } from 'react';
import { useCommissions } from '../hooks/useCommissions';
import { useData } from '../contexts/DataContext';
import { earnedByMonth, monthLabel, payMonthOf, ymKey, expectedPayouts } from '../lib/commissions';
import { computeIncome, commissionTakeHome, monthKeysEnding, monthKeyFor } from '../lib/income';
import {
  baseSalary, paySchedule, commissionRows, chartPoints, rawSheetRows, chartSheetRows,
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

function CommissionChartCard({ commissions, takeHome }) {
  const [range, setRange] = useState('around');
  const [account, setAccount] = useState('');
  const [statuses, setStatuses] = useState(() => new Set(STATUSES.map(s => s.id)));
  const [selected, setSelected] = useState(null);

  const rows = useMemo(() => commissionRows(commissions, new Date()), [commissions]);
  const accounts = useMemo(() => [...new Set(rows.map(r => r.account).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [rows]);
  const points = useMemo(
    () => chartPoints({ rows, accounts: account ? new Set([account]) : null, statuses, range, today: new Date() }),
    [rows, account, statuses, range],
  );
  const sel = points.find(p => p.payMonth === selected) || null;
  const total = points.reduce((s, p) => s + p.amount, 0);
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

  const exportChart = () => downloadXlsx([
    { name: 'Chart', rows: [[{ v: 'Commissions by paycheck', s: 'title' }], [{ v: filterNote, s: 'muted' }], [], ...chartSheetRows(points, takeHome)], cols: [12, 10, 12, 12, 20, 12, 16, 14, 8] },
    { name: 'Raw data', rows: rawSheetRows(points, takeHome), cols: [12, 10, 12, 28, 28, 20, 20, 14] },
  ], `commissions-chart-${new Date().toISOString().slice(0, 10)}`);
  const exportPoint = () => sel && downloadXlsx([
    { name: monthLabel(sel.payMonth, { month: 'short', year: 'numeric' }), rows: rawSheetRows([sel], takeHome), cols: [12, 10, 12, 28, 28, 20, 20, 14] },
  ], `commissions-${sel.payMonth}-paycheck`);

  return (
    <section className={styles.card} data-testid="commissions-chart-card">
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>Expected commissions</h2>
          <div className={styles.cardHint}>
            Pre-tax, by the month-end paycheck each lands in. {money(total)} across what’s shown. Click a bar to see the deals behind it and export them.
          </div>
        </div>
        <button type="button" className={own.exportBtn} onClick={exportChart} disabled={!points.length} data-testid="export-chart">
          Export chart data
        </button>
      </div>

      <div className={own.filters}>
        <div className={styles.segment} role="group" aria-label="Range">
          {CHART_RANGES.map(r => (
            <button key={r.id} type="button" className={`${styles.segmentBtn} ${range === r.id ? styles.segmentActive : ''}`} onClick={() => { setRange(r.id); setSelected(null); }}>
              {r.label}
            </button>
          ))}
        </div>
        <select className={own.select} value={account} onChange={e => { setAccount(e.target.value); setSelected(null); }} aria-label="Account" data-testid="account-filter">
          <option value="">All accounts</option>
          {accounts.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        {STATUSES.map(s => {
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

      {points.length ? (
        <CommissionChart points={points} selected={selected} onSelect={setSelected} />
      ) : (
        <div className={styles.muted}>Nothing matches these filters.</div>
      )}

      {sel ? (
        <div className={own.detail} data-testid="commissions-chart-detail">
          <div className={own.detailHead}>
            <div>
              <div className={own.detailTitle}>
                {monthLabel(sel.payMonth)} paycheck · {cents(sel.amount)} pre-tax
              </div>
              <div className={styles.cardHint}>
                Lands {dayY(asDate(sel.payDate))} · about {cents(sel.amount * rate)} take-home · {sel.rows.length} deal{sel.rows.length === 1 ? '' : 's'}
              </div>
            </div>
            <div className={own.detailActions}>
              <button type="button" className={own.exportBtn} onClick={exportPoint} disabled={!sel.rows.length} data-testid="export-point">Export this paycheck</button>
              <button type="button" className={styles.linkBtn} style={{ marginTop: 0 }} onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
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
            <div className={styles.muted}>No commission in this paycheck with the current filters.</div>
          )}
        </div>
      ) : points.length > 0 && <div className={own.hint}>Tip: click any bar to see and export its deals.</div>}
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
    if (!transactions?.length) return { base: null, schedule: [], takeHome: null };
    const now = new Date();
    const { paychecks } = computeIncome({ transactions, incomeCategories, monthKeys: monthKeysEnding(monthKeyFor(now), 13), today: now });
    const base = baseSalary(paychecks, now);
    const takeHome = commissionTakeHome(paychecks, payouts, now);
    const schedule = paySchedule({ base, paychecks, expected: expectedPayouts(commissions, now), takeHome, today: now });
    return { base, schedule, takeHome };
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
      <CommissionChartCard commissions={commissions} takeHome={pay.takeHome} />

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
