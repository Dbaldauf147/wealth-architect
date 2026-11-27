import { describe, it, expect } from 'vitest';
import { monthForKind, pendingMonthChoices, monthOptions, dateForMonth, monthForKey } from './monthFor.js';
import { applyOverrides } from './categorize.js';
import { cashFlowMonthKey } from './cashflowExport.js';
import { trendMonthKey } from './categoryDrilldown.js';

const t = (o) => ({ transactionId: 'a', date: '11/14/2026', description: 'Acme', amount: -10, category: 'Groceries', ...o });

describe('monthForKind', () => {
  it('asks about rent paid, rent received and income, and nothing else', () => {
    expect(monthForKind(t({ category: 'Rent', amount: -1500 }))).toBe('rent');
    expect(monthForKind(t({ category: 'Housing', subcategory: 'Rent', amount: -1500 }))).toBe('rent');
    expect(monthForKind(t({ category: 'Income', amount: 900, description: 'Zelle for rent' }))).toBe('rent');
    expect(monthForKind(t({ category: 'Paycheck', amount: 3000 }))).toBe('income');
    expect(monthForKind(t({ category: 'Income', amount: 3000 }))).toBe('income');
    expect(monthForKind(t({ category: 'Income', amount: -20 }))).toBe(null);
    expect(monthForKind(t({ category: 'Transfer', amount: 500 }))).toBe(null);
    expect(monthForKind(t({ amount: -10 }))).toBe(null);
    expect(monthForKind(t({ category: 'Uncategorized', amount: 3000 }))).toBe(null);
  });
  it('never asks about dividends or interest', () => {
    expect(monthForKind(t({ category: 'Income', subcategory: 'Interest', amount: 4 }))).toBe(null);
    expect(monthForKind(t({ category: 'Income', subcategory: 'Dividends', amount: 94 }))).toBe(null);
    expect(monthForKind(t({ category: 'Income', description: 'Cash dividend of $94.26 from Vug', amount: 94.26 }))).toBe(null);
    expect(monthForKind(t({ category: 'Income', description: 'Interest earned', amount: 3.1 }))).toBe(null);
    expect(monthForKind(t({ category: 'Dividends', amount: 50 }), ['Dividends'])).toBe(null);
    expect(monthForKind(t({ category: 'Paycheck', description: 'ACME PAYROLL', amount: 3000 }))).toBe('income');
  });
  it('follows the Income bucket when one is set', () => {
    expect(monthForKind(t({ category: 'Commissions', amount: 500 }), ['Commissions'])).toBe('income');
    expect(monthForKind(t({ category: 'Paycheck', amount: 500 }), ['Commissions'])).toBe(null);
  });
});

describe('pendingMonthChoices', () => {
  it('lists unanswered rent and income from the start date on, oldest first', () => {
    const txns = [
      t({ transactionId: 'old', date: '10/30/2026', category: 'Rent', amount: -1500 }),
      t({ transactionId: 'pay', date: '11/13/2026', category: 'Paycheck', amount: 3000 }),
      t({ transactionId: 'rent', date: '11/2/2026', category: 'Rent', amount: -1500 }),
      t({ transactionId: 'food' }),
      t({ transactionId: 'done', date: '11/5/2026', originalDate: '11/5/2026', category: 'Income', amount: 50 }),
    ];
    expect(pendingMonthChoices(txns).map(p => p.txn.transactionId)).toEqual(['rent', 'pay']);
  });
  it('stops asking once any month is stored, the same month included', () => {
    const pay = t({ transactionId: 'pay', date: '11/13/2026', category: 'Paycheck', amount: 3000 });
    const stored = { [monthForKey(pay)]: dateForMonth(pay, '2026-11') };
    expect(stored).toEqual({ pay: '11/13/2026' });
    const after = applyOverrides([pay], {}, {}, stored);
    expect(after[0].date).toBe('11/13/2026');
    expect(pendingMonthChoices(after)).toEqual([]);
  });
});

describe('monthOptions and dateForMonth', () => {
  it('offers the month before, the month it posted in and the month after', () => {
    const rent = t({ date: '12/30/2026', category: 'Rent', amount: -1500 });
    expect(monthOptions(rent)).toEqual([
      { key: '2026-11', own: false, counted: false },
      { key: '2026-12', own: true, counted: true },
      { key: '2027-01', own: false, counted: false },
    ]);
  });
  it('marks where late-month rent revenue is counted today', () => {
    const got = t({ date: '11/28/2026', category: 'Income', description: 'Zelle rent', amount: 900 });
    expect(monthOptions(got).find(o => o.counted).key).toBe('2026-12');
  });
  it('moves a transaction to the 1st of another month, in every report', () => {
    const rent = t({ date: '10/30/2026', category: 'Rent', amount: -1500 });
    const moved = applyOverrides([rent], {}, {}, { a: dateForMonth(rent, '2026-11') })[0];
    expect(moved.date).toBe('11/1/2026');
    expect(moved.originalDate).toBe('10/30/2026');
    expect(trendMonthKey(moved)).toBe('2026-11');
    expect(cashFlowMonthKey(moved)).toBe('2026-11');
    const pay = t({ date: '12/1/2026', category: 'Paycheck', amount: 3000 });
    const back = applyOverrides([pay], {}, {}, { a: dateForMonth(pay, '2026-11') })[0];
    expect(trendMonthKey(back)).toBe('2026-11');
    expect(cashFlowMonthKey(back)).toBe('2026-11');
  });
  it('pins late-month rent revenue to its own month when that is the answer', () => {
    const got = t({ date: '11/28/2026', category: 'Income', description: 'Zelle rent', amount: 900 });
    expect(cashFlowMonthKey(got)).toBe('2026-12');
    const kept = applyOverrides([got], {}, {}, { a: dateForMonth(got, '2026-11') })[0];
    expect(kept.date).toBe('11/1/2026');
    expect(cashFlowMonthKey(kept)).toBe('2026-11');
  });
  it('keys a transaction with no id by its original date', () => {
    const noId = t({ transactionId: '', date: '11/1/2026', originalDate: '10/30/2026', description: 'Rent', amount: -1500 });
    expect(monthForKey(noId)).toBe('10/30/2026|Rent|-1500');
  });
});
