import { describe, it, expect } from 'vitest';
import { computeCashBridge } from './cashBridge.js';
import { buildCashBridgeSheets } from './cashBridgeExport.js';

const bal = (date, account, accountNum, cls, balance) => ({ date, account, accountNum, class: cls, balance });
const tx = (date, amount, category, account, accountNum, description = category) => ({ date, amount, category, account, accountNum, description });

// The worked example from cashBridge.test.js: Feb–Mar 2026, surplus 2,750,
// position 100 → 2,210 (+2,110): −50 dividend left in the brokerage,
// −1,000 sent to Robinhood, +400 stale card dropping out, +10 unimported interest.
const balances = [
  bal('1/31/2026', 'Dan checking', 'xxxx1118', 'Asset', 1000),
  bal('2/28/2026', 'Dan checking', 'xxxx1118', 'Asset', 3500),
  bal('3/31/2026', 'Dan checking', 'xxxx1118', 'Asset', 2510),
  bal('1/31/2026', 'CREDIT CARD (-1947)', '1947', 'Liability', 500),
  bal('2/28/2026', 'CREDIT CARD (-1947)', '1947', 'Liability', 300),
  bal('3/31/2026', 'CREDIT CARD (-1947)', '1947', 'Liability', 300),
  bal('1/31/2026', 'CREDIT CARD', '7676', 'Liability', 400),
  bal('2/06/2026', 'CREDIT CARD', '7676', 'Liability', 400),
  bal('3/31/2026', 'Robinhood individual', '9179', 'Asset', 20000),
];
const ledger = [
  tx('2/15/2026', 5000, 'Paycheck', 'Dan checking', 'xxxx1118', 'ACME PAYROLL'),
  tx('2/01/2026', -2000, 'Housing', 'Dan checking', 'xxxx1118', 'Rent'),
  tx('2/10/2026', -300, 'Groceries', 'CREDIT CARD (-1947)', '1947', 'Trader Joes'),
  tx('2/20/2026', -500, 'Credit Card Payment', 'Dan checking', 'xxxx1118', 'Payment to card'),
  tx('2/20/2026', 500, 'Credit Card Payment', 'CREDIT CARD (-1947)', '1947', 'Payment thank you'),
  tx('3/05/2026', -1000, 'Investments', 'Dan checking', 'xxxx1118', 'To Robinhood'),
  tx('3/05/2026', 1000, 'Investments', 'Robinhood individual', '9179', 'From checking'),
  tx('3/10/2026', 50, 'Income', 'Robinhood individual', '9179', 'Cash dividend of $50 from Voo'),
];

const bridge = computeCashBridge({ transactions: ledger, balanceHistory: balances, from: '2026-02', to: '2026-03', today: new Date(2026, 3, 5) });
const sheets = buildCashBridgeSheets(bridge);
const rows = name => sheets.find(s => s.name === name).rows;
const v = c => (c && typeof c === 'object' ? c.v : c);
const find = (name, label) => rows(name).find(r => v(r[0]) === label)?.map(v);

describe('buildCashBridgeSheets', () => {
  it('has the walk, the months and the transactions', () => {
    expect(sheets.map(s => s.name)).toEqual(['Summary', 'By month', 'Transactions']);
  });

  it('walks from income − spending to the change in cash position', () => {
    expect(find('Summary', 'Income − spending')[1]).toBe(2750);
    expect(find('Summary', 'Change in cash position')[1]).toBe(2110);
    const investing = rows('Summary').find(r => /^Invested/.test(v(r[0]))).map(v);
    expect(investing.slice(1, 4)).toEqual([-1000, 'Took from cash', 1]);
    // Every step adds up.
    const steps = rows('Summary').slice(rows('Summary').findIndex(r => v(r[0]) === 'Income − spending'), rows('Summary').findIndex(r => v(r[0]) === 'Change in cash position'));
    expect(Math.round(steps.reduce((s, r) => s + (v(r[1]) || 0), 0))).toBe(2110);
  });

  it('repeats the walk per month with a total row', () => {
    expect(find('By month', 'Feb 2026').slice(0, 2)).toEqual(['Feb 2026', 2700]);
    const total = find('By month', 'Total');
    expect(total[1]).toBe(2750);
  });

  it('lists the transactions behind each reason, and says when a line has none', () => {
    const t = rows('Transactions').map(r => r.map(v));
    expect(t.some(r => r[3] === 'To Robinhood' && r[7] === -1000)).toBe(true);
    const unexplained = t.findIndex(r => r[0] === 'Balance changes with no matching transaction');
    expect(t[unexplained + 1][3]).toMatch(/^No transactions\. Worked out from the balances/);
  });
});
