/* Per-card payment schedule — projects each card's next CC payment date and
   surfaces the charges since the last payment that will roll into it.

   Approximation v1: we don't have statement-close events, only payment events.
   Treats "charges since last payment" as "charges in the next payment." Off by
   a few days for users who don't pay in full, accurate enough for users who do. */

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function isCreditCardPayment(t) {
  const cat = (t.category || '').toLowerCase();
  return cat === 'credit card payment' || cat === 'credit card payments';
}

/** Build per-card schedule entries.
 *
 *  cards: [{ name, color? }]
 *  transactions: full transaction list (the same shape produced by sheets.js)
 *  asOf: defaults to now
 *
 *  Returns one entry per card with the next projected payment, the charges
 *  feeding into it, and supporting metadata for the UI. */
export function buildCardSchedule({ cards, transactions, asOf = new Date() }) {
  const txByCard = new Map();
  for (const t of transactions || []) {
    const acct = (t.account || '').trim();
    if (!acct) continue;
    if (!txByCard.has(acct)) txByCard.set(acct, []);
    txByCard.get(acct).push(t);
  }

  return (cards || []).map((card) => {
    const txs = txByCard.get(card.name) || [];

    // Payment events for this card: positive-amount CC-payment transactions on
    // the card account (the inflow leg of the transfer that pays the card down).
    const payments = txs
      .filter(t => isCreditCardPayment(t) && t.amount > 0)
      .map(t => ({ date: parseDate(t.date), amount: t.amount }))
      .filter(p => p.date)
      .sort((a, b) => a.date - b.date);

    const lastPayment = payments.length ? payments[payments.length - 1] : null;

    // Cadence in days — average gap between historical payments, default 30.
    let cadenceDays = 30;
    if (payments.length >= 2) {
      const totalDays = (payments[payments.length - 1].date - payments[0].date) / 86400000;
      cadenceDays = Math.max(1, Math.round(totalDays / (payments.length - 1)));
    }

    // Roll the projected next payment forward until it's on or after `asOf`.
    let nextPaymentDate = null;
    if (lastPayment) {
      const intervalMs = cadenceDays * 86400000;
      nextPaymentDate = new Date(lastPayment.date.getTime() + intervalMs);
      while (nextPaymentDate < asOf) {
        nextPaymentDate = new Date(nextPaymentDate.getTime() + intervalMs);
      }
    }

    const daysUntilNext = nextPaymentDate
      ? Math.max(0, Math.round((nextPaymentDate - asOf) / 86400000))
      : null;

    // Charges (and refunds) on the card since the last payment, newest first.
    // Excludes the CC-payment transactions themselves.
    const sinceDate = lastPayment ? lastPayment.date : null;
    const chargesSinceLast = txs
      .filter(t => {
        if (isCreditCardPayment(t)) return false;
        const d = parseDate(t.date);
        if (!d) return false;
        if (sinceDate && d <= sinceDate) return false;
        if (d > asOf) return false;
        return true;
      })
      .map(t => ({ ...t, _date: parseDate(t.date) }))
      .sort((a, b) => b._date - a._date);

    // Sum the charges. Charges are negative; refunds are positive. Flipping the
    // sign gives the net amount that'll be owed on the next payment.
    const estimatedNextAmount = chargesSinceLast.reduce((s, t) => s + -t.amount, 0);

    return {
      card: card.name,
      color: card.color || null,
      payments,
      lastPayment,
      cadenceDays,
      nextPaymentDate,
      daysUntilNext,
      chargesSinceLast,
      estimatedNextAmount,
    };
  });
}
