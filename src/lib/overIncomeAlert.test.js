import { describe, it, expect } from 'vitest';
import { projectedMonth, currentMonthProjection, renderOverIncomeEmail } from './overIncomeAlert.js';

const tx = (date, amount, category, description = category) => ({ date, amount, category, description });

describe('projectedMonth', () => {
  const month = { key: '2026-11', income: 3000, spending: 7000, partial: true };
  const expected = [
    { key: '2026-11', received: 3000, expected: 3600, total: 6600 },
    { key: '2026-12', received: 0, expected: 6300, total: 6300 },
  ];

  it('adds the paychecks still due to what has come in', () => {
    const p = projectedMonth({ month, expected });
    expect(p).toMatchObject({ key: '2026-11', income: 3000, stillDue: 3600, projected: 6600, over: true, gap: 400 });
  });

  it('is under while spending is below the projection', () => {
    expect(projectedMonth({ month: { ...month, spending: 6600 }, expected })).toMatchObject({ over: false, gap: 0 });
  });

  it('falls back to income so far without a schedule row for the month', () => {
    expect(projectedMonth({ month, expected: [expected[1]] })).toMatchObject({ stillDue: 0, projected: 3000, hasSchedule: false });
  });

  it('is null without a month in progress', () => {
    expect(projectedMonth({ month: null, expected })).toBeNull();
  });
});

describe('currentMonthProjection', () => {
  // Paid 3,000 mid-month and 3,000 at month-end, Jul–Oct. November is in
  // progress on the 10th: the mid-month check hasn't landed, 7,000 spent.
  function ledger() {
    const out = [];
    for (const m of ['07', '08', '09', '10']) {
      out.push(tx(`${m}/14/2026`, 3000, 'Paycheck', 'ACME PAYROLL'));
      out.push(tx(`${m}/28/2026`, 3000, 'Paycheck', 'ACME PAYROLL'));
      out.push(tx(`${m}/02/2026`, -4000, 'Housing', 'Rent'));
    }
    out.push(tx('11/02/2026', -4000, 'Housing', 'Rent'));
    out.push(tx('11/05/2026', -3000, 'Travel'));
    out.push(tx('11/06/2026', -9000, 'Transfer'));
    return out;
  }
  const today = new Date(2026, 10, 10, 12);

  it('projects this month from the pay schedule and flags spending past it', () => {
    const p = currentMonthProjection({ transactions: ledger(), incomeCategories: [], commissions: [], today });
    expect(p.key).toBe('2026-11');
    expect(p.income).toBe(0);
    expect(p.spending).toBe(7000);
    expect(p.stillDue).toBe(6000);
    expect(p.projected).toBe(6000);
    expect(p.over).toBe(true);
    expect(p.gap).toBe(1000);
    expect(p.paychecksDue.map(d => d.kind)).toEqual(['mid', 'end']);
  });

  it('is not over when spending is within the projection', () => {
    const txns = ledger().filter(t => t.category !== 'Travel');
    expect(currentMonthProjection({ transactions: txns, incomeCategories: [], commissions: [], today }).over).toBe(false);
  });

  it('counts a paycheck that has landed once, not again as still due', () => {
    const txns = [...ledger(), tx('11/09/2026', 3000, 'Paycheck', 'ACME PAYROLL')];
    const p = currentMonthProjection({ transactions: txns, incomeCategories: [], commissions: [], today });
    expect(p.income).toBe(3000);
    expect(p.stillDue).toBe(3000);
    expect(p.projected).toBe(6000);
  });

  it('is null without paychecks to build a schedule from', () => {
    const txns = ledger().filter(t => t.category !== 'Paycheck');
    expect(currentMonthProjection({ transactions: txns, incomeCategories: [], commissions: [], today })).toBeNull();
  });
});

describe('renderOverIncomeEmail', () => {
  it('names the month, the gap and the paychecks still due', () => {
    const { subject, html } = renderOverIncomeEmail({
      key: '2026-11', income: 0, stillDue: 6000, projected: 6000, spending: 7000, gap: 1000,
      paychecksDue: [{ date: new Date(2026, 10, 13), total: 3000, kind: 'mid' }],
    }, { siteUrl: 'https://example.test', today: new Date(2026, 10, 10) });
    expect(subject).toBe('Spending passed November 2026\'s expected income — over by $1,000');
    expect(html).toContain('20 days of the month left');
    expect(html).toContain('Nov 13 $3,000');
    expect(html).toContain('https://example.test/#overshot');
  });
});
