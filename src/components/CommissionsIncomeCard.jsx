import { useMemo } from 'react';
import { useCommissions } from '../hooks/useCommissions';
import { paychecksIn, monthLabel } from '../lib/commissions';
import { businessDayOnOrBefore } from '../lib/upcomingCash';
import styles from '../pages/IncomePage.module.css';

/* Income page: commission from the Prospect Tracker, by the paycheck it
   arrives in. A month's commission (pre-tax) is paid in the next month's
   month-end paycheck, so each row sets it beside that deposit and how much it
   came in above the mid-month one — the taxed share of the commission, roughly.
   It is not added to income: the deposit already counts. */

const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const dayY = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const SHOWN = 12;

export function CommissionsIncomeCard({ transactions }) {
  const { loading, error, updatedAt, payouts } = useCommissions();

  const rows = useMemo(() => payouts.slice(-SHOWN).reverse().map(p => {
    const { midMonth, monthEnd } = paychecksIn(transactions, p.payMonth);
    const [y, m] = p.payMonth.split('-').map(Number);
    return {
      ...p,
      due: businessDayOnOrBefore(new Date(y, m, 0)),
      deposit: monthEnd,
      extra: monthEnd && midMonth ? monthEnd.amount - midMonth.amount : null,
    };
  }), [payouts, transactions]);

  // Nothing to say until there's a table (or a reason there isn't one).
  if (!rows.length && (!error || loading)) return null;

  const today = new Date(new Date().toDateString());
  const upcoming = rows.filter(r => r.due >= today).sort((a, b) => a.due - b.due)[0] || null;

  return (
    <section className={styles.card} data-testid="income-commissions">
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>Commissions</h2>
          <div className={styles.cardHint}>
            From the Prospect Tracker{updatedAt ? `, updated ${dayY(new Date(updatedAt))}` : ''}.
            {' '}Each month’s commission is paid, pre-tax, in the next month-end paycheck — already counted in income above.
            {upcoming && <> Next: <b>{money(upcoming.amount)}</b> for {monthLabel(upcoming.earnedMonth, { month: 'long' })}, in the {dayY(upcoming.due)} paycheck.</>}
          </div>
        </div>
      </div>
      {error && <div className={styles.muted} role="alert">Couldn’t read the tracker: {error}{rows.length ? ' — showing the last copy.' : ''}</div>}
      {rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Paycheck</th>
                <th>For</th>
                <th className={styles.num}>Commission (pre-tax)</th>
                <th className={styles.num}>Month-end deposit</th>
                <th className={styles.num}>Above mid-month</th>
                <th>Biggest</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.earnedMonth}>
                  <td className={styles.nowrap}>{dayY(r.due)}{r.due >= today && <span className={styles.muted}> · expected</span>}</td>
                  <td className={styles.nowrap}>{monthLabel(r.earnedMonth, { month: 'short', year: 'numeric' })}</td>
                  <td className={styles.num}>{money(r.amount)}</td>
                  <td className={styles.num}>{r.deposit ? money(r.deposit.amount) : <span className={styles.muted}>—</span>}</td>
                  <td className={styles.num}>{r.extra != null ? money(r.extra) : <span className={styles.muted}>—</span>}</td>
                  <td className={styles.muted}>
                    {r.rows.slice(0, 2).map(x => `${x.account || x.project} ${money(x.amount)}`).join(' · ')}
                    {r.rows.length > 2 ? ` +${r.rows.length - 2} more` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* Income page: commission still to come, by the paycheck it should arrive in.
   What the tracker records for a month not yet paid, plus each live contract
   carried forward at its last month's amount to its Comm End
   (lib/commissions expectedPayouts). Take-home is the pre-tax figure at the
   rate past month-end paychecks actually carried. */
export function ExpectedCommissionsCard({ upcoming, takeHome }) {
  if (!upcoming.length) return null;
  const total = upcoming.reduce((s, p) => s + p.amount, 0);
  const totalTakeHome = upcoming.reduce((s, p) => s + p.takeHome, 0);
  const rate = takeHome == null ? null : Math.round(takeHome * 100);

  return (
    <section className={styles.card} data-testid="income-expected-commissions">
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>Expected commission payments</h2>
          <div className={styles.cardHint}>
            <b>{money(total)}</b> pre-tax still owed across {upcoming.length} paycheck{upcoming.length === 1 ? '' : 's'}, about <b>{money(totalTakeHome)}</b> after tax.
            {' '}Months the tracker hasn’t filled in yet are projected: each live contract at its latest month’s amount, through its Comm End date.
            {' '}Take-home uses {rate != null ? `${rate}%, what your month-end paychecks carried above base against the tracker over the last year` : 'an assumed 60% until there are paychecks to measure it from'}.
          </div>
        </div>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Paycheck</th>
              <th>For</th>
              <th className={styles.num}>Pre-tax</th>
              <th className={styles.num}>Est. take-home</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {upcoming.map(p => {
              const [y, m] = p.payMonth.split('-').map(Number);
              return (
                <tr key={p.earnedMonth}>
                  <td className={styles.nowrap}>{dayY(businessDayOnOrBefore(new Date(y, m, 0)))}</td>
                  <td className={styles.nowrap}>
                    {monthLabel(p.earnedMonth, { month: 'short', year: 'numeric' })}
                    <span className={styles.muted}> · {p.rows.every(r => r.projected) ? 'projected' : p.projected ? 'partly projected' : 'in the tracker'}</span>
                  </td>
                  <td className={styles.num}>{money(p.amount)}</td>
                  <td className={styles.num}>{money(p.takeHome)}</td>
                  <td className={styles.muted}>
                    {p.rows.slice(0, 3).map(x => `${x.account || x.project} ${money(x.amount)}`).join(' · ')}
                    {p.rows.length > 3 ? ` +${p.rows.length - 3} more` : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
