import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { computeOvershot, monthsSpanned, expectedIncomeMonths, incomeBuckets, subtractRent } from '../lib/overshot';
import { buildCashPosition } from '../lib/cashPosition';
import { CashBridgeReport } from '../components/CashBridgeReport';
import { SurplusSplit } from '../components/SurplusSplit';
import { UpcomingCashPlan } from '../components/UpcomingCashPlan';
import { upcomingCardPayments } from '../lib/paymentReminder';
import { countedAccountMatcher } from '../lib/cashBridge';
import { detectPaychecks, detectCashBills, planUpcomingCash } from '../lib/upcomingCash';
import { useCommissions } from '../hooks/useCommissions';
import { expectedPayouts, monthLabel } from '../lib/commissions';
import { computeIncome, commissionTakeHome, monthKeysEnding, monthKeyFor as incomeMonthKey } from '../lib/income';
import { baseSalary, paySchedule } from '../lib/commissionSchedule';
import { projectedMonth } from '../lib/overIncomeAlert';
import { monthOutlook } from '../lib/monthOutlook';
import styles from './OvershotPage.module.css';

/* When spending overtakes income. Same income/spending definitions as Cash
   Flow (see lib/overshot.js); this page only asks "which side won, and why". */

// Categorical pair validated with the dataviz palette checker (CVD ΔE 24.7).
// Red is kept for the "over" status, which always carries an icon and label.
const INCOME = '#2a78d6';
const SPENDING = '#eb6834';
// The income bar's buckets: payroll in two blues, everything else in teal.
const BUCKETS = [
  { id: 'base', label: 'Base salary', color: INCOME },
  { id: 'commission', label: 'Commission', color: '#8dbcf2' },
  { id: 'other', label: 'Other income', color: '#0e9aa7' },
];
const CRITICAL = '#d03b3b';
const CASH_PREF_KEY = 'wa-overshot-cash-accounts';
const RENT_PREF_KEY = 'wa-overshot-subtract-rent';
const DETAIL_CATS_PREF_KEY = 'wa-overshot-month-categories';

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
  const { transactions, balanceHistory, balances, incomeCategories, hiddenCards, statementCloseDays, accountNicknames, accountGroups, loading } = useData();
  const { payouts: commissionPayouts, commissions } = useCommissions();
  const [range, setRange] = useState(12);
  const [surplusMode, setSurplusMode] = useState('cash'); // 'cash' | 'flow'
  // The monthly chart with rent taken out of both sides: a view preference,
  // kept in this browser only.
  // The month clicked on the chart, opened as actual beside projected.
  const [picked, setPicked] = useState(null);
  const [noRent, setNoRent] = useState(() => { try { return localStorage.getItem(RENT_PREF_KEY) === '1'; } catch { return false; } });
  const toggleNoRent = () => setNoRent(v => {
    try { localStorage.setItem(RENT_PREF_KEY, v ? '0' : '1'); } catch { /* private mode */ }
    return !v;
  });
  // Which accounts count as cash on hand, beyond the defaults. Kept in this
  // browser only: a per-viewer preference, not data.
  const [cashOverrides, setCashOverrides] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CASH_PREF_KEY) || '{}') || {}; } catch { return {}; }
  });
  const toggleAccount = (key, on) => {
    setCashOverrides(prev => {
      const next = { ...prev, [key]: on };
      try { localStorage.setItem(CASH_PREF_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  };

  const result = useMemo(() => {
    if (!transactions?.length) return null;
    const today = new Date();
    const all = monthsSpanned(transactions, today);
    // The window is N complete months plus the one in progress.
    const keys = range ? all.slice(-(range + 1)) : all;
    return computeOvershot({ transactions, monthKeys: keys, today });
  }, [transactions, range]);

  const cash = useMemo(() => {
    if (!result || !balanceHistory?.length) return null;
    const pos = buildCashPosition({ balanceHistory, monthKeys: result.months.map(m => m.key), today: new Date(), overrides: cashOverrides });
    return pos.now ? pos : null;
  }, [result, balanceHistory, cashOverrides]);

  // What's coming up: paychecks, card payments and bills paid from cash over
  // the next few weeks, and which money pays for each. Card payments come
  // from the same schedule the reminder email uses.
  const upcoming = useMemo(() => {
    if (!transactions?.length || !cash) return null;
    const today = new Date();
    const isCounted = countedAccountMatcher(cash.accounts);
    const names = { ...(accountNicknames || {}), ...(accountGroups || {}) };
    const plan = planUpcomingCash({
      cashOnHand: cash.now.cash,
      cardPayments: upcomingCardPayments({ transactions, balances, hiddenCards, nicknames: names, closeDays: statementCloseDays, asOf: today }),
      paychecks: detectPaychecks({ transactions, incomeCategories, today }),
      bills: detectCashBills({ transactions, isCashAccount: t => { const w = isCounted(t); return w.counted && w.kind === 'cash'; }, today }),
      commissionPayouts,
      today,
    });
    return { ...plan, cashAsOf: cash.now.asOf };
  }, [transactions, cash, balances, hiddenCards, statementCloseDays, accountNicknames, accountGroups, incomeCategories, commissionPayouts]);

  // Payroll split into base and commission, exactly as the Income and
  // Commissions pages split it (every payroll deposit on record, not just
  // the window's).
  const paychecks = useMemo(() => {
    if (!transactions?.length) return [];
    const now = new Date();
    return computeIncome({ transactions, incomeCategories, monthKeys: monthKeysEnding(incomeMonthKey(now), 13), today: now }).paychecks;
  }, [transactions, incomeCategories]);
  const buckets = useMemo(() => (result ? incomeBuckets({ months: result.months, paychecks }) : {}), [result, paychecks]);

  // Expected income, month by month, from the Commissions tab's pay
  // schedule — built exactly as that tab builds it, so the two agree.
  const expectedIncome = useMemo(() => {
    if (!transactions?.length) return null;
    const now = new Date();
    const base = baseSalary(paychecks, now);
    if (!base) return null;
    const takeHome = commissionTakeHome(paychecks, commissionPayouts, now);
    const schedule = paySchedule({ base, paychecks, expected: expectedPayouts(commissions, now), takeHome, today: now });
    return { base, takeHome, months: expectedIncomeMonths({ schedule, typicalSpending: result?.pace?.typicalSpending ?? null, months: 6 }) };
  }, [transactions, paychecks, commissions, commissionPayouts, result]);

  const outlook = useMemo(() => {
    if (!picked || !transactions?.length) return null;
    return monthOutlook({ transactions, incomeCategories, commissions, key: picked, today: new Date() });
  }, [picked, transactions, incomeCategories, commissions]);

  // Each month's surplus split into invested and kept, beside what the cash
  // position actually did (needs the month-end before the window too).
  const split = useMemo(() => {
    if (!result) return [];
    const keys = result.months.map(m => m.key);
    const change = {};
    if (balanceHistory?.length && keys.length) {
      const [y, mo] = keys[0].split('-').map(Number);
      const before = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
      const pos = buildCashPosition({ balanceHistory, monthKeys: [before, ...keys], today: new Date(), overrides: cashOverrides });
      pos.months.forEach((m, i) => {
        const prev = pos.months[i - 1];
        if (i > 0 && m.net != null && prev?.net != null) change[m.key] = Math.round((m.net - prev.net) * 100) / 100;
      });
    }
    return result.months.map(m => ({ key: m.key, surplus: m.net, invested: m.invested, kept: m.kept, cashChange: change[m.key] ?? null, partial: m.partial }));
  }, [result, balanceHistory, cashOverrides]);

  // Months the cash report can cover: from the first month that has a
  // month-end before it (balance history began the month before) to now.
  const bridgeMonths = useMemo(() => {
    if (!transactions?.length || !balanceHistory?.length) return [];
    let first = null;
    for (const r of balanceHistory) {
      const d = new Date(r.date);
      if (!isNaN(d) && (!first || d < first)) first = d;
    }
    if (!first) return [];
    const next = new Date(first.getFullYear(), first.getMonth() + 1, 1);
    const startKey = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
    return monthsSpanned(transactions, new Date()).filter(k => k >= startKey);
  }, [transactions, balanceHistory]);

  if (loading && !result) return <div className={styles.empty}>Loading transactions…</div>;
  if (!result || !result.months.length) return <div className={styles.empty}>No transactions yet.</div>;

  const { months, summary, pace } = result;
  const complete = months.filter(m => !m.partial);
  // The month in progress against the income it's expected to bring in: what
  // has come in plus the paychecks still due. Only once there's a pay schedule.
  const projection = expectedIncome?.months.length
    ? projectedMonth({ month: months.find(m => m.partial), expected: expectedIncome.months })
    : null;
  const newestFirst = [...months].reverse();
  const chart = { months, buckets, expected: expectedIncome?.months || [], projection };
  const shownChart = noRent ? subtractRent(chart) : chart;
  const hasRent = months.some(m => m.rent > 0);

  return (
    <div className={styles.page}>
      <Hero summary={summary} complete={complete} cash={cash} />

      {upcoming && <UpcomingCashPlan plan={upcoming} />}

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
          Income and spending counted as on Cash Flow — transfers, card payments and investing are left out, refunds netted into their category.
        </div>
      </div>

      {pace && <PaceCard pace={pace} />}

      {expectedIncome?.months.length > 0 && (
        <ExpectedIncomeCard data={expectedIncome} typicalSpending={pace?.typicalSpending ?? null} />
      )}

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>Income vs spending, by month</h2>
            <div className={styles.cardHint}>
              Shaded months are the ones where spending overtook income. Each income bar is split into base salary, commission and other income; hover a month for what the other income was, and click one to set its actual figures beside what was projected.
              {projection && <> The month in progress shows its expected income as an outline: what has come in plus the paychecks still due on the Commissions tab’s schedule, base salary and commission apart. Next month is projected the same way.</>}
            </div>
          </div>
          <div className={styles.legend}>
            {BUCKETS.map(b => <span key={b.id}><i style={{ background: b.color }} />{b.label}</span>)}
            {projection && <span><i className={styles.legendProjected} style={{ borderColor: INCOME }} />Expected income</span>}
            <span><i style={{ background: SPENDING }} />Spending</span>
            <span><i className={styles.legendBand} />Over income</span>
            {hasRent && (
              <span className={styles.segment}>
                <button type="button" className={`${styles.segmentBtn} ${noRent ? styles.segmentActive : ''}`} aria-pressed={noRent} onClick={toggleNoRent} data-testid="overshot-subtract-rent"
                  title={noRent ? 'Rent is taken out of spending and income. Click to put it back.' : 'Take each month’s rent out of spending, and the same amount out of income'}>
                  {noRent ? '✓ ' : ''}Subtract rent
                </button>
              </span>
            )}
          </div>
        </div>
        {noRent && <div className={styles.cardHint} style={{ marginBottom: 8 }} data-testid="overshot-rent-note">Rent is subtracted: each month’s rent is taken off spending and the same amount off income (base salary first), so the gap between the bars is unchanged.</div>}
        <MonthlyChart months={shownChart.months} projection={shownChart.projection} buckets={shownChart.buckets} expected={shownChart.expected}
          selected={picked} onSelect={key => setPicked(p => (p === key ? null : key))} />
        {outlook && <MonthDetail outlook={outlook} rentSubtracted={noRent} onClose={() => setPicked(null)} />}
      </section>

      <SurplusSplit months={split} transactions={transactions} />

      <section className={styles.card} data-testid="overshot-surplus">
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>{surplusMode === 'cash' ? 'Cash position' : 'Running surplus'}</h2>
            <div className={styles.cardHint}>
              {surplusMode === 'cash'
                ? 'Cash on hand minus what’s owed on your cards, at the end of each month. Below the line you’re underwater: the cards owe more than your accounts hold.'
                : 'Income minus spending, added up month by month from the start of the range. Below the line, you’ve spent more than you’ve earned over the period.'}
            </div>
          </div>
          <div className={styles.segment} role="group" aria-label="Surplus measure">
            <button type="button" className={`${styles.segmentBtn} ${surplusMode === 'cash' ? styles.segmentActive : ''}`} onClick={() => setSurplusMode('cash')}>Cash on hand</button>
            <button type="button" className={`${styles.segmentBtn} ${surplusMode === 'flow' ? styles.segmentActive : ''}`} onClick={() => setSurplusMode('flow')}>Income − spending</button>
          </div>
        </div>
        {surplusMode === 'cash' ? (
          cash ? (
            <>
              <SurplusChart
                points={cash.months.filter(m => m.net != null).map((m, i, all) => ({
                  key: m.key,
                  value: m.net,
                  label: i === all.length - 1 ? `${long(m.key)} (now)` : `End of ${long(m.key)}`,
                  rows: [['Cash on hand', money(m.cash)], ['Owed on cards', money(m.debt)]],
                }))}
                ariaLabel="Cash position"
                belowText="▼ underwater"
                crossText={{ under: 'went under', back: 'back above' }}
                crossTip={{ under: 'Card balances passed your cash here', back: 'Cash back above card balances here' }}
                valueName="Position"
              />
              <CashAccounts cash={cash} onToggle={toggleAccount} />
            </>
          ) : (
            <div className={styles.muted}>No balance history yet — it comes from the Balance History tab in your sheet.</div>
          )
        ) : (
          <SurplusChart
            points={complete.map(m => ({ key: m.key, value: m.cumulative, label: long(m.key), rows: [['This month', signed(m.net)]] }))}
            startFrom={0}
            ariaLabel="Running surplus"
            belowText="▼ spending ahead of income"
            crossText={{ under: 'overtook', back: 'back ahead' }}
            crossTip={{ under: 'Spending overtook income here', back: 'Back ahead of spending here' }}
            valueName="Running surplus"
          />
        )}
      </section>

      {bridgeMonths.length > 0 && (
        <CashBridgeReport
          transactions={transactions}
          balanceHistory={balanceHistory}
          overrides={cashOverrides}
          monthKeys={bridgeMonths}
          onToggleAccount={toggleAccount}
        />
      )}

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

function Hero({ summary, complete, cash }) {
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
        {cash && (
          <Stat
            value={signed(cash.now.net)}
            label={cash.now.net < 0 ? 'Underwater' : 'Cash surplus'}
            tone={cash.now.net < 0 ? 'bad' : 'good'}
            sub={`${money(cash.now.cash)} cash · ${money(cash.now.debt)} owed on cards · ${dayOf(cash.now.asOf)}`}
            testId="overshot-cash-now"
          />
        )}
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

function Stat({ value, label, sub, tone, testId }) {
  return (
    <div data-testid={testId}>
      <div className={`${styles.heroStatValue} ${tone === 'bad' ? styles.heroBad : tone === 'good' ? styles.heroGood : ''}`}>{value}</div>
      <div className={styles.heroStatLabel}>{label}</div>
      {sub && <div className={styles.heroStatSub}>{sub}</div>}
    </div>
  );
}

/* What's coming in over the next few months, from the Commissions tab: base
   salary twice a month plus each month-end's commission at its take-home
   rate. Paydays already gone count what actually landed. */
function ExpectedIncomeCard({ data, typicalSpending }) {
  const { months, takeHome, base } = data;
  const rate = Math.round((takeHome ?? 0.6) * 100);
  const total = months.reduce((s, m) => s + m.total, 0);
  const leftOver = typicalSpending == null ? null : total - typicalSpending * months.length;
  return (
    <section className={styles.card} data-testid="overshot-expected-income">
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>Expected income</h2>
          <div className={styles.cardHint}>
            From the Commissions tab’s pay schedule: base salary of {money(base.amount)} twice a month, plus each month-end’s commission at {rate}% take-home
            {takeHome == null ? ' (a default, until there’s history to measure)' : ''}. Paychecks already in count what actually landed.
            {' '}<b>{money(total)}</b> over the next {months.length} month{months.length === 1 ? '' : 's'}
            {leftOver != null && <> — {leftOver >= 0 ? `${money(leftOver)} more than` : `${money(-leftOver)} short of`} {months.length} typical month{months.length === 1 ? '' : 's'} of spending ({money(typicalSpending)} a month)</>}.
            {' '}Payroll only: other money in isn’t scheduled.
          </div>
        </div>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table} data-testid="overshot-expected-income-table">
          <thead>
            <tr>
              <th>Month</th>
              <th className={styles.num}>Already in</th>
              <th className={styles.num}>Base still due</th>
              <th className={styles.num}>Commission take-home</th>
              <th className={styles.num}>Expected income</th>
              {typicalSpending != null && <th className={styles.num}>vs typical spending</th>}
            </tr>
          </thead>
          <tbody>
            {months.map(m => (
              <tr key={m.key} data-over={m.leftOver != null && m.leftOver < 0 ? 'true' : 'false'}>
                <td className={styles.nowrap}>
                  {long(m.key)}
                  {m.earnedMonth && m.commissionPreTax > 0 && (
                    <div className={styles.muted}>
                      {monthLabel(m.earnedMonth, { month: 'short' })} commission {money(m.commissionPreTax)} pre-tax{m.projected ? ' · projected' : ''}
                    </div>
                  )}
                </td>
                <td className={styles.num}>{m.received ? money(m.received) : <span className={styles.muted}>—</span>}</td>
                <td className={styles.num}>{m.base ? money(m.base) : <span className={styles.muted}>—</span>}</td>
                <td className={styles.num}>{m.commission ? money(m.commission) : <span className={styles.muted}>—</span>}</td>
                <td className={styles.num}><b>{money(m.total)}</b></td>
                {typicalSpending != null && (
                  <td className={`${styles.num} ${m.leftOver < 0 ? styles.negText : ''}`}>{signed(m.leftOver)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
function MonthlyChart({ months: actualMonths, projection = null, buckets = {}, expected = [], selected = null, onSelect = null }) {
  const [ref, width] = useMeasuredWidth(320);
  const [hover, setHover] = useState(null);
  const H = 280;
  const pad = { top: 28, right: 8, bottom: 26, left: 48 };
  const innerW = width - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const projectedFor = m => (projection && m.partial && projection.key === m.key ? projection : null);
  // What the pay schedule still expects in a month, by bucket.
  const dueFor = key => expected.find(e => e.key === key) || null;
  // Next month, as one more column: nothing has happened in it yet, so it is
  // only its projected income.
  const current = actualMonths.find(m => m.partial);
  const nextRow = projection && current ? dueFor(incomeMonthKey(new Date(Number(current.key.slice(0, 4)), Number(current.key.slice(5)), 1))) : null;
  const months = useMemo(() => (nextRow && nextRow.expected > 0
    ? [...actualMonths, { key: nextRow.key, future: true, income: 0, spending: 0, net: 0, gap: 0, over: false, partial: false }]
    : actualMonths), [actualMonths, nextRow]);
  const max = niceMax(Math.max(...months.map(m => Math.max(m.income, m.spending, projectedFor(m)?.projected || 0, m.future ? nextRow.expected : 0)), 1));
  const step = innerW / months.length;
  const barW = Math.max(3, Math.min(22, (step - 10) / 2));
  const y = v => pad.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  const labelEvery = Math.ceil(months.length / Math.floor(innerW / 52));
  // Rounded at the data end only, flat on the baseline.
  const barPath = (x, v) => {
    const top = y(v);
    const h = pad.top + innerH - top;
    if (h <= 0) return null;
    const r = Math.min(4, barW / 2, h);
    return `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`;
  };
  const bar = (x, v, color, opacity) => {
    const d = barPath(x, v);
    return d && <path d={d} fill={color} opacity={opacity} />;
  };
  // Income still expected: dashed, bucket by bucket, on top of what has landed.
  const DUE = BUCKETS.filter(b => b.id !== 'other');
  const dueStack = (x, from, row, testid) => {
    let acc = from;
    return (
      <g data-testid={testid} data-month={row.key}>
        {DUE.map(b => {
          const v = row[b.id];
          if (!(v > 0)) return null;
          const top = y(acc + v);
          const h = y(acc) - top;
          acc += v;
          return (
            <rect key={b.id} data-bucket={b.id} x={x + 0.75} y={top + 0.75} width={barW - 1.5} height={Math.max(0, h - 1.5)} rx={Math.min(3, barW / 2)}
              fill={b.color} fillOpacity={0.18} stroke={b.id === 'base' ? b.color : '#5b97de'} strokeWidth={1.5} strokeDasharray="4 3" />
          );
        })}
      </g>
    );
  };
  // The income bar: the same shape, filled bucket by bucket from the baseline.
  const incomeBar = (x, m, opacity) => {
    const d = barPath(x, m.income);
    const parts = buckets[m.key];
    if (!d || !parts) return bar(x, m.income, INCOME, opacity);
    let acc = 0;
    return (
      <g opacity={opacity} data-testid="overshot-income-bar" data-month={m.key}>
        <clipPath id={`income-${m.key}`}><path d={d} /></clipPath>
        <g clipPath={`url(#income-${m.key})`}>
          {BUCKETS.map(b => {
            const v = parts[b.id];
            if (!(v > 0)) return null;
            const top = y(acc + v);
            const h = y(acc) - top;
            acc += v;
            return <rect key={b.id} data-bucket={b.id} x={x} y={top} width={barW} height={h} fill={b.color} />;
          })}
        </g>
      </g>
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
          const proj = projectedFor(m);
          // The month in progress is judged against its expected income.
          const isOver = proj ? proj.over : m.over && !m.partial;
          const gap = proj ? proj.gap : m.gap;
          const projTop = proj && proj.projected > m.income ? y(proj.projected) : null;
          return (
            <g key={m.key}>
              {selected === m.key && (
                <rect data-testid="overshot-selected-month" x={cx - step / 2 + 1} y={pad.top - 2} width={step - 2} height={innerH + 2} rx={3}
                  fill="none" stroke="var(--color-text-secondary)" strokeWidth={1.5} />
              )}
              {isOver && (
                <>
                  <rect x={cx - step / 2 + 1} y={pad.top} width={step - 2} height={innerH} fill={CRITICAL} opacity={proj ? 0.05 : 0.08} rx={3} />
                  <text x={cx} y={pad.top - 8} textAnchor="middle" className={styles.overLabel}>▲ {axis(gap)}{proj ? '*' : ''}</text>
                </>
              )}
              {projTop != null && (dueFor(m.key)
                ? dueStack(cx - barW - 1, m.income, dueFor(m.key), 'overshot-projected-bar')
                : <rect data-testid="overshot-projected-bar" x={cx - barW - 1 + 0.75} y={projTop + 0.75} width={barW - 1.5} height={Math.max(0, pad.top + innerH - projTop - 0.75)}
                  rx={Math.min(3, barW / 2)} fill={INCOME} fillOpacity={0.08} stroke={INCOME} strokeWidth={1.5} strokeDasharray="4 3" />
              )}
              {m.future && dueStack(cx - barW / 2, 0, nextRow, 'overshot-next-month-bar')}
              {incomeBar(cx - barW - 1, m, m.partial ? 0.45 : 1)}
              {bar(cx + 1, m.spending, SPENDING, m.partial ? 0.45 : 1)}
              {i % labelEvery === 0 && (
                <text x={cx} y={H - 8} textAnchor="middle" className={styles.axisText}>
                  {short(m.key)}{m.partial ? '*' : m.future ? '†' : ''}
                </text>
              )}
              <rect
                x={cx - step / 2}
                y={pad.top}
                width={step}
                height={innerH}
                fill="transparent"
                data-testid="overshot-month-hit"
                data-month={m.key}
                role={onSelect ? 'button' : undefined}
                tabIndex={onSelect ? 0 : undefined}
                aria-label={onSelect ? `${long(m.key)}: actual and projected` : undefined}
                aria-pressed={onSelect ? selected === m.key : undefined}
                style={onSelect ? { cursor: 'pointer' } : undefined}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={onSelect ? () => onSelect(m.key) : undefined}
                onKeyDown={onSelect ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(m.key); } } : undefined}
              />
            </g>
          );
        })}
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--color-text-muted)" />
      </svg>
      {hover != null && (() => {
        const m = months[hover];
        const proj = projectedFor(m);
        const left = Math.min(width - 230, Math.max(0, pad.left + step * hover + step / 2 - 115));
        const due = proj || m.future ? dueFor(m.key) : null;
        const dueParts = due && due.expected > 0 && (
          <div className={styles.tooltipParts} data-testid="overshot-due-parts">
            {DUE.filter(b => due[b.id] > 0).map(b => (
              <div key={b.id}><i className={styles.legendProjected} style={{ borderColor: b.color }} />{b.label} <b>{money(due[b.id])}</b></div>
            ))}
          </div>
        );
        if (m.future) return (
          <div className={styles.tooltip} style={{ left, top: 4 }} data-testid="overshot-next-month-tooltip">
            <div className={styles.tooltipTitle}>{long(m.key)} (projected)</div>
            <div><i className={styles.legendProjected} style={{ borderColor: INCOME }} />Expected income <b>{money(due.expected)}</b></div>
            {dueParts}
            {due.rentOut > 0 && <div className={styles.muted}>Rent subtracted (last month’s) <b>{money(due.rentOut)}</b></div>}
            {due.leftOver != null && (
              <>
                <div><i style={{ background: SPENDING, opacity: 0.45 }} />A typical month’s spending <b>{money(Math.max(0, due.expected - due.leftOver))}</b></div>
                <div className={styles.tooltipNet}>{due.leftOver >= 0 ? `${money(due.leftOver)} left over if spending is typical` : `Short by ${money(-due.leftOver)} if spending is typical`}</div>
              </>
            )}
          </div>
        );
        return (
          <div className={styles.tooltip} style={{ left, top: 4 }}>
            <div className={styles.tooltipTitle}>{long(m.key)}{m.partial ? ' (so far)' : ''}</div>
            <div><i style={{ background: INCOME }} />Income <b>{money(m.income)}</b></div>
            {buckets[m.key] && m.income > 0 && (
              <div className={styles.tooltipParts} data-testid="overshot-income-parts">
                {BUCKETS.filter(b => buckets[m.key][b.id] > 0).map(b => (
                  <div key={b.id}><i style={{ background: b.color }} />{b.label} <b>{money(buckets[m.key][b.id])}</b></div>
                ))}
                {buckets[m.key].otherBy.slice(0, 4).map(o => (
                  <div key={o.category} className={styles.tooltipSub}>{o.category} <b>{money(o.amount)}</b></div>
                ))}
                {buckets[m.key].otherBy.length > 4 && (
                  <div className={styles.tooltipSub}>{buckets[m.key].otherBy.length - 4} more <b>{money(buckets[m.key].otherBy.slice(4).reduce((s2, o) => s2 + o.amount, 0))}</b></div>
                )}
              </div>
            )}
            {proj && (
              <div><i className={styles.legendProjected} style={{ borderColor: INCOME }} />Expected income <b>{money(proj.projected)}</b></div>
            )}
            {proj && proj.stillDue > 0 && <div className={styles.muted}>{money(proj.stillDue)} in paychecks still due</div>}
            {proj && dueParts}
            <div><i style={{ background: SPENDING }} />Spending <b>{money(m.spending)}</b></div>
            {m.rentOut > 0 && <div className={styles.muted} data-testid="overshot-rent-out">Rent subtracted from both <b>{money(m.rentOut)}</b></div>}
            <div className={styles.tooltipNet}>
              {proj
                ? (proj.over ? `Over expected income by ${money(proj.gap)}` : `${money(proj.projected - m.spending)} of expected income left`)
                : m.partial
                ? (m.over ? `Spending ahead by ${money(m.gap)} so far` : `${money(m.net)} ahead so far`)
                : m.over ? `Over by ${money(m.gap)}` : `${money(m.net)} left over`}
            </div>
          </div>
        );
      })()}
      {months.some(m => m.partial) && (
        <div className={styles.chartFoot}>
          * month in progress{projection ? ' — judged against its expected income (dashed outline)' : ''}
          {months.some(m => m.future) && <> · † next month — payroll expected on the pay schedule; other income isn’t projected</>}
        </div>
      )}
    </div>
  );
}

/* One month opened up: actual beside projected, income on the left and
   spending on the right, on one scale. Category rows are optional and the
   choice sticks. What "projected" means for the month is said in the hint
   (lib/monthOutlook). */
function MonthDetail({ outlook, rentSubtracted, onClose }) {
  const [cats, setCats] = useState(() => { try { return localStorage.getItem(DETAIL_CATS_PREF_KEY) === '1'; } catch { return false; } });
  const toggleCats = () => setCats(v => {
    try { localStorage.setItem(DETAIL_CATS_PREF_KEY, v ? '0' : '1'); } catch { /* storage unavailable */ }
    return !v;
  });
  const { status, income, spending, net, basis } = outlook;
  const actualLabel = status === 'current' ? 'So far' : 'Actual';
  const projectedLabel = status === 'past' ? 'Expected going in' : status === 'current' ? 'Projected for the month' : 'Projected';
  const max = Math.max(income.actual, income.projected || 0, spending.actual, spending.projected || 0, 1);
  const typicalNote = basis.length ? `the average of ${basis.map(short).join(', ')}` : 'no earlier months to average';
  const hint = status === 'current'
    ? 'Projected income is what has come in plus the paychecks still due on the pay schedule, and other income (rent received, say) at its usual amount if it hasn’t arrived. Projected spending is what’s spent plus each category’s usual charges from today to month-end.'
    : status === 'next'
      ? `Nothing has happened yet. Income is the pay schedule plus other income at its usual amount; spending is a typical month, ${typicalNote}.`
      : `Expected going in: the pay the schedule planned for the month, other income at its usual amount, and a typical month’s spending at the time (${typicalNote}).`;
  const sides = [
    { id: 'income', label: 'Income', color: INCOME, data: income, good: 1 },
    { id: 'spending', label: 'Spending', color: SPENDING, data: spending, good: -1 },
  ];
  return (
    <div className={styles.detail} data-testid="overshot-month-detail" data-month={outlook.key}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={styles.cardTitle}>{long(outlook.key)}: actual and projected</h3>
          <div className={styles.cardHint}>{hint}{rentSubtracted && ' Rent is not subtracted here.'}</div>
        </div>
        <div className={styles.detailActions}>
          <span className={styles.segment}>
            <button type="button" className={`${styles.segmentBtn} ${cats ? styles.segmentActive : ''}`} aria-pressed={cats} onClick={toggleCats} data-testid="overshot-detail-categories">
              {cats ? '✓ ' : ''}By category
            </button>
          </span>
          <button type="button" className={styles.detailClose} onClick={onClose} aria-label="Close month detail" data-testid="overshot-detail-close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      </div>
      <div className={styles.detailGrid}>
        {sides.map(side => {
          const d = side.data;
          const diff = d.projected == null || status === 'next' ? null : d.actual - d.projected;
          return (
            <div key={side.id} data-testid={`overshot-detail-${side.id}`}>
              <div className={styles.detailSideTitle}>{side.label}</div>
              <div className={styles.detailBars}>
                {status !== 'next' && (
                  <>
                    <span>{actualLabel}</span>
                    <div className={styles.detailTrack}><div style={{ width: `${(d.actual / max) * 100}%`, background: side.color }} /></div>
                    <b data-testid={`overshot-detail-${side.id}-actual`}>{money(d.actual)}</b>
                  </>
                )}
                <span>{projectedLabel}</span>
                <div className={styles.detailTrack}>
                  {d.projected != null && <div className={styles.detailProjected} style={{ width: `${(d.projected / max) * 100}%`, borderColor: side.color, background: `color-mix(in srgb, ${side.color} 18%, transparent)` }} />}
                </div>
                <b data-testid={`overshot-detail-${side.id}-projected`}>{d.projected == null ? '—' : money(d.projected)}</b>
              </div>
              {diff != null && Math.abs(diff) >= 0.5 && (
                <div className={styles.muted}>
                  {status === 'current'
                    ? `${money(Math.max(0, -diff))} still to come`
                    : `${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than expected`}
                </div>
              )}
              {d.projected == null && (
                <div className={styles.muted}>{side.id === 'income' ? 'No pay schedule on record for this month.' : 'No earlier months to project from.'}</div>
              )}
              {cats && d.rows.length > 0 && (
                <div className={styles.tableWrap} style={{ marginTop: 10 }}>
                  <table className={styles.table} data-testid={`overshot-detail-${side.id}-rows`}>
                    <thead>
                      <tr><th>Category</th>{status !== 'next' && <th className={styles.num}>{actualLabel}</th>}<th className={styles.num}>Projected</th>{status === 'past' && <th className={styles.num}>Difference</th>}</tr>
                    </thead>
                    <tbody>
                      {d.rows.map(r => {
                        const gap = r.projected == null ? null : r.actual - r.projected;
                        return (
                          <tr key={r.name}>
                            <td>{r.name}</td>
                            {status !== 'next' && <td className={styles.num}>{money(r.actual)}</td>}
                            <td className={styles.num}>{r.projected == null ? '—' : money(r.projected)}</td>
                            {status === 'past' && <td className={`${styles.num} ${gap != null && gap * side.good < -0.5 ? styles.negText : ''}`}>{gap == null || Math.abs(gap) < 0.5 ? '—' : signed(gap)}</td>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className={styles.detailNet} data-testid="overshot-detail-net">
        {status !== 'next' && <span>{status === 'current' ? 'Net so far' : 'Net'} <b className={net.actual < 0 ? styles.negText : ''}>{signed(net.actual)}</b></span>}
        <span>{status === 'past' ? 'Expected net' : 'Projected net'} <b className={net.projected < 0 ? styles.negText : ''}>{net.projected == null ? '—' : signed(net.projected)}</b></span>
      </div>
    </div>
  );
}

/* A running position over time, with zero as the line that matters: the
   cash position (cash − cards) or the running income − spending total.
   `startFrom` is the value before the first point, for spotting a crossing
   right at the start; leave it out when the first point has no "before". */
function SurplusChart({ points, startFrom = null, ariaLabel, belowText, crossText, crossTip, valueName }) {
  const [ref, width] = useMeasuredWidth(320);
  const [hover, setHover] = useState(null);
  if (points.length < 2) return <div className={styles.muted}>Needs at least two months.</div>;
  const H = 220;
  const pad = { top: 16, right: 12, bottom: 26, left: 56 };
  const innerW = width - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const vals = points.map(p => p.value);
  const hi = Math.max(0, ...vals);
  const lo = Math.min(0, ...vals);
  // Ticks on a round step that covers both the high and the low, with zero
  // always on a gridline.
  const stepV = niceMax(Math.max(hi - lo, 1) / 4);
  const top = Math.ceil(hi / stepV) * stepV;
  const bottom = Math.floor(lo / stepV) * stepV;
  const x = i => pad.left + (i / (points.length - 1)) * innerW;
  const y = v => pad.top + ((top - v) / (top - bottom)) * innerH;
  const pts = points.map((p, i) => [x(i), y(p.value)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
  const zero = y(0);
  const area = `${line} L${pts[pts.length - 1][0]},${zero} L${pts[0][0]},${zero} Z`;
  const ticks = [];
  for (let v = top; v >= bottom - stepV / 2; v -= stepV) ticks.push(v);
  const labelEvery = Math.ceil(points.length / Math.floor(innerW / 52));
  // Where the position changed sign.
  const cross = new Map();
  let prev = startFrom;
  for (const p of points) {
    if (prev != null && prev >= 0 && p.value < 0) cross.set(p.key, 'under');
    if (prev != null && prev < 0 && p.value >= 0) cross.set(p.key, 'back');
    prev = p.value;
  }
  // Two of these can share the page, so their clip paths need their own ids.
  const clipId = `ov-${ariaLabel.replace(/\W+/g, '-').toLowerCase()}`;
  const onMove = e => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - box.left - pad.left) / innerW) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  return (
    <div ref={ref} className={styles.chartWrap}>
      <svg width={width} height={H} role="img" aria-label={ariaLabel} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <clipPath id={`${clipId}-below`}><rect x={0} y={zero} width={width} height={H} /></clipPath>
          <clipPath id={`${clipId}-above`}><rect x={0} y={0} width={width} height={zero} /></clipPath>
        </defs>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--color-surface-alt)" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className={styles.axisText}>{axis(t)}</text>
          </g>
        ))}
        <path d={area} fill={CRITICAL} opacity={0.14} clipPath={`url(#${clipId}-below)`} />
        <path d={area} fill={INCOME} opacity={0.1} clipPath={`url(#${clipId}-above)`} />
        <line x1={pad.left} x2={width - pad.right} y1={zero} y2={zero} stroke="var(--color-text-secondary)" strokeWidth={1} />
        {lo < 0 && (() => {
          // Under the line where it dips lowest, so the label sits on the dip it names.
          const lx = x(vals.indexOf(lo));
          const anchor = lx > width - 170 ? 'end' : lx < pad.left + 90 ? 'start' : 'middle';
          return (
            <text x={lx} y={Math.min(H - pad.bottom - 4, Math.max(zero + 14, y(lo) + 16))} textAnchor={anchor} className={styles.belowLabel}>
              {belowText}
            </text>
          );
        })()}
        <path d={line} fill="none" stroke="var(--color-text-primary)" strokeWidth={2} strokeLinejoin="round" />
        {points.map((p, i) => cross.has(p.key) && (
          <g key={p.key}>
            <circle cx={x(i)} cy={y(p.value)} r={5} fill={cross.get(p.key) === 'under' ? CRITICAL : INCOME} stroke="var(--color-surface)" strokeWidth={2} />
            <text
              x={Math.min(width - pad.right - 4, Math.max(pad.left + 4, x(i)))}
              y={cross.get(p.key) === 'under' ? y(p.value) + 18 : y(p.value) - 10}
              textAnchor={x(i) > width - 90 ? 'end' : x(i) < pad.left + 60 ? 'start' : 'middle'}
              className={styles.crossLabel}
            >
              {crossText[cross.get(p.key)]}
            </text>
          </g>
        ))}
        {points.map((p, i) => i % labelEvery === 0 && (
          <text
            key={p.key}
            x={x(i)}
            y={H - 8}
            textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
            className={styles.axisText}
          >
            {short(p.key)}
          </text>
        ))}
        {hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="var(--color-text-muted)" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(points[hover].value)} r={4} fill="var(--color-text-primary)" stroke="var(--color-surface)" strokeWidth={2} />
          </>
        )}
      </svg>
      {hover != null && (() => {
        const p = points[hover];
        const c = cross.get(p.key);
        const left = Math.min(width - 220, Math.max(0, x(hover) - 110));
        return (
          <div className={styles.tooltip} style={{ left, top: 4 }}>
            <div className={styles.tooltipTitle}>{p.label}</div>
            <div>{valueName} <b>{signed(p.value)}</b></div>
            {p.rows.map(([k, v]) => <div key={k}>{k} <b>{v}</b></div>)}
            {c && <div className={styles.tooltipNet}>{crossTip[c]}</div>}
          </div>
        );
      })()}
    </div>
  );
}

/* Which accounts make up the cash position, each switchable. */
function CashAccounts({ cash, onToggle }) {
  const kindLabel = { cash: 'Cash', debt: 'Card', other: 'Investment' };
  // A stale date from another year needs its year: "Oct 2" alone reads as last week.
  const when = d => (d.getFullYear() === cash.now.asOf.getFullYear() ? dayOf(d) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
  // Old zero-balance investment accounts are noise; anything switched on,
  // and every cash account and card, always shows.
  const shown = cash.accounts.filter(a => a.kind !== 'other' || a.included || (!a.stale && Math.abs(a.lastBalance) > 0));
  return (
    <details className={styles.accounts} data-testid="overshot-cash-accounts">
      <summary>
        Accounts counted: {money(cash.now.cash)} cash − {money(cash.now.debt)} owed = <b>{signed(cash.now.net)}</b>
        <span className={styles.muted}> · from Balance History, as of {dayOf(cash.now.asOf)}</span>
      </summary>
      <ul>
        {shown.map(a => (
          <li key={a.key} className={a.included ? '' : styles.accountOff}>
            <label>
              <input type="checkbox" checked={a.included} onChange={e => onToggle(a.key, e.target.checked)} />
              <span className={styles.accountKind}>{kindLabel[a.kind]}</span>
              <span className={styles.accountName}>{a.name}{a.last4 && !a.name.includes(a.last4) ? ` …${a.last4}` : ''}</span>
            </label>
            <span className={styles.accountBal}>
              {a.stale
                ? <span className={styles.muted} title={`Last updated ${when(a.latestDate)}: counted as $0 since, as the account looks closed or disconnected`}>no update since {when(a.latestDate)}</span>
                : <>{a.kind === 'debt' && a.latest ? '−' : ''}{money(Math.abs(a.latest))}</>}
            </span>
          </li>
        ))}
      </ul>
      <div className={styles.muted}>
        Checking, savings and money-market accounts count as cash, and cards as owed. Investments and retirement don’t, unless you switch them on. Your choices are remembered in this browser.
      </div>
    </details>
  );
}
