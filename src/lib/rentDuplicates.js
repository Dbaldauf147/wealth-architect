// Two rent payments landing in the same month.
//
// Rent arrives monthly, but the *date* it arrives drifts — a tenant who pays
// on the 30th and then on the 3rd has paid twice in one calendar month and not
// at all in the next. The cash-flow page already snaps rent to the month whose
// 1st it lands closest to, which absorbs most of that drift. What it can't
// absorb is two payments that still collide after snapping: those double one
// month's revenue and leave a hole in another, and nothing on the site says so.
//
// This finds them and proposes the fix — move the later one forward a month —
// without making it, because the alternative reading is always possible: two
// tenants, or a tenant catching up on arrears, is genuinely two payments in
// one month and must not be quietly rewritten.

import { isRentIncome, cashFlowMonthKey, prevMonthKey } from './cashflowExport.js';
import { txnFallbackKey } from './categorize.js';

/** 'YYYY-MM' → 'August 2026'. */
export function monthLabel(key) {
  if (!key) return '';
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/** The next month key after 'YYYY-MM'. */
export function nextMonthKey(key) {
  const [y, m] = String(key).split('-').map(Number);
  if (!y || !m) return key;
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * The key a date override is stored under for this transaction.
 *
 * Two things have to line up or a move writes an override nothing reads back.
 * It must be the same shape applyOverrides builds — hence the shared helper
 * rather than a second copy of the format — and for a transaction that already
 * carries an override it must be built from the *original* date, since that is
 * what the raw row still has when the lookup happens.
 */
export function txnKey(t) {
  if (t.transactionId) return t.transactionId;
  return txnFallbackKey(t.originalDate ? { ...t, date: t.originalDate } : t);
}

/**
 * Year, month and day out of whatever the sheet put in the date column.
 *
 * Dates arrive from Google Sheets in no guaranteed format — TransactionsPage
 * carries a toIsoDate() for exactly this reason — so anything reading a date
 * here has to cope with '12/3/2025' as readily as '2025-12-03'.
 *
 * The ISO branch is not merely a fast path: new Date('2025-12-03') is parsed as
 * UTC midnight and reads back as the 2nd anywhere west of Greenwich, which
 * would land a moved payment on the wrong day.
 */
function dateParts(input) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(input || ''));
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

/**
 * A date as a sortable number.
 *
 * Comparing the raw strings looks like it works and doesn't: '12/15/2025' sorts
 * ahead of '12/3/2025', so the last payment of the month reads as the middle
 * one and the wrong payment gets offered for the move.
 */
function dateOrder(input) {
  const p = dateParts(input);
  return p ? p.y * 10000 + p.m * 100 + p.d : 0;
}

/**
 * The date to move a payment to.
 *
 * Same day of the month, one month on — so a tenant who pays on the 3rd keeps
 * paying on the 3rd. Days past the end of the target month clamp to its last
 * day, which is the only sane reading of "31 January, a month later".
 *
 * Deliberately not "the 1st of next month": the day carries information about
 * when the money actually arrived, and flattening every correction to the 1st
 * would lose it.
 */
export function shiftForwardOneMonth(input) {
  const parts = dateParts(input);
  if (!parts) return null;
  const { y, m: mo, d: day } = parts;
  const targetY = mo === 12 ? y + 1 : y;
  const targetMo = mo === 12 ? 1 : mo + 1;
  const lastDay = new Date(Date.UTC(targetY, targetMo, 0)).getUTCDate();
  const d = Math.min(day, lastDay);
  return `${targetY}-${String(targetMo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Sum of a month's rent payments. */
function sumOf(rows) {
  return (rows || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
}

/**
 * Rent payments that collide, grouped by the month they land in.
 *
 * Collisions are counted on the cash-flow month rather than the raw calendar
 * month, because that is the month the money is actually credited to — a
 * payment on the 28th already rolls forward on its own, and flagging it as a
 * clash with the 2nd of the same calendar month would be a false alarm about a
 * problem the site has already solved.
 *
 * Each collision carries its three surrounding months — the one before, the
 * doubled one, and the one the move would fill. A clash is only half the story:
 * whether to push the later payment forward or drag the earlier one back is a
 * judgement about which neighbour has the hole, and that can't be made without
 * seeing what is credited either side.
 *
 * @param {Array} transactions
 * @param {(key: string) => boolean} isDismissed
 * @returns {Array<{ monthKey, month, payments, later, earlier, suggestedDate, suggestedMonth, months, moveAmount, key }>}
 */
export function findRentCollisions(transactions, isDismissed = () => false) {
  const byMonth = new Map();

  for (const t of transactions || []) {
    if (!t || !t.date || !isRentIncome(t)) continue;
    const key = cashFlowMonthKey(t);
    if (!key) continue;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(t);
  }

  const byDate = (a, b) => dateOrder(a.date) - dateOrder(b.date);

  const out = [];
  for (const [monthKey, rows] of byMonth) {
    if (rows.length < 2) continue;

    const payments = [...rows].sort(byDate);
    const later = payments[payments.length - 1];
    const earlier = payments[0];

    // Keyed on the payment being proposed for the move, so dismissing one
    // collision doesn't silence a different month.
    const key = `rent-dupe:${monthKey}:${txnKey(later)}`;
    if (isDismissed(key)) continue;

    const suggestedDate = shiftForwardOneMonth(later.date);
    const beforeKey = prevMonthKey(monthKey);
    const afterKey = nextMonthKey(monthKey);
    const moveAmount = Number(later.amount) || 0;

    const monthOf = (mKey, role) => {
      const list = [...(byMonth.get(mKey) || [])].sort(byDate);
      return {
        key: mKey,
        label: monthLabel(mKey),
        payments: list,
        total: sumOf(list),
        role,
      };
    };

    out.push({
      monthKey,
      month: monthLabel(monthKey),
      payments,
      later,
      earlier,
      suggestedDate,
      suggestedMonth: monthLabel(afterKey),
      months: [
        monthOf(beforeKey, 'before'),
        monthOf(monthKey, 'collision'),
        monthOf(afterKey, 'after'),
      ],
      moveAmount,
      total: sumOf(payments),
      key,
    });
  }

  // Most recent first: a collision this month is worth more than one in 2019.
  return out.sort((a, b) => b.monthKey.localeCompare(a.monthKey));
}
