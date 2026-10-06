/* Interest charges from the ledger, and tagging them to the short-term loan.
   Pure functions — no React — so the page stays presentational and this is
   testable on its own.

   A charge tagged to the loan becomes a payment in its log carrying the
   charge's `transactionId`, so deleting that payment puts the charge back in
   the queue. A charge that isn't the loan's (card interest, margin interest)
   is ignored by id on the loan, so it stops being offered. Both live on the
   loan object, which already syncs across devices as one unit. */

/** Stable key for a transaction: its sheet ID, or the same fallback the rest
 *  of the app uses when a row has none. */
export function txnKey(t) {
  return t.transactionId || `${t.date}|${t.description}|${t.amount}`;
}

/** Money out, categorized as interest (category or subcategory). Interest
 *  *earned* is money in, so the sign alone keeps it out. */
export function isInterestCharge(t) {
  if (!t || !((Number(t.amount) || 0) < 0)) return false;
  return /interest/i.test(t.category || '') || /interest/i.test(t.subcategory || '');
}

/** 'YYYY-MM-DD' for a sheet date ('9/20/2026', '2026-09-20', …), in local
 *  time so a date never slides a day west of UTC. '' if unparseable. */
export function toISODate(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The loan payment a tagged charge becomes. */
export function paymentFromTransaction(t) {
  return {
    date: toISODate(t.date),
    amount: Math.abs(Number(t.amount) || 0),
    note: t.description || '',
    transactionId: txnKey(t),
  };
}

/**
 * Interest charges still waiting for a decision, newest first.
 *
 * @param transactions   categorized transactions
 * @param loan           the shortTermLoan object (payments, ignoredTransactionIds, startDate)
 * @param includeEarlier also offer charges dated before the loan started
 * @returns { pending, ignored, earlierCount }
 *   pending      charges neither tagged nor ignored (inside the date window)
 *   ignored      charges the user ignored, so they can be restored
 *   earlierCount pending charges hidden because they predate the loan
 */
export function loanInterestQueue({ transactions, loan, includeEarlier = false }) {
  const linked = new Set((loan?.payments || []).map(p => p.transactionId).filter(Boolean));
  const ignoredIds = new Set(loan?.ignoredTransactionIds || []);
  const start = loan?.startDate || '';

  const pending = [];
  const ignored = [];
  let earlierCount = 0;
  for (const t of transactions || []) {
    if (!isInterestCharge(t)) continue;
    const key = txnKey(t);
    if (linked.has(key)) continue;
    const row = { ...t, key, iso: toISODate(t.date) };
    if (ignoredIds.has(key)) { ignored.push(row); continue; }
    if (!includeEarlier && start && row.iso && row.iso < start) { earlierCount += 1; continue; }
    pending.push(row);
  }
  const newestFirst = (a, b) => b.iso.localeCompare(a.iso) || String(a.description).localeCompare(String(b.description));
  pending.sort(newestFirst);
  ignored.sort(newestFirst);
  return { pending, ignored, earlierCount };
}
