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
//
// Two payments are not on their own a problem: what matters is whether the
// month ends up holding roughly a month's rent. A rent that arrived in two
// pieces sums to the usual figure and is left alone.

import { isRentIncome, cashFlowMonthKey } from './cashflowExport.js';
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

/** 'YYYY-MM' as a single number, so months can be compared and stepped. */
function monthIndex(key) {
  const [y, m] = String(key).split('-').map(Number);
  return y && m ? y * 12 + (m - 1) : null;
}

/** The inverse of monthIndex(). */
function keyFromIndex(index) {
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How far a month's rent may run over the typical figure and still be normal.
 *
 * Two payments that together come to about one month's rent are a rent that
 * arrived in two pieces — a part payment, a tenant splitting with a roommate,
 * a small top-up after a short payment — and the month is not doubled at all.
 * Flagging those is noise: nothing needs moving, because the month already
 * holds the right amount of money.
 *
 * The allowance is deliberately narrow. A genuine double comes in near 200% of
 * typical, so 115% separates "paid in two pieces" from "paid twice" with room
 * to spare for a rent increase or a late fee riding along with the payment.
 */
export const TYPICAL_TOLERANCE = 1.15;

/** How many single-payment months feed the typical figure. */
const TYPICAL_SAMPLE = 12;

/**
 * What a month of rent normally comes to, near a given month.
 *
 * Read only off months holding a single payment: those are the uncontested
 * ones, and the doubled months this file exists to find would otherwise drag
 * the figure up towards the very number they need to be measured against.
 *
 * The median rather than the mean, because one month of arrears arriving as a
 * lump would pull an average up far enough to excuse a real double. And the
 * sample is the months *nearest* the one in question rather than all of
 * history — rent gets raised, and a 2019 figure says nothing about whether a
 * 2026 month is normal.
 *
 * Returns null when there aren't enough clean months to say anything, which
 * leaves the collision flagged: silence should need evidence.
 */
export function typicalMonthlyRent(byMonth, nearKey) {
  const near = monthIndex(nearKey);
  const singles = [];
  for (const [key, rows] of byMonth) {
    if (!rows || rows.length !== 1) continue;
    const index = monthIndex(key);
    if (index == null) continue;
    singles.push({ distance: near == null ? 0 : Math.abs(index - near), total: sumOf(rows) });
  }
  if (singles.length < 2) return null;
  singles.sort((a, b) => a.distance - b.distance);
  return median(singles.slice(0, TYPICAL_SAMPLE).map(s => s.total));
}

/** How many months of history a collision's chart carries, before and after. */
const CHART_BEFORE = 6;
const CHART_AFTER = 1;

/**
 * Rent payments that collide, grouped by the month they land in.
 *
 * Collisions are counted on the cash-flow month rather than the raw calendar
 * month, because that is the month the money is actually credited to — a
 * payment on the 28th already rolls forward on its own, and flagging it as a
 * clash with the 2nd of the same calendar month would be a false alarm about a
 * problem the site has already solved.
 *
 * A month is only a collision if it also holds too *much* money. Two payments
 * adding up to a normal month's rent are one rent split in two, and nothing
 * about that needs correcting — see TYPICAL_TOLERANCE.
 *
 * Each collision carries a run of surrounding months with their rent totals.
 * A clash is only half the story: whether to push the later payment forward or
 * drag the earlier one back is a judgement about which neighbour has the hole,
 * and that can't be made without seeing what is credited either side.
 *
 * @param {Array} transactions
 * @param {(key: string) => boolean} isDismissed
 * @returns {Array<{ monthKey, month, payments, later, earlier, suggestedDate, suggestedMonth, series, typical, moveAmount, key }>}
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

  // The earliest month rent ever landed in, so the chart doesn't open with a
  // row of empty bars from before the tenant existed.
  let firstIndex = null;
  for (const key of byMonth.keys()) {
    const index = monthIndex(key);
    if (index != null && (firstIndex == null || index < firstIndex)) firstIndex = index;
  }

  const out = [];
  for (const [monthKey, rows] of byMonth) {
    if (rows.length < 2) continue;

    // Keyed on the month alone. A dismissal says "December is fine", and it has
    // to keep saying that after a re-sync gives the payments new ids or a third
    // row lands — otherwise the warning the user answered comes straight back.
    const key = `rent-dupe:${monthKey}`;
    if (isDismissed(key)) continue;

    const payments = [...rows].sort(byDate);
    const total = sumOf(payments);

    // In line with a normal month — paid in pieces, not paid twice.
    const typical = typicalMonthlyRent(byMonth, monthKey);
    if (typical != null && total <= typical * TYPICAL_TOLERANCE) continue;

    const later = payments[payments.length - 1];
    const earlier = payments[0];
    const suggestedDate = shiftForwardOneMonth(later.date);
    const afterKey = nextMonthKey(monthKey);
    const moveAmount = Number(later.amount) || 0;

    const collisionIndex = monthIndex(monthKey);
    const startIndex = Math.max(
      collisionIndex - CHART_BEFORE,
      firstIndex == null ? collisionIndex : firstIndex,
    );
    const series = [];
    for (let i = startIndex; i <= collisionIndex + CHART_AFTER; i++) {
      const mKey = keyFromIndex(i);
      const list = [...(byMonth.get(mKey) || [])].sort(byDate);
      series.push({
        key: mKey,
        label: monthLabel(mKey),
        payments: list,
        total: sumOf(list),
        role: mKey === monthKey ? 'collision' : mKey === afterKey ? 'after' : '',
      });
    }

    out.push({
      monthKey,
      month: monthLabel(monthKey),
      payments,
      later,
      earlier,
      suggestedDate,
      suggestedMonth: monthLabel(afterKey),
      series,
      typical,
      moveAmount,
      total,
      key,
    });
  }

  // Most recent first: a collision this month is worth more than one in 2019.
  return out.sort((a, b) => b.monthKey.localeCompare(a.monthKey));
}
