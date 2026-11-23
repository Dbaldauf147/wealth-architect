import { describe, it, expect } from 'vitest';
import { monthOutlook, topRows } from './monthOutlook.js';

const tx = (date, amount, category, description = category) => ({ date, amount, category, description, account: 'Checking' });
const PAY = 'Summit Energy Se Des:payroll, ID:CERx5369 Ppd';

// Jul–Oct complete, November in progress on the 10th.
// Paid 2,664 on the 15th and 2,664 + 1,000 commission at month-end; rent
// 5,500 out and 2,400 in on the 2nd; groceries 300 on the 5th and the 20th;
// October also had a 900 trip.
function ledger() {
  const out = [];
  for (const m of [7, 8, 9, 10, 11]) {
    out.push(tx(`${m}/2/2026`, -5500, 'Rent', 'Zelle payment to, Landlord, for, "rent"'));
    out.push(tx(`${m}/2/2026`, 2400, 'Rent', 'Zelle payment from, Roommate, for, "rent"'));
    out.push(tx(`${m}/5/2026`, -300, 'Groceries'));
    if (m === 11) continue;
    out.push(tx(`${m}/15/2026`, 2664, 'Paycheck', PAY));
    out.push(tx(`${m}/20/2026`, -300, 'Groceries'));
    out.push(tx(`${m}/30/2026`, 3664, 'Paycheck', PAY));
  }
  out.push(tx('10/22/2026', -900, 'Travel'));
  out.push(tx('11/4/2026', -9000, 'Transfer'));
  return out;
}
const today = new Date(2026, 10, 10);
const args = { transactions: ledger(), incomeCategories: ['Paycheck', 'Income'], commissions: [], today };
const row = (side, name) => side.rows.find(r => r.name === name);

describe('monthOutlook — the month in progress', () => {
  const o = monthOutlook(args);

  it('adds the paychecks still due to what has come in', () => {
    expect(o.status).toBe('current');
    expect(o.income.actual).toBe(2400);
    expect(row(o.income, 'Base salary')).toMatchObject({ actual: 0, projected: 5328 });
    expect(row(o.income, 'Rent received')).toMatchObject({ actual: 2400, projected: 2400 });
    expect(o.income.projected).toBe(5328 + 2400);
    expect(o.stillDue).toBe(5328);
  });

  it('adds each category’s usual rest-of-month to what is spent', () => {
    expect(o.spending.actual).toBe(5800);
    expect(row(o.spending, 'Rent')).toMatchObject({ actual: 5500, projected: 5500 });
    expect(row(o.spending, 'Groceries')).toMatchObject({ actual: 300, projected: 600 });
    expect(row(o.spending, 'Travel')).toMatchObject({ actual: 0, projected: 300 });
    expect(o.spending.projected).toBe(5500 + 600 + 300);
    expect(o.net.projected).toBe(7728 - 6400);
  });

  it('leaves money moving out of both sides', () => {
    expect(o.spending.rows.map(r => r.name)).not.toContain('Transfer');
  });
});

describe('monthOutlook — other months', () => {
  it('sets a finished month against what was expected going in', () => {
    const o = monthOutlook({ ...args, key: '2026-10' });
    expect(o.status).toBe('past');
    expect(o.income.actual).toBe(2664 + 3664 + 2400);
    expect(row(o.income, 'Base salary')).toMatchObject({ actual: 5328, projected: 5328 });
    expect(row(o.income, 'Commission')).toMatchObject({ actual: 1000, projected: 0 });
    expect(row(o.income, 'Rent received')).toMatchObject({ actual: 2400, projected: 2400 });
    expect(o.basis).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(o.spending.actual).toBe(5500 + 600 + 900);
    expect(o.spending.projected).toBe(5500 + 600);
    expect(row(o.spending, 'Travel')).toMatchObject({ actual: 900, projected: 0 });
  });

  it('projects next month from the pay schedule and a typical month', () => {
    const o = monthOutlook({ ...args, key: '2026-12' });
    expect(o.status).toBe('next');
    expect(o.income.actual).toBe(0);
    expect(row(o.income, 'Rent received')).toMatchObject({ actual: 0, projected: 2400 });
    expect(o.income.projected).toBe(5328 + 2400);
    expect(o.basis).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(o.spending.projected).toBe(5500 + 600 + 300);
  });

  it('has nothing to say about months it cannot see', () => {
    expect(monthOutlook({ ...args, key: '2027-03' })).toBeNull();
    expect(monthOutlook({ ...args, key: '2025-01' })).toBeNull();
    expect(monthOutlook({ ...args, transactions: [] })).toBeNull();
  });

  it('says so when the first month has nothing before it to go by', () => {
    const o = monthOutlook({ ...args, key: '2026-07' });
    expect(o.spending.projected).toBeNull();
    expect(o.net.projected).toBeNull();
  });
});

describe('topRows', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map((name, i) => ({ name, actual: 10 - i, projected: 20 - i }));
  it('folds the tail into one row', () => {
    const t = topRows(rows, 2);
    expect(t.map(r => r.name)).toEqual(['a', 'b', 'Everything else']);
    expect(t[2]).toMatchObject({ actual: 8 + 7 + 6, projected: 18 + 17 + 16, other: true });
  });
  it('keeps a single leftover as itself', () => {
    expect(topRows(rows, 4).map(r => r.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('monthOutlook — other income', () => {
  it('expects the usual rent before it arrives, and not a one-off again', () => {
    const t = ledger().filter(x => !(x.date === '11/2/2026' && x.amount > 0));
    t.push(tx('9/12/2026', 800, 'Tax Refund/Payment', 'NY State tax refund'));
    const o = monthOutlook({ ...args, transactions: t });
    expect(row(o.income, 'Rent received')).toMatchObject({ actual: 0, projected: 2400 });
    expect(row(o.income, 'Tax Refund/Payment')).toBeUndefined();
    expect(o.income.projected).toBe(5328 + 2400);
  });
});
