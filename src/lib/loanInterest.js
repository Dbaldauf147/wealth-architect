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

/**
 * Reconcile this device's copy of the loan with the synced one, at load.
 *
 * Taking either copy whole is how tags went missing: a browser holding an
 * older loan won the merge, then wrote it back over the cloud copy — erasing
 * every charge tagged on another device since. Instead:
 *
 *   - Each edit stamps the loan with `updatedAt`. When both copies carry one,
 *     the newer copy's terms win, and when the cloud copy is the newer one it
 *     wins outright, so a payment deleted on another device stays deleted.
 *   - Otherwise (older loans that predate the stamp, or this device holding
 *     edits the cloud hasn't seen) payments and ignored charges are unioned:
 *     nothing tagged anywhere is lost. A payment is the same one on both sides
 *     when it shares an id, or a tagged transaction.
 *
 * Either side may be null; null and null is null.
 */
export function mergeLoan(local, remote) {
  if (!local) return remote || null;
  if (!remote) return local;
  const lt = Date.parse(local.updatedAt || '') || 0;
  const rt = Date.parse(remote.updatedAt || '') || 0;
  if (rt && rt >= lt) return remote;

  const newer = lt > rt ? local : remote;
  const older = newer === local ? remote : local;
  const payments = [...(newer.payments || [])];
  const ids = new Set(payments.map(p => p.id).filter(Boolean));
  const txns = new Set(payments.map(p => p.transactionId).filter(Boolean));
  for (const p of older.payments || []) {
    if ((p.id && ids.has(p.id)) || (p.transactionId && txns.has(p.transactionId))) continue;
    payments.push(p);
    if (p.id) ids.add(p.id);
    if (p.transactionId) txns.add(p.transactionId);
  }
  // A charge tagged on either side isn't ignored, whatever the other side says.
  const ignored = [...new Set([...(newer.ignoredTransactionIds || []), ...(older.ignoredTransactionIds || [])])]
    .filter(id => !txns.has(id));
  const out = { ...older, ...newer, payments };
  if (ignored.length || newer.ignoredTransactionIds || older.ignoredTransactionIds) out.ignoredTransactionIds = ignored;
  return out;
}
