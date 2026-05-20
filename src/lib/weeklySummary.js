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

// Mirrors the exclusion list used elsewhere (e.g. CashFlowPage): transfers and
// credit-card payments shuffle money between your own accounts and are not
// real spending.
function isTransferLike(t) {
  const cat = (t.category || '').toLowerCase();
  return cat === 'transfer' || cat === 'credit card payment' || cat === 'credit card payments';
}

function isCreditCardPayment(t) {
  const cat = (t.category || '').toLowerCase();
  return cat === 'credit card payment' || cat === 'credit card payments';
}

/** From the full transaction history, project the next upcoming credit card
 *  payment per card. Uses the inflow side of CC payments (positive amount on
 *  the card account) so each card is keyed by its own account name. Cadence
 *  is inferred from the average gap between payments, defaulting to monthly.
 *  The projected date is rolled forward until it is on or after `asOf`. */
export function upcomingCardPayments({ transactions, asOf = new Date() }) {
  const byCard = new Map();
  for (const t of transactions || []) {
    if (!isCreditCardPayment(t)) continue;
    if (!(t.amount > 0)) continue; // inflow on the card account
    const d = parseDate(t.date);
    if (!d) continue;
    const key = (t.account || '').trim();
    if (!key) continue;
    const bucket = byCard.get(key) || { card: t.account, dates: [], amounts: [] };
    bucket.dates.push(d);
    bucket.amounts.push(Math.abs(t.amount));
    byCard.set(key, bucket);
  }

  const results = [];
  for (const { card, dates, amounts } of byCard.values()) {
    dates.sort((a, b) => a - b);
    const last = dates[dates.length - 1];

    // Cadence in days: average gap between payments, or 30 if only one sample.
    let cadenceDays = 30;
    if (dates.length >= 2) {
      const totalDays = (dates[dates.length - 1] - dates[0]) / 86400000;
      cadenceDays = totalDays / (dates.length - 1);
    }
    const intervalMs = Math.max(1, Math.round(cadenceDays)) * 86400000;

    let next = new Date(last.getTime() + intervalMs);
    while (next < asOf) next = new Date(next.getTime() + intervalMs);

    const lastAmount = amounts[amounts.length - 1];
    const avgAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length;

    results.push({
      card,
      lastDate: last.toISOString(),
      nextDate: next.toISOString(),
      lastAmount,
      avgAmount,
      occurrences: dates.length,
      cadenceDays: Math.round(cadenceDays),
    });
  }

  results.sort((a, b) => new Date(a.nextDate) - new Date(b.nextDate));
  return results;
}

/** Month-to-date trends through `weekEnd`, compared with the same MTD window
 *  in the prior month. Returns headline totals, the period label, and the top
 *  category movers ranked by absolute $ delta. */
export function monthlyTrends({ transactions, weekEnd }) {
  const y = weekEnd.getFullYear();
  const m = weekEnd.getMonth();
  const day = weekEnd.getDate();

  const monthStart = new Date(y, m, 1);
  const mtdEnd = new Date(y, m, day, 23, 59, 59, 999);

  const priorM = m === 0 ? 11 : m - 1;
  const priorY = m === 0 ? y - 1 : y;
  const priorMonthStart = new Date(priorY, priorM, 1);
  const priorMonthLastDay = new Date(priorY, priorM + 1, 0).getDate();
  const priorMtdEnd = new Date(priorY, priorM, Math.min(day, priorMonthLastDay), 23, 59, 59, 999);

  const monthLabel = monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const inWin = (t, s, e) => {
    if (isTransferLike(t)) return false;
    const d = parseDate(t.date);
    return d && d >= s && d <= e;
  };

  function expensesByCategory(txs) {
    const byCat = new Map();
    let total = 0;
    for (const t of txs) {
      if (t.amount >= 0) continue;
      const cat = t.category || 'Uncategorized';
      if (cat === 'Income') continue;
      const amt = Math.abs(t.amount);
      byCat.set(cat, (byCat.get(cat) || 0) + amt);
      total += amt;
    }
    return { byCat, total };
  }

  const cur = expensesByCategory((transactions || []).filter(t => inWin(t, monthStart, mtdEnd)));
  const prev = expensesByCategory((transactions || []).filter(t => inWin(t, priorMonthStart, priorMtdEnd)));

  const allCats = new Set([...cur.byCat.keys(), ...prev.byCat.keys()]);
  const movers = [];
  for (const cat of allCats) {
    const a = cur.byCat.get(cat) || 0;
    const b = prev.byCat.get(cat) || 0;
    const delta = a - b;
    if (Math.abs(delta) < 1) continue;
    const pct = b > 0 ? (delta / b) * 100 : null; // null → new this month
    movers.push({ name: cat, current: a, prior: b, delta, pct });
  }
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    monthLabel,
    mtdRange: { start: monthStart.toISOString(), end: mtdEnd.toISOString() },
    priorMtdRange: { start: priorMonthStart.toISOString(), end: priorMtdEnd.toISOString() },
    mtdTotal: cur.total,
    priorMtdTotal: prev.total,
    mtdDelta: cur.total - prev.total,
    mtdPct: prev.total > 0 ? ((cur.total - prev.total) / prev.total) * 100 : null,
    topMovers: movers.slice(0, 5),
  };
}

/** Build a weekly summary object.
 *  `transactions` is the full transaction list; we filter to the given range.
 *  `accountNicknames` is an optional { [originalName]: nickname } map applied
 *  to user-visible account names so the email matches the in-app rename. */
export function buildWeeklySummary({ transactions, start, end, asOf = new Date(), accountNicknames = {} }) {
  const inRange = (transactions || []).filter(t => withinRange(t, start, end) && !isTransferLike(t));
  // Prior week of the same length for week-over-week comparison
  const spanMs = end.getTime() - start.getTime();
  const priorEnd = new Date(start.getTime() - 1);
  const priorStart = new Date(priorEnd.getTime() - spanMs);
  const prior = (transactions || []).filter(t => withinRange(t, priorStart, priorEnd) && !isTransferLike(t));

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
    if ((t.category || '').toLowerCase() === 'rent') continue;
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

  const upcomingPayments = upcomingCardPayments({ transactions, asOf });
  const nextCardPaymentRaw = upcomingPayments[0] || null;
  const nextCardPayment = nextCardPaymentRaw
    ? { ...nextCardPaymentRaw, card: accountNicknames[nextCardPaymentRaw.card] || nextCardPaymentRaw.card }
    : null;

  const trends = monthlyTrends({ transactions, weekEnd: end });

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
    nextCardPayment,
    monthlyTrends: trends,
    fmt,
  };
}
