/* Spending Trends › Share of spending: every category ranked by its share of
   what you spent over a period you choose, beside its share in the period of
   the same length just before.

   Spending is what the rest of the Trends page counts (isTrendSpend). Hidden
   categories — rent, by default — come out of the total as well as the list,
   so the shares are of everything else; what was hidden is reported apart.

   Pure: no React, no DOM. */

import { isTrendSpend, trendMonthKey } from './categoryDrilldown.js';

const round2 = n => Math.round(n * 100) / 100;

/** Categories hidden until you show them: rent, which dwarfs everything else. */
export const isRentCategory = cat => /\brent\b/i.test(String(cat || ''));

/** The 80/20 line: the share of spending the "vital few" categories cover. */
export const FOCUS_SHARE = 0.8;

/**
 * The 80/20 split of ranked rows: the fewest top categories whose shares add
 * up to at least `threshold` of spending, and the long tail after them.
 * @returns { count, share, amount, tailCount, tailShare, tailAmount }
 */
export function paretoFocus(rows, threshold = FOCUS_SHARE) {
  if (!rows.length) return { count: 0, share: 0, amount: 0, tailCount: 0, tailShare: 0, tailAmount: 0 };
  // A hair of tolerance so 79.99999% from float sums still counts as 80%.
  const i = rows.findIndex(r => r.cumShare >= threshold - 1e-9);
  const count = i < 0 ? rows.length : i + 1;
  const head = rows.slice(0, count);
  const tail = rows.slice(count);
  const sum = (list, k) => list.reduce((s, r) => s + r[k], 0);
  return {
    count,
    share: head[head.length - 1].cumShare,
    amount: round2(sum(head, 'amount')),
    tailCount: tail.length,
    tailShare: sum(tail, 'share'),
    tailAmount: round2(sum(tail, 'amount')),
  };
}

/** "YYYY-MM" plus n months (n may be negative). */
export function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** Months from `from` to `to` inclusive (0 if reversed). */
export function monthSpan(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return Math.max(0, (ty - fy) * 12 + (tm - fm) + 1);
}

/**
 * @param transactions  the ledger, categorised
 * @param from, to      "YYYY-MM", inclusive
 * @param hidden        Set of category names left out
 * @returns {
 *   rows: [{ rank, cat, amount, perMonth, share, cumShare, count, prevShare, prevAmount }],
 *   total, months, hiddenTotal, hiddenCats: [{ cat, amount }], prev: { from, to, total }, all: [names seen],
 *   focus: paretoFocus(rows) — rows also carry `focus: true` inside the 80%
 * }
 */
export function rankSpendShare({ transactions, from, to, hidden = new Set() }) {
  const months = monthSpan(from, to);
  const prevTo = addMonths(from, -1);
  const prevFrom = addMonths(from, -months);
  const cur = new Map();
  const prev = new Map();
  const hiddenAmt = new Map();
  const seen = new Set();
  let total = 0;
  let prevTotal = 0;
  for (const t of transactions || []) {
    if (!isTrendSpend(t)) continue;
    const key = trendMonthKey(t);
    if (!key) continue;
    const inCur = key >= from && key <= to;
    const inPrev = months > 0 && key >= prevFrom && key <= prevTo;
    if (!inCur && !inPrev) continue;
    const cat = t.category || 'Uncategorized';
    const amount = Math.abs(Number(t.amount));
    if (inCur) seen.add(cat);
    if (hidden.has(cat)) {
      if (inCur) hiddenAmt.set(cat, (hiddenAmt.get(cat) || 0) + amount);
      continue;
    }
    if (inCur) {
      const r = cur.get(cat) || { amount: 0, count: 0 };
      r.amount += amount;
      r.count += 1;
      cur.set(cat, r);
      total += amount;
    } else {
      prev.set(cat, (prev.get(cat) || 0) + amount);
      prevTotal += amount;
    }
  }

  let cum = 0;
  const rows = [...cur.entries()]
    .sort((a, b) => b[1].amount - a[1].amount || a[0].localeCompare(b[0]))
    .map(([cat, r], i) => {
      cum += r.amount;
      const p = prev.get(cat) || 0;
      return {
        rank: i + 1,
        cat,
        amount: round2(r.amount),
        perMonth: months ? round2(r.amount / months) : 0,
        share: total ? r.amount / total : 0,
        cumShare: total ? cum / total : 0,
        count: r.count,
        prevAmount: round2(p),
        prevShare: prevTotal ? p / prevTotal : null,
      };
    });

  const focus = paretoFocus(rows);
  rows.forEach((row, i) => { row.focus = i < focus.count; });

  return {
    rows,
    focus,
    total: round2(total),
    months,
    hiddenTotal: round2([...hiddenAmt.values()].reduce((s, v) => s + v, 0)),
    hiddenCats: [...hiddenAmt.entries()].map(([cat, amount]) => ({ cat, amount: round2(amount) })).sort((a, b) => b.amount - a.amount),
    prev: { from: prevFrom, to: prevTo, total: round2(prevTotal) },
    all: [...seen].sort(),
  };
}
