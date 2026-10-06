/* Which card statement each transaction landed on.

   A card statement closes on the same day every month, and a charge belongs
   to the first close on or after its date. So all this needs per card is the
   closing day — which the ledger doesn't carry and has to come from somewhere:

     1. the user, who sets it from the Statement column (statementCloseDays), or
     2. an estimate from the payments: for each candidate day 1–31, how many
        payments equal, to within a couple of dollars, the charges in the
        cycle they'd have paid. The day that explains the most payments wins.

   Exact run-matching (paymentReconcile.js) was tried first and fails on real
   ledgers: one double payment or a 33¢ fee that never reached the sheet breaks
   the chain for every statement after it. A fixed closing day doesn't chain,
   so one bad month stays one bad month.

   Pure: no React, no DOM. "Now" arrives as an argument. */
import { paymentsOf, chargesOf } from './paymentReconcile.js';
import { closeOnOrAfter, closePaidBy, previousClose, startOfDay } from './closeDates.js';

export { closeOnOrAfter, closePaidBy };

/** Same key the rest of the app uses for a transaction. */
export function txnKey(t) {
  return t.transactionId || `${t.date}|${t.description}|${t.amount}`;
}

// A payment this long after a close no longer counts as paying it.
const MAX_CLOSE_TO_PAY_DAYS = 45;

const dayKey = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/**
 * Estimate a card's closing day from its payments.
 * @returns { day, hits, tested } for the best day, or null when no day
 *   explains at least two payments and a quarter of those tested — at that
 *   point a guess would be presented as a fact.
 */
export function estimateCloseDay(payments, charges) {
  if (!payments.length || !charges.length) return null;
  const first = startOfDay(charges[0]._date);
  // 31 days × every payment × every charge is too slow on a real ledger, so
  // the cycle sums come off a running total. `charges` is sorted by date.
  const owedBefore = [0];
  for (const c of charges) owedBefore.push(owedBefore[owedBefore.length - 1] - c.amount);
  const countBefore = (date) => { // charges dated strictly before `date`
    let lo = 0;
    let hi = charges.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (charges[mid]._date < date) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  let best = null;
  for (let day = 1; day <= 31; day++) {
    let hits = 0;
    let tested = 0;
    for (const p of payments) {
      const close = closePaidBy(p._date, day);
      const open = previousClose(close, day);
      if (open < first) continue; // cycle starts before the ledger does
      tested += 1;
      // The cycle runs from the day after the previous close through the close.
      const from = countBefore(new Date(open.getFullYear(), open.getMonth(), open.getDate() + 1));
      const to = countBefore(new Date(close.getFullYear(), close.getMonth(), close.getDate() + 1));
      const owed = owedBefore[to] - owedBefore[from];
      if (Math.abs(owed - p.amount) <= Math.max(2, p.amount * 0.005)) hits += 1;
    }
    if (!best || hits > best.hits) best = { day, hits, tested };
  }
  if (!best || best.hits < 2 || best.hits < best.tested / 4) return null;
  return best;
}

/**
 * A card's closing day: the one the user set, else the estimate from its
 * payments. Pass `transactions` (one card's) or the already-split `payments`
 * and `charges`.
 * @returns { day, source: 'set'|'estimated'|null, hits?, tested? } — day is
 *   null when it's neither set nor estimable.
 */
export function resolveCloseDay({ transactions, payments, charges, setDay }) {
  const set = Math.round(Number(setDay)) || 0;
  if (set >= 1 && set <= 31) return { day: set, source: 'set' };
  const est = estimateCloseDay(payments || paymentsOf(transactions), charges || chargesOf(transactions));
  return est
    ? { day: est.day, source: 'estimated', hits: est.hits, tested: est.tested }
    : { day: null, source: null };
}

/**
 * @param transactions  every transaction (non-card accounts are skipped)
 * @param closeDays     { [account]: day } set by the user; wins over the estimate
 * @param asOf          "now"
 * @returns {
 *   byTxn: Map<txnKey, info>,
 *   cards: Map<account, { day, source: 'set'|'estimated'|null, hits?, tested? }>,
 * }
 * info.kind:
 *   'statement'  closed — closeDate, payDate (null if not paid yet)
 *   'open'       the cycle hasn't closed yet — closeDate is when it will
 *   'payment'    a card payment — closeDate of the statement it paid
 * A card account is one with card payments in it, or one the user gave a
 * closing day. Card accounts with no closing day are listed in `cards` (so
 * the UI can ask for one) but have nothing in `byTxn`.
 */
export function statementLookup(transactions, closeDays = {}, asOf = new Date()) {
  const byAccount = new Map();
  for (const t of transactions || []) {
    const acct = (t.account || '').trim();
    if (!acct) continue;
    if (!byAccount.has(acct)) byAccount.set(acct, []);
    byAccount.get(acct).push(t);
  }

  const today = startOfDay(asOf);
  const byTxn = new Map();
  const cards = new Map();
  for (const [acct, txs] of byAccount) {
    const set = Number(closeDays?.[acct]) || 0;
    const payments = paymentsOf(txs);
    // One stray "credit card payment" into checking doesn't make it a card.
    if (!set && payments.length < 2) continue;
    const charges = chargesOf(txs);

    const card = resolveCloseDay({ payments, charges, setDay: set });
    cards.set(acct, card);
    const { day } = card;
    if (!day) continue;

    // Which payment paid which close.
    const paidOn = new Map();
    for (const p of payments) {
      const close = closePaidBy(p._date, day);
      const gap = (startOfDay(p._date) - close) / 86400000;
      if (gap > MAX_CLOSE_TO_PAY_DAYS) continue;
      const k = dayKey(close);
      if (!paidOn.has(k)) paidOn.set(k, p._date);
      byTxn.set(txnKey(p), { kind: 'payment', closeDate: close, payDate: p._date, day, source: card.source });
    }

    for (const c of charges) {
      const close = closeOnOrAfter(c._date, day);
      byTxn.set(txnKey(c), close >= today
        ? { kind: 'open', closeDate: close, day, source: card.source }
        : { kind: 'statement', closeDate: close, payDate: paidOn.get(dayKey(close)) || null, day, source: card.source });
    }
  }
  return { byTxn, cards };
}

const md = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const mdy = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

/** Cell text for a lookup entry: `{ main, sub, title, sortKey, muted }`, or null. */
export function statementLabel(info) {
  if (!info) return null;
  const how = info.source === 'set'
    ? `Closes on the ${ordinal(info.day)} (set by you).`
    : `Closes on the ${ordinal(info.day)} (estimated from payments).`;
  switch (info.kind) {
    case 'statement':
      return {
        main: `${md(info.closeDate)} stmt`,
        sub: info.payDate ? `paid ${md(info.payDate)}` : 'not paid yet',
        title: `On the statement that closed ${mdy(info.closeDate)}${info.payDate ? `, paid ${mdy(info.payDate)}` : ', not paid yet'}. ${how}`,
        sortKey: info.closeDate.toISOString(),
      };
    case 'open':
      return {
        main: 'Current',
        sub: `closes ${md(info.closeDate)}`,
        title: `On the statement that's still open; it closes ${mdy(info.closeDate)}. ${how}`,
        sortKey: info.closeDate.toISOString(),
        muted: true,
      };
    case 'payment':
      return {
        main: 'Payment',
        sub: `for ${md(info.closeDate)} stmt`,
        title: `Paid the statement that closed ${mdy(info.closeDate)}. ${how}`,
        sortKey: `${info.closeDate.toISOString()}|p`,
        muted: true,
      };
    default:
      return null;
  }
}
