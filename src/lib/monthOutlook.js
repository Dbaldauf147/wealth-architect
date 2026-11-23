/* One month's income and spending, actual beside projected, by category —
   the panel behind a clicked month on Overshot and the two projection charts
   in the weekly email, so both show the same figures.

   Actual is the month as Overshot and Cash Flow count it (computeOvershot):
   transfers, card payments and investing left out, refunds netted into their
   category, rent received as income.

   Projected depends on where the month sits:

     • The month in progress — what has happened so far plus what's still to
       come. Income: the paychecks still due on the Commissions tab's pay
       schedule (base salary, and the month-end commission at its take-home
       rate). Spending: each category's usual charges in the rest of a month
       from today's day on (spendProjection — never a straight line).
     • Next month — the pay schedule, and a typical month's spending.
     • A month already over — what it was expected to be going in: the pay
       the schedule planned for it (commissionSchedule payByMonth), and a
       typical month's spending at the time.

   A typical month's spending is each category's average over the three
   complete months before the one in question.

   Income that isn't payroll has no schedule, so it counts once it arrives
   and isn't projected — which keeps this month's projected income equal to
   the Income page's "month, expected" plus whatever else Cash Flow counts as
   income. The one exception is rent received: it comes every month, so until
   it lands it's expected at its usual amount (its median over the same three
   months), and next month includes it.

   Spending follows the Spending → This month tab (`spendPrefs`): categories
   switched off there are left out of both columns, and a category you've
   given your own expected month total uses that in place of the projection.

   Pure: no React, no DOM. */

import { computeOvershot, monthsSpanned, monthKeyFor, incomeBuckets, expectedIncomeMonths } from './overshot.js';
import { computeIncome, commissionTakeHome, monthKeysEnding } from './income.js';
import { baseSalary, paySchedule, payByMonth, commissionRows, addMonths } from './commissionSchedule.js';
import { payouts, expectedPayouts } from './commissions.js';
import { projectMonthSpending } from './spendProjection.js';
import { isMoneyMove, RENT_RECEIVED } from './cashflowExport.js';

const round2 = n => Math.round(n * 100) / 100;
const TYPICAL_MONTHS = 3;
export const BASE = 'Base salary';
export const COMMISSION = 'Commission';

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const total = (rows, f) => round2(rows.reduce((s, r) => s + (r[f] || 0), 0));

/**
 * @param transactions      the ledger (already categorised)
 * @param incomeCategories  the Income bucket (for telling payroll apart)
 * @param commissions       the Commissions table, or null/[] when it isn't known
 * @param key               the month, 'YYYY-MM' (default: today's)
 * @param spendPrefs        { hidden: [category], expected: { [category]: amount } } from the
 *                          Spending tab (hidden already resolved for the month), or null
 * @param today             "now"
 * @returns null when the month is outside the ledger and isn't next month, else {
 *   key, status: 'past' | 'current' | 'next',
 *   income:   { actual, projected (null = no pay schedule for it), rows: [{ name, actual, projected, payroll }] },
 *   spending: { actual, projected (null = no earlier months to go by), rows: [{ name, actual, projected, own? }],
 *               hidden: [category] switched off on the Spending tab and left out, total (actual, hidden included) },
 *   net:      { actual, projected (null when either side is) },
 *   basis:    the complete months "typical" spending was averaged over, oldest first,
 *   stillDue: paychecks still expected this month (current only),
 * }
 * Rows are largest first, by the larger of actual and projected.
 */
export function monthOutlook({ transactions, incomeCategories, commissions, key, today = new Date(), spendPrefs = null }) {
  if (!transactions?.length) return null;
  const nowKey = monthKeyFor(today);
  const month = key || nowKey;
  const nextKey = addMonths(nowKey, 1);
  const keys = monthsSpanned(transactions, today);
  const status = month === nowKey ? 'current' : month === nextKey ? 'next' : month < nowKey ? 'past' : null;
  if (!status || (status === 'past' && !keys.includes(month))) return null;

  const { months } = computeOvershot({ transactions, monthKeys: keys, today });
  const byKey = Object.fromEntries(months.map(m => [m.key, m]));
  const m = byKey[month] || null;
  const { paychecks } = computeIncome({ transactions, incomeCategories, monthKeys: monthKeysEnding(nowKey, 13), today });
  const bucket = m ? incomeBuckets({ months: [m], paychecks })[month] : { base: 0, commission: 0, otherBy: [] };

  // ── Income ──
  const base = baseSalary(paychecks, today);
  const rate = commissionTakeHome(paychecks, payouts(commissions || []), today);
  let planned = null; // payroll the month is (or was) expected to bring: { base, commission }
  let stillDue = 0;
  if (base && status !== 'past') {
    const schedule = paySchedule({ base, paychecks, expected: expectedPayouts(commissions || [], today), takeHome: rate, today });
    const row = expectedIncomeMonths({ schedule, months: 2 }).find(e => e.key === month);
    if (row) {
      planned = { base: round2(bucket.base + row.base), commission: round2(bucket.commission + row.commission) };
      stillDue = row.expected;
    }
  } else if (base) {
    const point = payByMonth({ rows: commissionRows(commissions || [], today), paychecks, base, takeHome: rate, today })
      .find(p => p.payMonth === month);
    if (point?.planned) planned = { base: point.planned.base, commission: point.planned.commission };
  }
  // The complete months a "typical month" is read from.
  const before = keys.filter(k => k < month && k !== nowKey && Object.keys(byKey[k]?.spendingByCategory || {}).length);
  const basis = before.slice(-TYPICAL_MONTHS);

  // Other income counts as it arrives; rent received is also expected at its
  // usual amount until it does.
  const basisBuckets = incomeBuckets({ months: basis.map(k => byKey[k]), paychecks });
  const otherActual = Object.fromEntries(bucket.otherBy.map(o => [o.category, o.amount]));
  const otherNames = new Set(Object.keys(otherActual));
  for (const k of basis) for (const o of basisBuckets[k].otherBy) otherNames.add(o.category);
  const usual = name => round2(median(basis.map(k => basisBuckets[k].otherBy.find(o => o.category === name)?.amount || 0)));
  const incomeRows = [
    { name: BASE, actual: bucket.base, projected: planned ? planned.base : null, payroll: true },
    { name: COMMISSION, actual: bucket.commission, projected: planned ? planned.commission : null, payroll: true },
    ...[...otherNames].map(name => {
      const actual = otherActual[name] || 0;
      const expects = name === RENT_RECEIVED ? usual(name) : 0;
      return { name, actual, projected: status === 'past' ? (name === RENT_RECEIVED ? expects : actual) : Math.max(actual, expects), payroll: false };
    }),
  ].filter(r => r.actual > 0.005 || r.projected > 0.005);

  // ── Spending ──
  const typical = {};
  for (const k of basis) {
    for (const [cat, v] of Object.entries(byKey[k].spendingByCategory)) typical[cat] = (typical[cat] || 0) + v / basis.length;
  }
  const actualBy = m?.spendingByCategory || {};
  let projectedBy = null;
  if (status === 'current') {
    // What's spent plus each category's usual charges from here to month-end.
    const rest = projectMonthSpending({ transactions: transactions.filter(t => !isMoneyMove(t)), today });
    if (rest.basis.length) {
      projectedBy = { ...actualBy };
      for (const c of rest.categories) {
        if (c.remaining > 0.005) projectedBy[c.category] = (projectedBy[c.category] || 0) + c.remaining;
      }
    }
  } else if (basis.length) {
    projectedBy = typical;
  }
  // Your own expected total for the month in progress stands in for the
  // projection (never below what's already spent), as on the Spending tab.
  const own = status === 'current' && projectedBy ? spendPrefs?.expected || {} : {};
  const off = new Set(spendPrefs?.hidden || []);
  const names = new Set([...Object.keys(actualBy), ...Object.keys(projectedBy || {})]);
  const allSpending = [...names].map(name => {
    const actual = round2(actualBy[name] || 0);
    const mine = own[name] >= 0 ? Math.max(actual, own[name]) : null;
    return {
      name,
      actual,
      projected: mine != null ? round2(mine) : projectedBy ? round2(projectedBy[name] || 0) : null,
      ...(mine != null ? { own: true } : {}),
    };
  }).filter(r => r.actual > 0.005 || r.projected > 0.005);
  const spendingRows = allSpending.filter(r => !off.has(r.name));
  const hiddenSpending = allSpending.filter(r => off.has(r.name)).map(r => r.name).sort();

  const bySize = (a, b) => Math.max(b.actual, b.projected || 0) - Math.max(a.actual, a.projected || 0) || a.name.localeCompare(b.name);
  spendingRows.sort(bySize);
  const payroll = incomeRows.filter(r => r.payroll);
  const rest = incomeRows.filter(r => !r.payroll).sort(bySize);

  const income = {
    actual: m ? m.income : 0,
    projected: planned ? total([...payroll, ...rest], 'projected') : null,
    rows: [...payroll, ...rest],
  };
  const spending = {
    actual: hiddenSpending.length ? total(spendingRows, 'actual') : m ? m.spending : 0,
    projected: projectedBy ? total(spendingRows, 'projected') : null,
    rows: spendingRows,
    hidden: hiddenSpending,
    total: m ? m.spending : 0,
  };
  return {
    key: month,
    status,
    income,
    spending,
    net: {
      actual: round2(income.actual - spending.actual),
      projected: income.projected == null || spending.projected == null ? null : round2(income.projected - spending.projected),
    },
    basis,
    stillDue: round2(stillDue),
  };
}

/**
 * Rows cut down for a stacked chart: the `top` largest by projection (actual
 * when there's none) keep their own segment, the rest fold into one.
 * @returns [{ name, actual, projected, other? }]
 */
export function topRows(rows, top = 6, otherName = 'Everything else') {
  const size = r => (r.projected == null ? r.actual : r.projected);
  const sorted = [...(rows || [])].sort((a, b) => size(b) - size(a));
  if (sorted.length <= top + 1) return sorted;
  const tail = sorted.slice(top);
  return [...sorted.slice(0, top), {
    name: otherName,
    actual: total(tail, 'actual'),
    projected: tail.some(r => r.projected != null) ? total(tail, 'projected') : null,
    other: true,
  }];
}
