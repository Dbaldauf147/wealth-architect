import styles from './UpcomingCashPlan.module.css';

/* "Coming up": the next paycheck, the next card payment, and a plan for the
   weeks ahead — every payment and bill, what pays for it, and the cash left
   after. Built by planUpcomingCash (lib/upcomingCash.js). */

const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.abs(n));
const cents = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(n));
const signed = n => (n < -0.5 ? '−' : '') + money(n);
const day = d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const short = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const inDays = (d, today) => {
  const n = Math.round((d - today) / 86400000);
  return n <= 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
};
const ICON = { paycheck: 'payments', card: 'credit_card', bill: 'receipt_long' };

export function UpcomingCashPlan({ plan }) {
  const { events, nextPaycheck, nextCardPayment, firstShort, totals, today } = plan;
  // Before the next paycheck: what's due, and whether cash on hand covers it.
  const beforePay = nextPaycheck ? events.filter(e => e.amount < 0 && e.date < nextPaycheck.date) : [];
  const dueBeforePay = beforePay.reduce((s, e) => s - e.amount, 0);

  return (
    <section className={styles.card} data-testid="upcoming-plan">
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>Coming up</h2>
          <div className={styles.hint}>
            Your next paychecks, card payments and bills paid from cash through {short(plan.until)}, projected from your own history — and what pays for each.
          </div>
        </div>
      </div>

      <div className={styles.tiles}>
        <div className={styles.tile} data-testid="next-paycheck">
          <div className={styles.tileLabel}><span className="material-symbols-outlined">payments</span>Next paycheck</div>
          {nextPaycheck ? (
            <>
              <div className={styles.tileValue}>{cents(nextPaycheck.amount)}</div>
              <div className={styles.tileWhen}>{day(nextPaycheck.date)} · {inDays(nextPaycheck.date, today)}</div>
              <div className={styles.tileNote}>{nextPaycheck.detail}</div>
            </>
          ) : <div className={styles.tileNote}>No regular paycheck found in the last six months.</div>}
        </div>

        <div className={styles.tile} data-testid="next-card-payment">
          <div className={styles.tileLabel}><span className="material-symbols-outlined">credit_card</span>Next card payment</div>
          {nextCardPayment ? (
            <>
              <div className={styles.tileValue}>{cents(nextCardPayment.amount)}</div>
              <div className={styles.tileWhen}>{nextCardPayment.label.replace(/ payment$/, '')} · {day(nextCardPayment.date)} · {inDays(nextCardPayment.date, today)}</div>
              <div className={styles.tileNote}>{nextCardPayment.detail}</div>
            </>
          ) : <div className={styles.tileNote}>No card payment projected in this window.</div>}
        </div>

        <div className={`${styles.tile} ${firstShort ? styles.tileShort : styles.tileOk}`} data-testid="plan-verdict">
          <div className={styles.tileLabel}>
            <span className="material-symbols-outlined">{firstShort ? 'warning' : 'check_circle'}</span>
            {firstShort ? 'Not enough cash in time' : 'Covered'}
          </div>
          {firstShort ? (
            <>
              <div className={styles.tileValue}>{cents(firstShort.shortBy)} short</div>
              <div className={styles.tileWhen}>for {firstShort.label.replace(/ payment$/, '')} on {short(firstShort.date)}</div>
              <div className={styles.tileNote}>
                {nextPaycheck && firstShort.date < nextPaycheck.date
                  ? <>It’s due before your {short(nextPaycheck.date)} paycheck, and you have {money(plan.start)} in cash now.</>
                  : <>The paychecks landing before it don’t cover it on top of what’s due earlier.</>}
              </div>
            </>
          ) : (
            <>
              <div className={styles.tileValue}>{money(totals.end)} left</div>
              <div className={styles.tileWhen}>on {short(plan.until)}, after everything below</div>
              <div className={styles.tileNote}>Every payment lands after enough money has come in to cover it.</div>
            </>
          )}
        </div>
      </div>

      {nextPaycheck && beforePay.length > 0 && (
        <p className={styles.lede}>
          Before your {short(nextPaycheck.date)} paycheck you owe <b>{money(dueBeforePay)}</b>
          {' '}({beforePay.map(e => e.label.replace(/ payment$/, '')).join(', ')}) and have <b>{money(plan.start)}</b> in cash
          {dueBeforePay > plan.start ? <> — <b className={styles.bad}>{money(dueBeforePay - plan.start)} short</b>.</> : '.'}
        </p>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table} data-testid="plan-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>What</th>
              <th className={styles.num}>Amount</th>
              <th>Paid from</th>
              <th className={styles.num}>Cash after</th>
            </tr>
          </thead>
          <tbody>
            <tr className={styles.startRow}>
              <td className={styles.nowrap}>Now</td>
              <td>Cash on hand <span className={styles.muted}>· as of {short(plan.cashAsOf)}</span></td>
              <td className={styles.num} />
              <td />
              <td className={styles.num}>{signed(plan.start)}</td>
            </tr>
            {events.map((e, i) => (
              <tr key={i} className={e.shortBy ? styles.shortRow : e.kind === 'paycheck' ? styles.inRow : ''} data-kind={e.kind}>
                <td className={styles.nowrap}>{day(e.date)}</td>
                <td>
                  <div className={styles.what}><span className="material-symbols-outlined">{ICON[e.kind]}</span>{e.label}</div>
                  <div className={styles.muted}>{e.detail}</div>
                </td>
                <td className={`${styles.num} ${e.amount > 0 ? styles.good : ''}`}>{e.amount > 0 ? '+' : '−'}{cents(e.amount)}{e.kind === 'card' && !e.final ? <span className={styles.muted}> so far</span> : null}</td>
                <td>
                  {e.amount > 0 ? <span className={styles.muted}>—</span> : (
                    <>
                      {e.paidFrom.map((f, j) => <div key={j}>{money(f.amount)} from {f.source}</div>)}
                      {e.shortBy && <div className={styles.bad}><b>{money(e.shortBy)} short</b> — nothing else has come in by then</div>}
                    </>
                  )}
                </td>
                <td className={`${styles.num} ${e.balance < 0 ? styles.bad : ''}`}>{signed(e.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.foot}>
        Each payment is paid from the oldest money available: cash on hand first, then each paycheck as it lands.
        Card amounts are each statement’s charges; a statement still open will grow until it closes. Everyday card spending
        isn’t listed here because it’s paid when its card is.
      </div>
    </section>
  );
}
