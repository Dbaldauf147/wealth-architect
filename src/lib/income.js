/* The Income page: where money comes from, how regularly, and how it's trending.

   "Income" is a positive amount in one of the user's income categories — the
   Income bucket on the Transactions page, synced as `incomeCategories` —
   falling back to Cash Flow's own non-expense set when that's empty. Money
   moving between the user's own accounts (transfers, card payments,
   investments) is never income, even if its category sits in the bucket,
   which is titled "Income & Investments".

   Cash Flow counts every other positive amount as income too — refunds and
   credits in spending categories. Those are reported separately here as
   "refunds & credits", and the two together reconcile to Cash Flow's Income.

   Months are bucketed with cashFlowMonthKey, so rent received at the end of a
   month lands on the month it pays for, exactly as on Cash Flow.

   Pure: no React, no DOM. */

import { cashFlowMonthKey } from './cashflowExport.js';

const DAY = 86400000;
const DEFAULT_INCOME = ['paycheck', 'income', 'tax refund/payment'];
const MOVING = new Set(['transfer', 'credit card payment', 'credit card payments', 'investments', 'retirement']);
const round2 = n => Math.round(n * 100) / 100;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function monthKeyFor(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** YYYY-MM keys, `count` of them, ending at `endKey` inclusive. */
export function monthKeysEnding(endKey, count) {
  let [y, m] = endKey.split('-').map(Number);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    if (--m < 1) { m = 12; y--; }
  }
  return out;
}

/** A bank description cut down to who paid: ACH deposits carry the payer
 *  first and then coded fields — "Summit Energy Se Des:payroll, ID:CERx5369,
 *  Indn:daniel Baldauf, CO ID:x1144 Ppd" → "Summit Energy Se". */
export function payerName(description) {
  const s = String(description || '').trim()
    // "Cash dividend of $94.26 from Vug" → "Vug": the holding is the payer.
    .replace(/^cash dividend of \$?[\d,.]+ from\s+/i, '')
    // "Zelle payment from, Name, for, "memo"" → "Zelle payment from, Name".
    .replace(/,\s*for,?\s.*$/i, '');
  const cut = s.split(/\s+(?:des|id|indn|co id|ppd id|trn|ref)\s*:|\s+(?:ppd|ccd)\s*$/i)[0];
  return cut.replace(/\s+x-?X*\d{3,}\b/gi, '').replace(/\s{2,}/g, ' ').replace(/[\s,;:-]+$/, '').trim().slice(0, 48) || s.slice(0, 48) || 'Unknown';
}

// Words that say what kind of deposit it is rather than who sent it.
const GENERIC = new Set(['cash', 'dividend', 'dividends', 'of', 'from', 'the', 'received', 'interest', 'earned',
  'payment', 'deposit', 'direct', 'dep', 'credit', 'transfer', 'xfer', 'bank', 'and', 'for', 'to']);

/** The grouping key for a payer: the first few distinctive words of its name,
 *  without amounts or reference numbers that change every deposit. */
export function payerKey(description) {
  const words = payerName(description).toLowerCase()
    .replace(/\$?[\d,.]+/g, ' ')
    .replace(/[^a-z& ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !GENERIC.has(w));
  return words.slice(0, 3).join(' ') || payerName(description).toLowerCase();
}

/** How often a payer pays, from the gaps between deposits. */
export function cadenceOf(dates) {
  if (dates.length < 3) return null;
  const sorted = [...dates].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(Math.round((startOfDay(sorted[i]) - startOfDay(sorted[i - 1])) / DAY));
  const g = median(gaps);
  // Every two weeks is exactly 14 days apart; twice a month (the 15th and the
  // last day) wanders between 13 and 17, though its median can also be 14–15.
  const biweekly = gaps.filter(x => x === 14).length / gaps.length >= 0.6;
  const label = g <= 8 ? 'weekly'
    : g <= 17 ? (biweekly ? 'every two weeks' : 'twice a month')
      : g >= 26 && g <= 35 ? 'monthly'
        : g >= 80 && g <= 100 ? 'quarterly'
          : g >= 350 && g <= 380 ? 'yearly'
            : null;
  // Regular means most gaps sit near the median; otherwise it's just a guess.
  const steady = gaps.filter(x => Math.abs(x - g) <= Math.max(3, g * 0.2)).length / gaps.length >= 0.6;
  return label && steady ? { label, days: g } : { label: 'irregular', days: g };
}

/**
 * @param transactions      the ledger (already categorised by the app)
 * @param incomeCategories  Set or array of category names in the Income bucket
 * @param monthKeys         the window, oldest first; the last may be in progress
 * @param today
 */
export function computeIncome({ transactions, incomeCategories, monthKeys, today = new Date() }) {
  const chosen = [...(incomeCategories || [])].map(c => String(c).toLowerCase()).filter(c => !MOVING.has(c));
  const incomeSet = new Set(chosen.length ? chosen : DEFAULT_INCOME);
  const nowKey = monthKeyFor(today);
  const inWindow = new Set(monthKeys);
  const first = monthKeys[0];
  // The prior period is as many complete months as the window holds, ending
  // the month before it starts — so "vs prior" compares like with like.
  const completeKeys = monthKeys.filter(k => k !== nowKey).length;
  const priorKeys = first && completeKeys ? monthKeysEnding(monthKeysEnding(first, 2)[0], completeKeys) : [];
  const inPrior = new Set(priorKeys);

  const income = [];
  const credits = [];
  let priorTotal = 0;
  const yearAgo = {};  // monthKey (shifted +12) -> total, for same-month-last-year
  const allIncomeByMonth = {};
  for (const t of transactions || []) {
    const amount = Number(t.amount);
    if (!(amount > 0) || !t.date) continue;
    const cat = String(t.category || '').toLowerCase();
    if (MOVING.has(cat)) continue;
    const key = cashFlowMonthKey(t);
    if (!key) continue;
    const isIncome = incomeSet.has(cat);
    if (isIncome) {
      allIncomeByMonth[key] = (allIncomeByMonth[key] || 0) + amount;
      if (inPrior.has(key)) priorTotal += amount;
    }
    if (!inWindow.has(key)) continue;
    const date = new Date(t.date);
    if (isNaN(date)) continue;
    const row = { t, date, key, amount };
    (isIncome ? income : credits).push(row);
  }
  for (const k of monthKeys) {
    const [y, m] = k.split('-').map(Number);
    yearAgo[k] = round2(allIncomeByMonth[`${y - 1}-${String(m).padStart(2, '0')}`] || 0);
  }

  // Sources: category › subcategory.
  const sourceOf = r => {
    const cat = r.t.category || 'Income';
    return r.t.subcategory ? `${cat} › ${r.t.subcategory}` : cat;
  };
  const sourceTotals = {};
  for (const r of income) sourceTotals[sourceOf(r)] = (sourceTotals[sourceOf(r)] || 0) + r.amount;
  const sourceOrder = Object.entries(sourceTotals).sort((a, b) => b[1] - a[1]).map(([s]) => s);

  const months = monthKeys.map(key => {
    const rows = income.filter(r => r.key === key);
    const bySource = {};
    for (const r of rows) bySource[sourceOf(r)] = round2((bySource[sourceOf(r)] || 0) + r.amount);
    const creditTotal = round2(credits.filter(r => r.key === key).reduce((s, r) => s + r.amount, 0));
    const total = round2(rows.reduce((s, r) => s + r.amount, 0));
    return {
      key,
      total,
      bySource,
      credits: creditTotal,
      cashFlowIncome: round2(total + creditTotal),
      lastYear: yearAgo[key],
      partial: key === nowKey,
      count: rows.length,
    };
  });
  const complete = months.filter(m => !m.partial);

  // Payers within each source.
  const payers = {};
  for (const r of income) {
    const k = `${sourceOf(r)}|${payerKey(r.t.description)}`;
    (payers[k] ||= { source: sourceOf(r), key: payerKey(r.t.description), rows: [] }).rows.push(r);
  }
  const payerList = Object.values(payers).map(p => {
    p.rows.sort((a, b) => a.date - b.date);
    const names = {};
    for (const r of p.rows) names[payerName(r.t.description)] = (names[payerName(r.t.description)] || 0) + 1;
    const name = Object.entries(names).sort((a, b) => b[1] - a[1])[0][0];
    const cadence = cadenceOf(p.rows.map(r => r.date));
    const last = p.rows[p.rows.length - 1];
    const typical = round2(median(p.rows.slice(-6).map(r => r.amount)));
    let nextExpected = null;
    if (cadence && cadence.label !== 'irregular') {
      nextExpected = new Date(startOfDay(last.date).getTime() + cadence.days * DAY);
      // A payer that has missed two cycles has probably stopped.
      if (startOfDay(today) - nextExpected > cadence.days * DAY) nextExpected = null;
    }
    return {
      source: p.source,
      name,
      total: round2(p.rows.reduce((s, r) => s + r.amount, 0)),
      count: p.rows.length,
      last: last.date,
      lastAmount: last.amount,
      typical,
      cadence,
      nextExpected,
      accounts: [...new Set(p.rows.map(r => r.t.account).filter(Boolean))],
    };
  }).sort((a, b) => b.total - a.total);

  const total = round2(income.reduce((s, r) => s + r.amount, 0));
  const completeTotal = round2(complete.reduce((s, m) => s + m.total, 0));
  const sources = sourceOrder.map(source => {
    const mine = payerList.filter(p => p.source === source);
    const t = round2(sourceTotals[source]);
    return {
      source,
      total: t,
      share: total ? t / total : 0,
      count: mine.reduce((s, p) => s + p.count, 0),
      monthsPaid: months.filter(m => m.bySource[source]).length,
      avgPerMonth: complete.length ? round2(complete.reduce((s, m) => s + (m.bySource[source] || 0), 0) / complete.length) : 0,
      payers: mine,
    };
  });

  // The month in progress: what's arrived, and which regular payers are due.
  let current = null;
  const cur = months.find(m => m.partial);
  if (cur) {
    const [y, mo] = cur.key.split('-').map(Number);
    const monthEnd = new Date(y, mo, 0);
    const due = payerList
      .filter(p => p.nextExpected && p.nextExpected <= monthEnd && p.nextExpected >= new Date(y, mo - 1, 1))
      .map(p => ({ name: p.name, source: p.source, date: p.nextExpected, amount: p.typical }));
    const expected = round2(due.reduce((s, d) => s + d.amount, 0));
    current = { key: cur.key, received: cur.total, due, expected, projected: round2(cur.total + expected) };
  }

  const best = complete.reduce((b, m) => (!b || m.total > b.total ? m : b), null);
  const latest = complete[complete.length - 1] || null;
  const avg = complete.length ? round2(completeTotal / complete.length) : 0;

  return {
    months,
    sources,
    sourceOrder,
    payers: payerList,
    deposits: [...income].sort((a, b) => b.date - a.date).map(r => ({
      date: r.date, description: r.t.description, source: sourceOf(r), account: r.t.account, amount: r.amount,
    })),
    credits: {
      total: round2(credits.reduce((s, r) => s + r.amount, 0)),
      top: [...credits].sort((a, b) => b.amount - a.amount).slice(0, 8).map(r => ({
        date: r.date, description: r.t.description, category: r.t.category || 'Uncategorized', amount: r.amount,
      })),
      count: credits.length,
    },
    summary: {
      total,
      completeTotal,
      avgPerMonth: avg,
      completeCount: complete.length,
      prior: round2(priorTotal),
      change: priorTotal > 0 ? (completeTotal - priorTotal) / priorTotal : null,
      best: best && best.total > 0 ? { key: best.key, total: best.total } : null,
      latest: latest ? { key: latest.key, total: latest.total, vsAvg: avg ? (latest.total - avg) / avg : null, lastYear: latest.lastYear } : null,
      categories: [...incomeSet],
      usingDefaults: !chosen.length,
    },
    current,
  };
}
