/* The "Where the surplus went" workbook: the monthly summary the chart shows,
   and every transaction behind each number.

   Sheets
     Summary              per month: income, spending, surplus, invested (and
                          the retirement part), kept as cash, what the cash
                          position actually did, and the gap between the two
     Spending by category category × month, net of refunds
     Income by category   category × month
     Invested             each move between cash and investments
     Income / Spending    each transaction behind those columns; a refund sits
                          on Spending as a negative, netting its category down

   Everything comes from cashFlowBreakdown, so the sheets add up to exactly
   what Cash Flow and Overshot show. Pure: builds rows, doesn't download. */

import { cashFlowBreakdown, cashFlowMonthKey, investingLeg, monthLabel } from './cashflowExport.js';

const T = v => ({ v, s: 'title' });
const H = v => ({ v, s: 'header' });
const HR = v => ({ v, s: 'headerRight' });
const MU = v => ({ v, s: 'muted' });
const M = v => ({ v: v == null ? null : Math.round(v * 100) / 100, s: 'money' });
const MT = v => ({ v: Math.round(v * 100) / 100, s: 'moneyTotal' });
const TL = v => ({ v, s: 'totalLabel' });

const byDate = (a, b) => new Date(a.date) - new Date(b.date);

function detailSheet(title, note, rows, amountOf, amountHeader) {
  const out = [[T(title)], [MU(note)], [], [H('Date'), H('Month'), H('Description'), H('Account'), H('Category'), HR(amountHeader)]];
  let total = 0;
  for (const t of [...rows].sort(byDate)) {
    const amt = amountOf(t);
    total += amt;
    out.push([t.date, monthLabel(cashFlowMonthKey(t)), t.description || t.fullDescription || '', t.account || '', t.category || 'Uncategorized', M(amt)]);
  }
  out.push([TL('Total'), '', '', '', '', MT(total)]);
  return { rows: out, cols: [12, 10, 48, 26, 20, 14] };
}

function pivotSheet(title, note, keys, rows, amountOf) {
  const byCat = {};
  for (const t of rows) {
    const cat = t.category || 'Uncategorized';
    const k = cashFlowMonthKey(t);
    (byCat[cat] ||= {})[k] = (byCat[cat][k] || 0) + amountOf(t);
  }
  const cats = Object.keys(byCat)
    .map(cat => ({ cat, total: keys.reduce((s, k) => s + (byCat[cat][k] || 0), 0) }))
    .sort((a, b) => b.total - a.total);
  const out = [[T(title)], [MU(note)], [], [H('Category'), ...keys.map(k => HR(monthLabel(k))), HR('Total'), HR('Monthly avg')]];
  for (const { cat, total } of cats) {
    out.push([cat, ...keys.map(k => M(byCat[cat][k] || 0)), MT(total), M(total / keys.length)]);
  }
  const col = k => cats.reduce((s, c) => s + (byCat[c.cat][k] || 0), 0);
  const grand = keys.reduce((s, k) => s + col(k), 0);
  out.push([TL('Total'), ...keys.map(k => MT(col(k))), MT(grand), MT(grand / keys.length)]);
  return { rows: out, cols: [26, ...keys.map(() => 12), 13, 13] };
}

/**
 * @param transactions  the ledger (as the page shows it)
 * @param months        the chart's months: [{ key, cashChange (number | null), partial? }], oldest first
 * @returns [{ name, rows, cols }] for downloadXlsx
 */
export function buildSurplusSheets({ transactions, months }) {
  const keys = months.map(m => m.key);
  const { totals, role } = cashFlowBreakdown(transactions, keys);
  const inWindow = (transactions || []).filter(t => role(t) != null);
  const income = inWindow.filter(t => role(t) === 'income');
  const spending = inWindow.filter(t => role(t) === 'expense');
  const invested = inWindow.filter(t => investingLeg(t));
  const span = `${monthLabel(keys[0])} – ${monthLabel(keys[keys.length - 1])}`;

  // Summary
  const summary = [
    [T(`WHERE THE SURPLUS WENT — ${span}`)],
    [MU('Surplus = income − spending (refunds netted into their category; transfers, card payments and investing left out).')],
    [MU('Surplus = invested + kept as cash. "Cash actually changed" is cash on hand minus card balances, from Balance History; the gap is timing, accounts and the other reasons on the Overshot cash report.')],
    [],
    [H('Month'), HR('Income'), HR('Spending'), HR('Surplus'), HR('Invested'), HR('of which retirement'), HR('Kept as cash'), HR('Cash actually changed'), HR('Gap (cash − kept)'), H('Note')],
  ];
  const sum = { income: 0, expenses: 0, net: 0, invested: 0, retirement: 0, kept: 0, cash: 0, gap: 0 };
  for (const m of months) {
    const t = totals[m.key];
    const gap = m.cashChange == null ? null : m.cashChange - t.kept;
    sum.income += t.income; sum.expenses += t.expenses; sum.net += t.net;
    sum.invested += t.invested; sum.retirement += t.retirement; sum.kept += t.kept;
    if (m.cashChange != null) { sum.cash += m.cashChange; sum.gap += gap; }
    const note = [
      m.partial ? 'In progress' : '',
      t.invested > 0.5 && t.kept < -0.5 ? 'Cash went down because more was invested than saved' : '',
      t.invested < -0.5 ? 'Money taken out of investments' : '',
    ].filter(Boolean).join('; ');
    summary.push([monthLabel(m.key), M(t.income), M(t.expenses), M(t.net), M(t.invested), M(t.retirement), M(t.kept), M(m.cashChange), M(gap), note]);
  }
  const anyCash = months.some(m => m.cashChange != null);
  summary.push([TL('Total'), MT(sum.income), MT(sum.expenses), MT(sum.net), MT(sum.invested), MT(sum.retirement), MT(sum.kept), anyCash ? MT(sum.cash) : '', anyCash ? MT(sum.gap) : '']);
  summary.push([TL('Monthly average'), MT(sum.income / keys.length), MT(sum.expenses / keys.length), MT(sum.net / keys.length), MT(sum.invested / keys.length), MT(sum.retirement / keys.length), MT(sum.kept / keys.length)]);

  return [
    { name: 'Summary', rows: summary, cols: [14, 13, 13, 13, 13, 13, 13, 15, 15, 48] },
    { name: 'Spending by category', ...pivotSheet(`SPENDING BY CATEGORY — ${span}`, 'Net of refunds: a refund lowers its category in the month it landed.', keys, spending, t => -t.amount) },
    { name: 'Income by category', ...pivotSheet(`INCOME BY CATEGORY — ${span}`, 'Money in that isn’t a refund of spending, a transfer, or money back from investments.', keys, income, t => t.amount) },
    { name: 'Invested', ...detailSheet(`INVESTED — ${span}`, 'Money between your cash accounts and investments. Positive = sent to investments; negative = taken back out.', invested, t => investingLeg(t).invested, 'Invested') },
    { name: 'Income', ...detailSheet(`INCOME — ${span}`, 'Every transaction counted as income.', income, t => t.amount, 'Amount') },
    { name: 'Spending', ...detailSheet(`SPENDING — ${span}`, 'Every transaction counted as spending. Refunds show as negatives, netting their category down.', spending, t => -t.amount, 'Spent') },
  ];
}
