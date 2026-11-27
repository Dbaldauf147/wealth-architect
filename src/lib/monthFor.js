/* "Which month is this for?" — the question the phone asks about every rent
   payment and every piece of income.

   Rent paid on the 30th is usually next month's, and a paycheck on the 1st is
   often last month's, so the date a bank posts them is the wrong month to
   report them in often enough to ask. The answer is stored as an ordinary date
   override (DataContext dateOverrides, applied by categorize.applyOverrides),
   which is what every chart, the Cash Flow page and the weekly email already
   read — so nothing downstream needs to know the question exists.

   An answer is recorded even when it is "the month it posted in": the override
   then simply repeats the transaction's own date. That is how a transaction is
   known to have been asked about — applyOverrides stamps `originalDate` on
   anything with an override — without a second synced map.

   Pure: no React, no DOM. */

import { cashFlowMonthKey, isRentIncome } from './cashflowExport.js';
import { incomeCategorySet, isInvestmentIncome } from './income.js';
import { txnFallbackKey } from './categorize.js';

// Asked only of transactions dated from here on: everything older has already
// been reported, and a first launch shouldn't open on years of paychecks.
export const MONTH_FOR_SINCE = '2026-11-01';

const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/** A transaction date as a local Date (a bare ISO date is not read as UTC). */
export function parseTxnDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d, 12);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function shiftMonthKey(key, n) {
  const [y, m] = key.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}

/**
 * Whether a transaction is one the month question is asked about. Dividends
 * and interest never are: they belong to the month they post in.
 * @returns 'rent' (rent paid or received), 'income', or null
 */
export function monthForKind(t, incomeCategories) {
  if (!t || !t.date) return null;
  const cat = String(t.category || '').trim().toLowerCase();
  const sub = String(t.subcategory || '').trim().toLowerCase();
  if (cat === 'rent' || sub === 'rent') return 'rent';
  if (!(Number(t.amount) > 0)) return null;
  if (!incomeCategorySet(incomeCategories).has(cat)) return null;
  // Dividends and interest are earned when they post; there's no month to pick.
  if (isInvestmentIncome(t)) return null;
  return isRentIncome(t) ? 'rent' : 'income';
}

/** The key a date override for this transaction is stored under. */
export function monthForKey(t) {
  return t.transactionId || txnFallbackKey(t.originalDate ? { ...t, date: t.originalDate } : t);
}

/** Rent and income from MONTH_FOR_SINCE on that nobody has picked a month for, oldest first. */
export function pendingMonthChoices(transactions, incomeCategories, since = MONTH_FOR_SINCE) {
  const from = parseTxnDate(since);
  const out = [];
  for (const t of transactions || []) {
    if (t.originalDate != null) continue; // already answered (or re-dated by hand)
    const kind = monthForKind(t, incomeCategories);
    if (!kind) continue;
    const d = parseTxnDate(t.date);
    if (!d || d < from) continue;
    out.push({ txn: t, kind, date: d });
  }
  return out.sort((a, b) => a.date - b.date);
}

/**
 * The months offered for a transaction: the one before it posted, the one it
 * posted in, and the one after.
 * @returns [{ key, own (the month it posted in), counted (the month reports use today) }]
 */
export function monthOptions(t) {
  const d = parseTxnDate(t.date);
  if (!d) return [];
  const own = keyOf(d);
  const counted = cashFlowMonthKey(t) || own;
  return [-1, 0, 1].map(n => shiftMonthKey(own, n)).map(key => ({ key, own: key === own, counted: key === counted }));
}

/**
 * The date to store so the transaction reports in `key`.
 *
 * Its own date when that already reports there. Otherwise the 1st of the
 * chosen month: the one day Cash Flow's nearest-1st snapping for rent revenue
 * never moves again. Written M/D/YYYY, as the sheet writes dates — a bare ISO
 * date on the 1st parses as UTC and reads as the month before in US time zones.
 */
export function dateForMonth(t, key) {
  const d = parseTxnDate(t.date);
  if (d && keyOf(d) === key && cashFlowMonthKey(t) === key) return t.date;
  const [y, m] = key.split('-').map(Number);
  return `${m}/1/${y}`;
}
