import { describe, it, expect } from 'vitest';
import { searchTransactions, summarizeSearch } from './searchSummary.js';

// A fixed "now" so the rolling windows are assertable: Mon 2026-08-31, noon.
const NOW = new Date(2026, 7, 31, 12).getTime();

const txns = [
  { transactionId: '1', date: '2026-08-20', description: 'WHOLE FOODS MKT 10234 NY', category: 'Groceries', account: 'Chase', amount: -84.20 },
  { transactionId: '2', date: '2026-08-02', description: 'WHOLE FOODS MKT 887 BROOKLYN NY', category: 'Groceries', account: 'Chase', amount: -55.80 },
  { transactionId: '3', date: '2026-06-15', description: 'WHOLE FOODS MKT 10234 NY', category: 'Groceries', account: 'Chase', amount: -40.00 },
  { transactionId: '4', date: '2026-08-18', description: 'Delta Air Lines', category: 'Travel', account: 'Amex', amount: -620.00 },
  { transactionId: '5', date: '2026-08-19', description: 'Delta Air Lines refund', category: 'Travel', account: 'Amex', amount: 120.00 },
  { transactionId: '6', date: '2026-08-10', description: 'Payroll ACME CORP', category: 'Income', account: 'Chase', amount: 5000.00 },
  { transactionId: '7', date: '2026-08-11', description: 'Transfer to savings', category: 'Transfer', account: 'Chase', amount: -2000.00 },
  { transactionId: '8', date: '2026-08-12', description: 'Corner Deli', category: '', account: 'Chase', amount: -12.00 },
];

describe('searchTransactions', () => {
  it('matches on description, category and account alike', () => {
    const ids = q => searchTransactions({ transactions: txns, query: q, now: NOW }).map(t => t.transactionId);
    expect(ids('whole foods')).toEqual(['1', '2', '3']);
    expect(ids('groceries')).toEqual(['1', '2', '3']);
    expect(ids('amex')).toEqual(['4', '5']);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    const found = searchTransactions({ transactions: txns, query: '  DELTA  ', now: NOW });
    expect(found.map(t => t.transactionId)).toEqual(['4', '5']);
  });

  it('honours the rolling window, and returns everything without one', () => {
    const within30 = searchTransactions({ transactions: txns, query: 'whole foods', days: 30, now: NOW });
    expect(within30.map(t => t.transactionId)).toEqual(['1', '2']);
    const allTime = searchTransactions({ transactions: txns, query: 'whole foods', days: null, now: NOW });
    expect(allTime).toHaveLength(3);
  });

  it('returns everything when the query is empty', () => {
    expect(searchTransactions({ transactions: txns, now: NOW })).toHaveLength(txns.length);
  });
});

describe('summarizeSearch', () => {
  it('groups by category, largest first, and totals the bars into spend', () => {
    const s = summarizeSearch({ transactions: txns, days: 30, now: NOW });
    expect(s.bars.map(b => b.label)).toEqual(['Travel', 'Groceries', 'Uncategorized']);
    // Travel nets the $620 charge against the $120 refund.
    expect(s.bars[0].amount).toBe(500);
    expect(s.bars[1].amount).toBeCloseTo(140.0, 2);
    expect(s.spend).toBeCloseTo(652.0, 2);
  });

  it('collapses one merchant\'s store numbers into a single bar', () => {
    const s = summarizeSearch({ transactions: txns, query: 'whole foods', groupBy: 'merchant', now: NOW });
    expect(s.bars).toHaveLength(1);
    expect(s.bars[0].count).toBe(3);
    expect(s.bars[0].amount).toBeCloseTo(180.0, 2);
    // The description seen most often wins the label.
    expect(s.bars[0].label).toBe('WHOLE FOODS MKT 10234 NY');
  });

  it('holds transfers, income and investments out of the chart and reports what it withheld', () => {
    const s = summarizeSearch({ transactions: txns, days: 30, now: NOW });
    expect(s.bars.map(b => b.category)).not.toContain('Transfer');
    expect(s.bars.map(b => b.category)).not.toContain('Income');
    expect(s.hiddenSpend).toBe(2000);
  });

  it('puts them back when asked', () => {
    const s = summarizeSearch({ transactions: txns, days: 30, includeNonSpend: true, now: NOW });
    expect(s.bars[0].label).toBe('Transfer');
    expect(s.bars[0].amount).toBe(2000);
    expect(s.hiddenSpend).toBe(0);
    // A paycheck nets positive, so it is still no one's bar.
    expect(s.bars.map(b => b.category)).not.toContain('Income');
  });

  it('counts money in separately from spending', () => {
    const s = summarizeSearch({ transactions: txns, days: 30, now: NOW });
    expect(s.income).toBe(5120); // the paycheck and the Delta refund
  });

  it('gives a group that nets positive no bar', () => {
    const refundOnly = [
      { transactionId: 'r1', date: '2026-08-20', description: 'Delta Air Lines', category: 'Travel', amount: -100 },
      { transactionId: 'r2', date: '2026-08-21', description: 'Delta Air Lines', category: 'Travel', amount: 250 },
    ];
    const s = summarizeSearch({ transactions: refundOnly, days: 30, now: NOW });
    expect(s.bars).toEqual([]);
    expect(s.spend).toBe(0);
    expect(s.max).toBe(0);
  });

  it('files a blank category under Uncategorized', () => {
    const s = summarizeSearch({ transactions: txns, query: 'deli', now: NOW });
    expect(s.bars[0]).toMatchObject({ label: 'Uncategorized', amount: 12 });
  });

  it('survives an empty ledger without dividing by zero', () => {
    const s = summarizeSearch({ transactions: [], now: NOW });
    expect(s).toMatchObject({ bars: [], max: 0, spend: 0, income: 0, hiddenSpend: 0 });
    expect(s.matches).toEqual([]);
  });
});
