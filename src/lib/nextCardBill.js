/* The "next credit card bill" block at the top of the weekly email: when the
   next card payment is, how much it is, and what the paying checking account
   will hold once it has gone out.

   Payments come from upcomingCardPayments() in paymentReminder.js — the same
   schedule the day-before reminder email and the Overshot page use — so the
   three can't disagree about a date or an amount. The paying account is the
   one the reminder email names (BoA checking …1118 unless changed).

   "Left after" is today's checking balance minus the payment(s). It does not
   add paychecks that may land before the due date; the email says so. */

const round2 = n => Math.round(n * 100) / 100;

// Schedule dates are `new Date(y, m, d)` standing for a calendar day. Read the
// day off the Date's own fields so a server in UTC doesn't shift it.
function calendarKey(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date)) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function todayKey(asOf, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(asOf);
}

function daysBetweenKeys(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/**
 * @param payments      upcomingCardPayments() output, soonest first
 * @param payingAccount findPayingAccount() output: { name, balance, updated } | null
 * @param asOf          now
 * @param tz            the user's zone, for "today"
 * @param horizonDays   later payments within this many days are listed too
 * @returns null when no card payment is projected, else
 *   { dateKey, daysAway, total, cards: [{ name, amount, statementClosed, statementCloseKey }],
 *     checking: { name, balance, updated } | null, leftAfter: number | null,
 *     later: [{ dateKey, name, amount, statementClosed, leftAfter }] }
 */
export function summarizeNextCardBill({ payments, payingAccount, asOf = new Date(), tz = 'America/New_York', horizonDays = 35 }) {
  const today = todayKey(asOf, tz);
  const upcoming = (payments || [])
    .map(p => ({ ...p, dateKey: calendarKey(p.date) }))
    .filter(p => p.dateKey && p.dateKey >= today && p.amount > 0)
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));
  if (!upcoming.length) return null;

  const dateKey = upcoming[0].dateKey;
  const first = upcoming.filter(p => p.dateKey === dateKey);
  const total = round2(first.reduce((s, p) => s + p.amount, 0));
  const balance = payingAccount && Number.isFinite(payingAccount.balance) ? payingAccount.balance : null;

  let running = balance == null ? null : round2(balance - total);
  const later = [];
  for (const p of upcoming) {
    if (p.dateKey === dateKey) continue;
    if (daysBetweenKeys(today, p.dateKey) > horizonDays) break;
    if (running != null) running = round2(running - p.amount);
    later.push({
      dateKey: p.dateKey,
      name: p.displayName || p.card,
      amount: p.amount,
      statementClosed: !!p.statementClosed,
      leftAfter: running,
    });
  }

  return {
    dateKey,
    daysAway: daysBetweenKeys(today, dateKey),
    total,
    cards: first.map(p => ({
      name: p.displayName || p.card,
      amount: p.amount,
      statementClosed: !!p.statementClosed,
      statementCloseKey: calendarKey(p.statementClose),
    })),
    checking: payingAccount ? { name: payingAccount.name, balance, updated: payingAccount.updated || null } : null,
    leftAfter: balance == null ? null : round2(balance - total),
    later,
  };
}
