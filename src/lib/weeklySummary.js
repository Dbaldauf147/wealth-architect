/* Pure summary computation — usable from both the client (preview) and the
   Vercel Function (actual send). No React, no DOM, no localStorage access.

   Input:  { transactions, rangeStart, rangeEnd }  (ISO date strings, inclusive)
   Output: a plain object describing the summary so rendering is separate. */

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function fmt(n) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Returns the ISO date (YYYY-MM-DD) for the Monday that begins the week
 *  containing `d`, treating Mon as the first day. */
export function weekStart(d) {
  const date = new Date(d);
  const dow = date.getDay(); // 0=Sun..6=Sat
  const daysSinceMon = (dow + 6) % 7;
  date.setDate(date.getDate() - daysSinceMon);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** The Mon..Sun window that ended most recently before `asOf` (default now). */
export function lastCompletedWeek(asOf = new Date()) {
  const thisMon = weekStart(asOf);
  const lastMon = new Date(thisMon);
  lastMon.setDate(lastMon.getDate() - 7);
  const lastSun = new Date(thisMon);
  lastSun.setDate(lastSun.getDate() - 1);
  lastSun.setHours(23, 59, 59, 999);
  return { start: lastMon, end: lastSun };
}

function withinRange(t, start, end) {
  const d = parseDate(t.date);
  if (!d) return false;
  return d >= start && d <= end;
}

/** Build a weekly summary object.
 *  `transactions` is the full transaction list; we filter to the given range. */
export function buildWeeklySummary({ transactions, start, end }) {
  const inRange = (transactions || []).filter(t => withinRange(t, start, end));
  // Prior week of the same length for week-over-week comparison
  const spanMs = end.getTime() - start.getTime();
  const priorEnd = new Date(start.getTime() - 1);
  const priorStart = new Date(priorEnd.getTime() - spanMs);
  const prior = (transactions || []).filter(t => withinRange(t, priorStart, priorEnd));

  const expenseTotal = inRange.reduce((s, t) => (t.amount < 0 ? s + Math.abs(t.amount) : s), 0);
  const priorTotal = prior.reduce((s, t) => (t.amount < 0 ? s + Math.abs(t.amount) : s), 0);
  const wowDelta = expenseTotal - priorTotal;
  const wowPct = priorTotal ? (wowDelta / priorTotal) * 100 : null;

  // Per-category totals (expenses only, ignore Income category)
  const byCat = new Map();
  for (const t of inRange) {
    if (t.amount >= 0) continue;
    const cat = (t.category || 'Uncategorized');
    if (cat === 'Income') continue;
    byCat.set(cat, (byCat.get(cat) || 0) + Math.abs(t.amount));
  }
  const topCategories = [...byCat.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, amount]) => ({ name, amount, pct: expenseTotal ? (amount / expenseTotal) * 100 : 0 }));

  // Top merchants by total spend (sum of absolute expense amounts)
  const byMerch = new Map();
  for (const t of inRange) {
    if (t.amount >= 0) continue;
    const key = (t.description || '').trim().toLowerCase();
    if (!key) continue;
    const existing = byMerch.get(key) || { name: t.description, amount: 0, count: 0 };
    existing.amount += Math.abs(t.amount);
    existing.count += 1;
    byMerch.set(key, existing);
  }
  const topMerchants = [...byMerch.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);

  // Uncategorized transactions to triage
  const uncategorized = inRange
    .filter(t => !t.category || t.category === 'Uncategorized')
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return {
    range: { start: start.toISOString(), end: end.toISOString() },
    expenseTotal,
    priorTotal,
    wowDelta,
    wowPct,
    topCategories,
    topMerchants,
    uncategorized,
    transactionCount: inRange.length,
    uncategorizedCount: uncategorized.length,
    fmt,
  };
}
