/* When spending overtakes income — the "Overshot" page.

   Income and spending are counted exactly as the Cash Flow page counts them
   (cashFlowBreakdown): transfers, card payments and investing are money
   moving, not earned or spent; rent received is income rather than a refund
   of rent paid; other refunds net against their category, and a
   category that nets positive in a month is money in that month. So a month's numbers here
   are the same as that month's Income and Expenses on Cash Flow for the same
   window.

   One month over isn't "living above your means" — an annual bill or a trip
   does that. The verdict leans on the three-month average instead, and the
   page shows both.

   Pure: no React, no DOM. */

import { cashFlowBreakdown, cashFlowMonthKey, flowCategory } from './cashflowExport.js';

const DAY = 86400000;
const round2 = n => Math.round(n * 100) / 100;

// Rent paid: by category/subcategory, or a whole-word "rent" in the
// description (a Zelle "for rent" that imported uncategorised). The same test
// as the weekly summary's; \brent\b doesn't fire on "parent" or "rental".
function isRentPaid(t) {
  if (!(t.amount < 0)) return false;
  if ((t.subcategory || '').trim().toLowerCase() === 'rent') return true;
  if ((t.category || '').trim().toLowerCase() === 'rent') return true;
  return /\brent\b/.test(`${t.description || ''} ${t.fullDescription || ''}`.toLowerCase());
}

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
 *   months:  [{ key, income, spending, net, over, gap, partial, runOutDate, drivers, cumulative, rolling,
 *              incomeByCategory, spendingByCategory (each category's net that month, on the side it fell),
 *              rent (rent paid, part of spending) }],
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
  const rentPaid = {}; // key -> rent paid out
  for (const t of transactions || []) {
    if (!t.date || !t.amount) continue;
    const r = role(t);
    if (!r || r === 'move') continue;
    const cat = flowCategory(t);
    const key = cashFlowMonthKey(t);
    if (!inWindow.has(key)) continue;
    const d = new Date(t.date);
    if (isNaN(d)) continue;
    const day = `${monthKeyFor(d)}-${String(d.getDate()).padStart(2, '0')}`;
    const perDay = ((daily[key] ||= {})[day] ||= {});
    perDay[cat] = (perDay[cat] || 0) + t.amount;
    (byCat[key] ||= {})[cat] = (byCat[key][cat] || 0) + t.amount;
    if (isRentPaid(t)) rentPaid[key] = (rentPaid[key] || 0) - t.amount;
  }

  let cumulative = 0;
  const months = monthKeys.map(key => {
    const { income, expenses, invested = 0, kept = 0 } = totals[key] || { income: 0, expenses: 0 };
    const spending = expenses;
    const net = round2(income - spending);
    const partial = key === nowKey;
    cumulative = round2(cumulative + net);
    // The categories that are money in this month (net positive), which is
    // what `income` adds up.
    const incomeByCategory = {};
    const spendingByCategory = {};
    for (const [cat, v] of Object.entries(byCat[key] || {})) {
      if (v > 0) incomeByCategory[cat] = round2(v);
      else if (v < 0) spendingByCategory[cat] = round2(-v);
    }
    return { key, income: round2(income), spending: round2(spending), net, invested: round2(invested), kept: round2(kept), over: spending > income, gap: round2(Math.max(0, spending - income)), partial, cumulative, incomeByCategory, spendingByCategory, rent: round2(Math.min(spending, rentPaid[key] || 0)) };
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

/**
 * Each month's income in buckets: base salary, commission, and everything
 * else by category. Payroll is split as the Income and Commissions pages split
 * it (lib/income splitPaychecks); the buckets add up to the month's income
 * exactly, because each is carved out of the income categories the total is
 * made of. A paycheck whose category nets below its amount that month (a
 * clawback in the same category) is scaled down to what counted.
 *
 * @param months     computeOvershot().months
 * @param paychecks  computeIncome().paychecks — [{ t, key, amount, base, commission }]
 * @returns { [key]: { base, commission, other, otherBy: [{ category, amount }] (largest first) } }
 */
export function incomeBuckets({ months, paychecks }) {
  const out = {};
  for (const m of months || []) {
    const mine = (paychecks || []).filter(p => p.key === m.key);
    let base = 0;
    let commission = 0;
    const otherBy = [];
    for (const [category, v] of Object.entries(m.incomeByCategory || {})) {
      const pcs = mine.filter(p => flowCategory(p.t || {}) === category);
      const paid = pcs.reduce((s, p) => s + p.amount, 0);
      const f = paid > 0 ? Math.min(1, v / paid) : 0;
      const b = pcs.reduce((s, p) => s + p.base, 0) * f;
      const c = pcs.reduce((s, p) => s + p.commission, 0) * f;
      base += b;
      commission += c;
      const rest = round2(v - b - c);
      if (rest > 0.005) otherBy.push({ category, amount: rest });
    }
    base = round2(base);
    commission = round2(commission);
    otherBy.sort((a, b) => b.amount - a.amount);
    out[m.key] = { base, commission, other: round2(Math.max(0, m.income - base - commission)), otherBy };
  }
  return out;
}

/**
 * The Income vs spending chart with rent taken out of both sides: each
 * month's rent comes off its spending and the same amount off its income, so
 * what's left is the money that was actually up for grabs. The gap between
 * the two doesn't move, and neither do the verdicts (over, gap, net).
 *
 * Rent comes out of base salary first, then commission, then other income.
 * In the month in progress, rent that the income so far doesn't cover comes
 * off the paychecks still expected. Next month hasn't paid rent yet, so its
 * projection loses the most recent month's rent.
 *
 * @param months      computeOvershot().months
 * @param buckets     incomeBuckets()
 * @param expected    expectedIncomeMonths()
 * @param projection  projectedMonth() or null
 * @returns the same four, adjusted; months and expected rows carry `rentOut`
 */
export function subtractRent({ months, buckets, expected, projection }) {
  // Take `amount` out of obj's keys in order; returns what couldn't be taken.
  const take = (obj, keys, amount) => {
    let left = amount;
    for (const k of keys) {
      const cut = Math.min(obj[k] || 0, left);
      obj[k] = round2((obj[k] || 0) - cut);
      left = round2(left - cut);
    }
    return left;
  };
  const outBuckets = {};
  const overflow = {}; // month key -> rent the income so far didn't cover
  const outMonths = (months || []).map(m => {
    const rent = m.rent || 0;
    const fromIncome = Math.min(rent, m.income);
    const b = buckets?.[m.key];
    if (b) {
      const nb = { ...b };
      take(nb, ['base', 'commission', 'other'], fromIncome);
      outBuckets[m.key] = nb;
    }
    overflow[m.key] = round2(rent - fromIncome);
    return { ...m, income: round2(m.income - fromIncome), spending: round2(m.spending - rent), rentOut: rent };
  });
  const current = outMonths.find(m => m.partial) || null;
  const latestRent = [...outMonths].reverse().find(m => m.rentOut > 0)?.rentOut || 0;
  const outExpected = (expected || []).map(e => {
    const isCurrent = current && e.key === current.key;
    const isNext = current && e.key > current.key && !outMonths.some(m => m.key === e.key) && e === (expected || []).find(x => x.key > current.key);
    const rent = isCurrent ? overflow[e.key] || 0 : isNext ? latestRent : 0;
    if (!rent) return e;
    const ne = { ...e };
    const left = take(ne, ['base', 'commission'], rent);
    ne.expected = round2(Math.max(0, e.expected - (rent - left)));
    ne.rentOut = isNext ? round2(rent - left) : 0;
    return ne;
  });
  const outProjection = projection && current && projection.key === current.key ? {
    ...projection,
    income: current.income,
    spending: current.spending,
    projected: round2(Math.max(0, projection.projected - current.rentOut)),
    stillDue: outExpected.find(e => e.key === current.key)?.expected ?? projection.stillDue,
  } : projection;
  return { months: outMonths, buckets: outBuckets, expected: outExpected, projection: outProjection };
}

/**
 * Expected income by month, from the Commissions tab's pay schedule
 * (commissionSchedule paySchedule: base salary twice a month, plus the
 * month-end commission at its take-home rate). A payday that has already
 * landed counts what actually came in; the rest count what's expected.
 * Set against a typical month's spending, so each month reads as a
 * surplus or a shortfall before it happens.
 *
 * Payroll only: other money in (refunds, interest, a side payment) isn't
 * on the schedule, so it isn't here.
 *
 * @param schedule         paySchedule() rows
 * @param typicalSpending  a typical complete month's spending, or null
 * @param months           how many months to return, starting with the first in the schedule
 * @returns [{ key, received, expected, base, commission, commissionPreTax, total,
 *             projected, earnedMonth, paychecks, leftOver }]
 */
export function expectedIncomeMonths({ schedule, typicalSpending = null, months = 6 }) {
  const byKey = new Map();
  for (const p of schedule || []) {
    const key = monthKeyFor(p.date);
    if (!byKey.has(key)) {
      byKey.set(key, { key, received: 0, expected: 0, base: 0, commission: 0, commissionPreTax: 0, projected: false, earnedMonth: null, paychecks: 0 });
    }
    const m = byKey.get(key);
    m.paychecks += 1;
    if (p.status === 'received') {
      m.received += p.received || 0;
    } else {
      m.expected += p.total;
      m.base += p.base;
      m.commission += p.commissionTakeHome;
    }
    if (p.kind === 'end') {
      m.commissionPreTax += p.commissionPreTax;
      m.earnedMonth = p.earnedMonth;
      m.projected = m.projected || !!p.projected;
    }
  }
  return [...byKey.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .slice(0, months)
    .map(m => {
      const total = round2(m.received + m.expected);
      return {
        ...m,
        received: round2(m.received),
        expected: round2(m.expected),
        base: round2(m.base),
        commission: round2(m.commission),
        commissionPreTax: round2(m.commissionPreTax),
        total,
        leftOver: typicalSpending == null ? null : round2(total - typicalSpending),
      };
    });
}
