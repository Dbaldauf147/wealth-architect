/* The model behind the wedge (stacked-area) chart on the Spending Trends page.

   The page already computes, per category, a month-by-month spend series
   aligned to a shared list of month keys. Stacking that into wedges is pure
   arithmetic — which is why it lives here rather than in the component: the
   ordering rule and the "Other" roll-up are the parts worth pinning down with
   tests, and neither needs React or the DOM.

   Two decisions are baked in:

     • Bands are ordered largest-total first and stacked from the bottom up.
       The biggest category is then the one sitting on the baseline, where its
       thickness is read against a straight edge instead of a wobbling one.

     • Everything past `topN` collapses into a single "Other" band at the top.
       Twenty hair-thin wedges are a colour swatch, not a chart. */

import { catColor } from './categories.js';

export const OTHER_LABEL = 'Other';
const OTHER_COLOR = '#94a3b8';

/* Stack per-category series into bands.

   `rows`    — [{ cat, series }], each `series` aligned index-for-index to `months`.
   `months`  — month keys, oldest first.
   `topN`    — how many categories keep their own band before the rest roll up.

   Returns { bands, monthTotals, max }, where every band carries the dollar
   `lower`/`upper` edge at each month (not pixels — the component owns the
   scale), plus the totals a legend wants. */
export function buildWedgeBands({ months = [], rows = [], topN = 8 } = {}) {
  if (!months.length || !rows.length) return { bands: [], monthTotals: [], max: 0 };

  const valuesFor = (row) => months.map((_, i) => {
    const v = Number(row.series?.[i]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  });

  const scored = rows
    .map(r => {
      const values = valuesFor(r);
      return { cat: r.cat, values, total: values.reduce((s, v) => s + v, 0) };
    })
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total || a.cat.localeCompare(b.cat));

  if (!scored.length) return { bands: [], monthTotals: months.map(() => 0), max: 0 };

  const kept = scored.slice(0, Math.max(1, topN));
  const rest = scored.slice(Math.max(1, topN));

  const stacked = [...kept];
  if (rest.length) {
    stacked.push({
      cat: OTHER_LABEL,
      values: months.map((_, i) => rest.reduce((s, r) => s + r.values[i], 0)),
      total: rest.reduce((s, r) => s + r.total, 0),
      rolledUp: rest.length,
    });
  }

  // Walk the stack once, carrying a running floor per month.
  const floor = months.map(() => 0);
  const bands = stacked.map(entry => {
    const lower = floor.slice();
    const upper = entry.values.map((v, i) => floor[i] + v);
    for (let i = 0; i < floor.length; i++) floor[i] = upper[i];
    return {
      cat: entry.cat,
      color: entry.cat === OTHER_LABEL ? OTHER_COLOR : catColor(entry.cat),
      values: entry.values,
      lower,
      upper,
      total: entry.total,
      avg: entry.total / months.length,
      rolledUp: entry.rolledUp || 0,
    };
  });

  const monthTotals = floor.slice();
  return { bands, monthTotals, max: Math.max(...monthTotals, 0) };
}

/* Round a maximum up to a readable axis top, and hand back the tick values.

   A $4,137 peak wants a $5,000 ceiling with lines every $1,250 — not five
   ticks reading $827.40. */
export function axisTicks(max, count = 4) {
  if (!Number.isFinite(max) || max <= 0) return { top: 0, ticks: [0] };
  const rough = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 1.25, 1.5, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= rough) || 10 * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v));
  return { top, ticks };
}
