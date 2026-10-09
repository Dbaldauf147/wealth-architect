import { describe, it, expect } from 'vitest';
import { buildSurplusSheets } from './surplusExport.js';

const tx = (date, amount, category, account = 'Dan checking', description = category) => ({ date, amount, category, account, description });

// March: pay 6,000; rent 2,500; dinner 400 with a 50 payback; 2,000 to Robinhood → surplus 3,150, kept 1,150.
// April: pay 6,000; rent 2,500; 5,000 to Robinhood → surplus 3,500, kept −1,500.
const ledger = [
  tx('3/01/2026', 6000, 'Paycheck'),
  tx('3/02/2026', -2500, 'Rent'),
  tx('3/05/2026', -400, 'Restaurants', 'CREDIT CARD (-1947)', 'Dinner'),
  tx('3/09/2026', 50, 'Restaurants', 'Dan checking', 'Venmo from Sam'),
  tx('3/10/2026', -2000, 'Transfer', 'Dan checking', 'Robinhood, Des:funds'),
  tx('3/10/2026', 2000, 'Transfer', 'Robinhood individual', 'Deposit'),
  tx('4/01/2026', 6000, 'Paycheck'),
  tx('4/02/2026', -2500, 'Rent'),
  tx('4/12/2026', -5000, 'Transfer', 'Dan checking', 'Robinhood, Des:funds'),
];
const months = [{ key: '2026-03', cashChange: 1100 }, { key: '2026-04', cashChange: null }];
const sheets = buildSurplusSheets({ transactions: ledger, months });
const sheet = name => sheets.find(s => s.name === name).rows;
const v = c => (c && typeof c === 'object' ? c.v : c);
const rowOf = (rows, label) => rows.find(r => v(r[0]) === label).map(v);

describe('buildSurplusSheets', () => {
  it('has the summary and the detail behind it', () => {
    expect(sheets.map(s => s.name)).toEqual(['Summary', 'Spending by category', 'Income by category', 'Invested', 'Income', 'Spending']);
  });

  it('summarises each month: surplus = invested + kept, and the gap to real cash', () => {
    const s = sheet('Summary');
    expect(rowOf(s, 'Mar 2026').slice(1, 9)).toEqual([6000, 2850, 3150, 2000, 0, 1150, 1100, -50]);
    const apr = rowOf(s, 'Apr 2026');
    expect(apr.slice(1, 9)).toEqual([6000, 2500, 3500, 5000, 0, -1500, null, null]);
    expect(apr[9]).toBe('Cash went down because more was invested than saved');
    expect(rowOf(s, 'Total').slice(1, 8)).toEqual([12000, 5350, 6650, 7000, 0, -350, 1100]);
  });

  it('lists every invested transfer from the cash side only', () => {
    const inv = sheet('Invested');
    expect(rowOf(inv, 'Total')[5]).toBe(7000);
    expect(inv.filter(r => v(r[3]) === 'Robinhood individual')).toHaveLength(0);
  });

  it('nets a refund into spending and keeps it off income', () => {
    expect(rowOf(sheet('Spending'), 'Total')[5]).toBe(5350);
    expect(sheet('Spending').some(r => v(r[2]) === 'Venmo from Sam' && v(r[5]) === -50)).toBe(true);
    expect(rowOf(sheet('Income'), 'Total')[5]).toBe(12000);
  });

  it('pivots spending by category and month, adding up to the summary', () => {
    const p = sheet('Spending by category');
    expect(rowOf(p, 'Rent').slice(1, 4)).toEqual([2500, 2500, 5000]);
    expect(rowOf(p, 'Restaurants').slice(1, 4)).toEqual([350, 0, 350]);
    expect(rowOf(p, 'Total')[3]).toBe(5350);
  });
});
