/* The "Why your cash doesn't match your surplus" workbook, built from one
   computeCashBridge result (lib/cashBridge.js).

   Sheets
     Summary       the walk from income − spending to the change in the cash
                   position, one named reason per row, with what each means
     By month      the same walk for each month of the period
     Transactions  every transaction behind each reason. A reason's total and
                   its listed transactions can differ: rent timing moves a
                   month's rent in one month and out of the next, and
                   "no matching transaction" comes from balances, not a
                   transaction — the sheet says so beside each reason.

   Pure: builds rows, doesn't download. */

import { monthLabel } from './cashflowExport.js';

const T = v => ({ v, s: 'title' });
const SEC = v => ({ v, s: 'section' });
const H = v => ({ v, s: 'header' });
const HR = v => ({ v, s: 'headerRight' });
const MU = v => ({ v, s: 'muted' });
const LB = v => ({ v, s: 'labelBold' });
const M = v => ({ v: v == null ? null : Math.round(v * 100) / 100, s: 'money' });
const MB = v => ({ v: Math.round(v * 100) / 100, s: 'moneyBold' });
const MT = v => ({ v: Math.round(v * 100) / 100, s: 'moneyTotal' });
const TL = v => ({ v, s: 'totalLabel' });

const effectWord = n => (n > 0.005 ? 'Added to cash' : n < -0.005 ? 'Took from cash' : '');
const dayOf = d => (d instanceof Date ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : String(d || ''));
const keyOf = d => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : '');

const WHY_DIFFERENT = {
  timing: 'Rent that arrived late in a month counts toward the next month on Cash Flow. Only the month your cash got it is listed; the matching adjustment in the month it counts toward has no transaction of its own.',
  unexplained: 'Worked out from the balances, not from transactions: the change no transaction accounts for.',
  other: 'Worked out as whatever the named lines leave over; it has no transactions of its own.',
};

/**
 * @param bridge  a computeCashBridge result
 * @returns [{ name, rows, cols }] for downloadXlsx
 */
export function buildCashBridgeSheets(bridge) {
  const b = bridge;
  const span = b.from === b.to ? monthLabel(b.from) : `${monthLabel(b.from)} – ${monthLabel(b.to)}`;
  const shown = b.lines.filter(l => Math.abs(l.amount) >= 0.5 || l.id === 'unexplained');

  // ── Summary ──
  const summary = [
    [T(`WHY YOUR CASH DOESN’T MATCH YOUR SURPLUS — ${span}`)],
    [MU('Walks from income − spending (as on Cash Flow) to the change in your cash position (cash on hand minus what’s owed on cards, from Balance History), one named reason at a time.')],
    [],
    [SEC('Cash position'), SEC('Cash'), SEC('Owed on cards'), SEC('Position'), SEC('As of')],
    [`Start (end of ${monthLabel(b.start.key)})`, M(b.start.cash), M(b.start.debt), MB(b.start.net), dayOf(b.start.asOf)],
    [`End (end of ${monthLabel(b.end.key)})`, M(b.end.cash), M(b.end.debt), MB(b.end.net), dayOf(b.end.asOf)],
    [],
    [H('Step'), HR('Amount'), H('Effect'), HR('Transactions'), H('What it means')],
    [LB('Income − spending'), MB(b.surplus), '', '', `As on Cash Flow: ${Math.round(b.income).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} in, ${Math.round(b.spending).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} out.`],
  ];
  for (const l of shown) summary.push([l.label, M(l.amount), effectWord(l.amount), l.count || '', l.hint]);
  if (b.internal?.count) {
    summary.push(['Moves between your own accounts', M(0), 'Cancel out', b.internal.count, `Card payments and transfers between two counted accounts, ${Math.round(b.internal.volume).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} in all, paired up — they move money without changing the position.`]);
  }
  summary.push([TL('Change in cash position'), MT(b.actualChange), effectWord(b.actualChange), '', 'Income − spending plus every line above.']);
  summary.push([]);
  summary.push([MU(`Income − spending was ${Math.round(b.surplus).toLocaleString()}; the cash position changed ${Math.round(b.actualChange).toLocaleString()}; difference ${Math.round(b.actualChange - b.surplus).toLocaleString()}.`)]);
  for (const o of b.overlaps || []) {
    summary.push([MU(`Possible double count: ${o.old} sat at ${o.balance.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} owed from ${dayOf(o.frozenSince)} and stopped updating ${dayOf(o.lastUpdate)}, while ${o.replacedBy.join(', ')} started. If it was replaced, that balance was counted twice until ${dayOf(o.droppedOut)}.`)]);
  }

  // ── By month ──
  const monthLines = shown.filter(l => b.months.some(m => Math.abs(m.lines[l.id] || 0) >= 0.5));
  const byMonth = [
    [T(`BY MONTH — ${span}`)],
    [MU('Each row is the same walk for one month: income − spending, plus each reason, equals the change in the cash position.')],
    [],
    [H('Month'), HR('Income − spending'), ...monthLines.map(l => HR(l.label)), HR('Cash position change'), HR('Difference'), H('Biggest reason')],
  ];
  for (const m of b.months) {
    const top = m.top ? b.lines.find(l => l.id === m.top)?.label || m.top : '';
    byMonth.push([monthLabel(m.key), M(m.surplus), ...monthLines.map(l => M(m.lines[l.id] || 0)), M(m.actual), M(m.gap), top]);
  }
  const col = f => b.months.reduce((s, m) => s + (f(m) || 0), 0);
  byMonth.push([TL('Total'), MT(col(m => m.surplus)), ...monthLines.map(l => MT(col(m => m.lines[l.id]))), MT(col(m => m.actual)), MT(col(m => m.gap)), '']);

  // ── Transactions ──
  const tx = [
    [T(`TRANSACTIONS BEHIND EACH REASON — ${span}`)],
    [MU('“Effect on cash” is how the transaction moved the cash position relative to income − spending: positive added to cash, negative took from it.')],
    [],
    [H('Reason'), H('Date'), H('Month'), H('Description'), H('Account'), H('Category'), HR('Amount'), HR('Effect on cash')],
  ];
  for (const l of shown) {
    const rows = l.all || l.items || [];
    const listed = rows.reduce((s, r) => s + (r.effect || 0), 0);
    tx.push([SEC(l.label), SEC(''), SEC(''), SEC(''), SEC(''), SEC(''), SEC(''), { v: Math.round(l.amount * 100) / 100, s: 'moneyBold' }]);
    for (const r of rows) {
      tx.push(['', dayOf(r.date), monthLabel(keyOf(r.date)), r.description || '', r.account || '', r.category || '', M(r.amount), M(r.effect)]);
    }
    if (!rows.length || Math.abs(listed - l.amount) >= 0.5) {
      const why = WHY_DIFFERENT[l.id] || '';
      tx.push(['', '', '', MU(rows.length ? `Listed transactions add to ${Math.round(listed).toLocaleString()}; the line is ${Math.round(l.amount).toLocaleString()}. ${why}` : `No transactions. ${why}`)]);
    }
    tx.push([]);
  }

  return [
    { name: 'Summary', rows: summary, cols: [44, 14, 15, 13, 90] },
    { name: 'By month', rows: byMonth, cols: [12, 16, ...monthLines.map(() => 18), 18, 14, 34] },
    { name: 'Transactions', rows: tx, cols: [36, 11, 10, 48, 26, 20, 13, 14] },
  ];
}
