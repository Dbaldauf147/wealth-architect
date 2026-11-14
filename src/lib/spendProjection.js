/* Projected spending for the month in progress — the Budgets & Trends page's
   "This month" tab.

   No straight-line extrapolation: rent and the big bills land early, so
   multiplying the first two weeks by two overshoots badly. Instead each
   category's projection is what it has spent so far plus what it usually
   spends in the *rest* of a month from this day on — the average, over the
   last few complete months, of that month's charges after today's
   day-of-month. Rent paid on the 1st therefore adds nothing more; groceries
   bought weekly add about half a month's worth on the 15th.

   Spending is counted as the Trends and Budgets pages count it
   (categoryDrilldown isTrendSpend): every charge, never money moving between
   your own accounts, refunds not netted.

   Pure: no React, no DOM. */

import { isTrendSpend, trendMonthKey } from './categoryDrilldown.js';

const round2 = n => Math.round(n * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const daysIn = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m, 0).getDate(); };
function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}

/**
 * @param transactions  the ledger
 * @param today         "now"; its month is the one projected
 * @param lookback      how many complete months the rest-of-month pattern comes from
 * @returns {
 *   key, day, daysInMonth, daysLeft,
 *   basis: [monthKey] (the complete months used, oldest first; empty = nothing to project from),
 *   soFar, remaining, projected, typical, lastMonth,
 *   categories: [{ category, soFar, remaining, projected, typical, delta }] (largest projection first),
 *   daily: [{ day, actual (cumulative, null after today), projected (cumulative, null before today), typical (cumulative) }],
 * }
 */
export function projectMonthSpending({ transactions, today = new Date(), lookback = 3 }) {
  const key = keyOf(today);
  const day = today.getDate();
  const dim = daysIn(key);
  const candidates = Array.from({ length: lookback }, (_, i) => addMonths(key, -(lookback - i)));
  const wanted = new Set([key, ...candidates]);

  // month -> category -> day -> amount
  const byMonth = {};
  for (const t of transactions || []) {
    if (!isTrendSpend(t)) continue;
    const k = trendMonthKey(t);
    if (!wanted.has(k)) continue;
    const d = new Date(t.date).getDate();
    const cat = t.category || 'Uncategorized';
    const perCat = ((byMonth[k] ||= {})[cat] ||= {});
    perCat[d] = (perCat[d] || 0) + Math.abs(Number(t.amount));
  }
  // Only months that have any spending are a basis (history may start later).
  const basis = candidates.filter(k => byMonth[k]);
  const n = basis.length;

  const sum = (perDay, from, to) => {
    let s = 0;
    for (const [d, v] of Object.entries(perDay || {})) if (d >= from && d <= to) s += v;
    return s;
  };
  const cats = new Set(Object.keys(byMonth[key] || {}));
  for (const k of basis) for (const c of Object.keys(byMonth[k])) cats.add(c);

  const categories = [...cats].map(category => {
    const soFar = sum(byMonth[key]?.[category], 1, day);
    let after = 0;
    let total = 0;
    for (const k of basis) {
      after += sum(byMonth[k][category], day + 1, 31);
      total += sum(byMonth[k][category], 1, 31);
    }
    const remaining = n ? after / n : 0;
    const typical = n ? total / n : 0;
    return {
      category,
      soFar: round2(soFar),
      remaining: round2(remaining),
      projected: round2(soFar + remaining),
      typical: round2(typical),
      delta: round2(soFar + remaining - typical),
    };
  }).filter(c => c.projected > 0.005 || c.typical > 0.005)
    .sort((a, b) => b.projected - a.projected || a.category.localeCompare(b.category));

  const total = f => round2(categories.reduce((s, c) => s + c[f], 0));
  const soFar = total('soFar');
  const remaining = total('remaining');

  // Day by day: what has been spent, the usual shape of a month, and the
  // projection riding that shape from today's total.
  const monthDay = (k, d) => Object.values(byMonth[k] || {}).reduce((s, perDay) => s + (perDay[d] || 0), 0);
  const daily = [];
  let actual = 0;
  let typical = 0;
  let typicalToday = 0;
  for (let d = 1; d <= dim; d++) {
    actual += monthDay(key, d);
    // A basis month shorter than this one has simply finished by day d.
    typical += n ? basis.reduce((s, k) => s + monthDay(k, d), 0) / n : 0;
    if (d === day) typicalToday = typical;
    daily.push({
      day: d,
      actual: d <= day ? round2(actual) : null,
      projected: d >= day ? round2(soFar + (typical - typicalToday)) : null,
      typical: round2(typical),
    });
    if (d === day) actual = soFar;
  }
  // Days 29–31 of longer basis months, past this month's end, still count.
  const lastRow = daily[daily.length - 1];
  if (lastRow) lastRow.projected = round2(soFar + remaining);

  const prev = addMonths(key, -1);
  return {
    key,
    day,
    daysInMonth: dim,
    daysLeft: dim - day,
    basis,
    soFar,
    remaining,
    projected: round2(soFar + remaining),
    typical: total('typical'),
    lastMonth: byMonth[prev] ? round2(Object.values(byMonth[prev]).reduce((s, perDay) => s + sum(perDay, 1, 31), 0)) : null,
    categories,
    daily,
  };
}
