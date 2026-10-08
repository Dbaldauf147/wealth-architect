/* When spending overtakes income — the "Overshot" page.

   Income and spending are counted exactly as the Cash Flow page counts them
   (cashFlowBreakdown): transfers, card payments and investing are money
   moving, not earned or spent; refunds net against their category, and a
   category that nets positive in a month is money in that month. So a month's numbers here
   are the same as that month's Income and Expenses on Cash Flow for the same
   window.

   One month over isn't "living above your means" — an annual bill or a trip
   does that. The verdict leans on the three-month average instead, and the
   page shows both.

   Pure: no React, no DOM. */

import { cashFlowBreakdown, cashFlowMonthKey } from './cashflowExport.js';

const DAY = 86400000;
const round2 = n => Math.round(n * 100) / 100;

export function monthKeyFor(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Every YYYY-MM from the first transaction's month to `today`'s, in order. */
export function monthsSpanned(transactions, today = new Date()) {
  let first = null;
  for (const t of transactions || []) {
    const k = cashFlowMonthKey(t);
    if (k && (!first || k < first)) first = k;
  }
  if (!first) return [];
  const last = monthKeyFor(today);
  const out = [];
  let [y, m] = first.split('-').map(Number);
  for (let guard = 0; guard < 600; guard++) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    if (k > last) break;
    out.push(k);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * @param transactions  the ledger
 * @param monthKeys     the window, oldest first — usually the tail of monthsSpanned
 * @param today         "now": its month is reported as in progress, not judged
 * @returns {
 *   months:  [{ key, income, spending, net, over, gap, partial, runOutDate, drivers, cumulative, rolling }],
 *   summary: { status, overCount, completeCount, totalGap, net, currentStreak, longestStreak, rolling, crossings },
 *   pace:    null | { key, income, spending, typicalIncome, typicalSpending, daysLeft, share, alreadyOver },
 * }
 */
export function computeOvershot({ transactions, monthKeys, today = new Date() }) {
  const nowKey = monthKeyFor(today);
  const { totals, role } = cashFlowBreakdown(transactions, monthKeys);
  const inWindow = new Set(monthKeys);

  // Daily and per-category signed sums per month, over the same transactions
  // the totals used (everything that isn't moving money).
  const daily = {};   // key -> { 'YYYY-MM-DD': { category: signed } }
  const byCat = {};   // key -> { category: signed }
  for (const t of transactions || []) {
    if (!t.date || !t.amount) continue;
    const r = role(t);
    if (!r || r === 'move') continue;
    const cat = t.category || 'Uncategorized';
    const key = cashFlowMonthKey(t);
    if (!inWindow.has(key)) continue;
    const d = new Date(t.date);
    if (isNaN(d)) continue;
    const day = `${monthKeyFor(d)}-${String(d.getDate()).padStart(2, '0')}`;
    const perDay = ((daily[key] ||= {})[day] ||= {});
    perDay[cat] = (perDay[cat] || 0) + t.amount;
    (byCat[key] ||= {})[cat] = (byCat[key][cat] || 0) + t.amount;
  }

  let cumulative = 0;
  const months = monthKeys.map(key => {
    const { income, expenses, invested = 0, kept = 0 } = totals[key] || { income: 0, expenses: 0 };
    const spending = expenses;
    const net = round2(income - spending);
    const partial = key === nowKey;
    cumulative = round2(cumulative + net);
    return { key, income: round2(income), spending: round2(spending), net, invested: round2(invested), kept: round2(kept), over: spending > income, gap: round2(Math.max(0, spending - income)), partial, cumulative };
  });

  const complete = months.filter(m => !m.partial);

  // Each category's typical month, from complete months, for "what pushed it over".
  const cats = new Set(complete.flatMap(m => Object.keys(byCat[m.key] || {})));
  const typical = {};
  for (const c of cats) typical[c] = median(complete.map(m => Math.max(0, -(byCat[m.key]?.[c] || 0))));

  for (const m of months) {
    m.runOutDate = null;
    m.drivers = [];
    if (!m.over) continue;
    // The day spending passed the month's whole income: the point where the
    // rest of the month was paid for out of savings or credit. Spending to
    // date is counted the way the month's total is — only categories that are
    // spending this month (net negative), each at its net so far — so on the
    // last day it lands exactly on m.spending and an over month always finds
    // its day.
    const sofar = {};
    const spendingCats = new Set(Object.entries(byCat[m.key] || {}).filter(([, v]) => v <= 0).map(([c]) => c));
    for (const day of Object.keys(daily[m.key] || {}).sort()) {
      for (const [cat, amt] of Object.entries(daily[m.key][day])) sofar[cat] = (sofar[cat] || 0) + amt;
      const run = [...spendingCats].reduce((s, c) => s + Math.max(0, -(sofar[c] || 0)), 0);
      if (run > m.income + 0.005) {
        const [y, mo, d] = day.split('-').map(Number);
        m.runOutDate = new Date(y, mo - 1, d);
        break;
      }
    }
    m.drivers = Object.entries(byCat[m.key] || {})
      .map(([category, signed]) => {
        const amount = round2(Math.max(0, -signed));
        return { category, amount, typical: round2(typical[category] || 0), extra: round2(amount - (typical[category] || 0)) };
      })
      .filter(d => d.extra > 0)
      .sort((a, b) => b.extra - a.extra)
      .slice(0, 3);
  }

  // Three-month averages over complete months — the steadier signal.
  complete.forEach((m, i) => {
    if (i < 2) { m.rolling = null; return; }
    const w = complete.slice(i - 2, i + 1);
    const income = round2(w.reduce((s, x) => s + x.income, 0) / 3);
    const spending = round2(w.reduce((s, x) => s + x.spending, 0) / 3);
    m.rolling = { income, spending, over: spending > income };
  });
  for (const m of months) if (m.partial) m.rolling = null;

  // Streaks of consecutive overshot (complete) months.
  let run = 0;
  let longest = { length: 0, start: null, end: null };
  let start = null;
  for (const m of complete) {
    if (m.over) {
      if (!run) start = m.key;
      run++;
      if (run > longest.length) longest = { length: run, start, end: m.key };
    } else run = 0;
  }
  const currentStreak = run;

  // Where the running total of (income − spending) over the window changed sign.
  const crossings = [];
  let prev = 0;
  for (const m of complete) {
    if (prev >= 0 && m.cumulative < 0) crossings.push({ key: m.key, direction: 'under' });
    if (prev < 0 && m.cumulative >= 0) crossings.push({ key: m.key, direction: 'back' });
    prev = m.cumulative;
  }

  const latest = complete[complete.length - 1] || null;
  const status = !latest ? 'none'
    : latest.rolling?.over ? 'above'
      : latest.over ? 'edge'
        : 'within';

  const summary = {
    status,
    latest: latest ? latest.key : null,
    overCount: complete.filter(m => m.over).length,
    completeCount: complete.length,
    totalGap: round2(complete.reduce((s, m) => s + m.gap, 0)),
    net: round2(complete.reduce((s, m) => s + m.net, 0)),
    currentStreak,
    longestStreak: longest,
    rolling: latest?.rolling || null,
    crossings,
  };

  // The month in progress, against a typical complete month.
  const current = months.find(m => m.partial) || null;
  let pace = null;
  if (current) {
    const [y, mo] = current.key.split('-').map(Number);
    const daysIn = new Date(y, mo, 0).getDate();
    const elapsed = Math.min(daysIn, Math.max(1, Math.floor((today - new Date(y, mo - 1, 1)) / DAY) + 1));
    const typicalIncome = round2(median(complete.slice(-6).map(m => m.income)));
    const typicalSpending = round2(median(complete.slice(-6).map(m => m.spending)));
    // No straight-line projection: rent and other big bills land early in the
    // month, so extrapolating the first week's spending overshoots wildly.
    pace = {
      key: current.key,
      income: current.income,
      spending: current.spending,
      typicalIncome,
      typicalSpending,
      daysLeft: daysIn - elapsed,
      share: typicalIncome > 0 ? current.spending / typicalIncome : null,
      alreadyOver: current.spending > Math.max(typicalIncome, current.income),
    };
  }

  return { months, summary, pace };
}
