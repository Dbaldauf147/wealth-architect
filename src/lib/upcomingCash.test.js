import { describe, it, expect } from 'vitest';
import { detectPaychecks, projectPaychecks, detectCashBills, planUpcomingCash, businessDayOnOrBefore, paycheckDetail } from './upcomingCash.js';

const d = (y, m, day) => new Date(y, m - 1, day);
const tx = (date, amount, category, description, account = 'Dan checking') =>
  ({ date: `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`, amount, category, description, account });
const PAY = 'Summit Energy Se Des:payroll, ID:CERx5369, Indn:daniel Baldauf, CO ID:x1144 Ppd';

// Paid the 15th (always $3,314) and the month end (varies), Apr–Sep 2026.
// Weekend days are paid the Friday before: Aug 15 (Sat) → 14th, May 31 (Sun) → 29th.
function ledger() {
  const mid = [d(2026, 4, 15), d(2026, 5, 15), d(2026, 6, 15), d(2026, 7, 15), d(2026, 8, 14), d(2026, 9, 15)];
  const end = [[d(2026, 4, 30), 2663.12], [d(2026, 5, 29), 3922.07], [d(2026, 6, 30), 2900], [d(2026, 7, 31), 3100], [d(2026, 8, 31), 2950], [d(2026, 9, 30), 3050]];
  return [
    ...mid.map(x => tx(x, 3314, 'Paycheck', PAY)),
    ...end.map(([x, a]) => tx(x, a, 'Paycheck', PAY)),
    // Rent by Zelle on the 1st, already paid in October.
    ...[7, 8, 9, 10].map(m => tx(d(2026, m, 1), -5350, 'Rent', 'Zelle Scheduled payment to, Ye Tian Landlord, for, "rent"')),
    // Not paychecks / not bills.
    ...[6, 7, 8, 9].map(m => tx(d(2026, m, 29), 27.1, 'Income', 'Catalyst Systematic High Income a', 'Individual ...644')),
    ...[6, 7, 8, 9].map(m => tx(d(2026, m, 12), -6000, 'Transfer', 'Chase Credit Crd Des:autopay')),
    tx(d(2026, 9, 20), -84.12, 'Groceries', 'Trader Joes'),
  ];
}
const today = d(2026, 10, 9);

describe('detectPaychecks', () => {
  const [p] = detectPaychecks({ transactions: ledger(), incomeCategories: ['Paycheck', 'Income'], today });

  it('finds one payer paid twice a month, as two separate deposits', () => {
    expect(detectPaychecks({ transactions: ledger(), incomeCategories: ['Paycheck', 'Income'], today })).toHaveLength(1);
    expect(p.payer).toBe('Summit Energy Se');
    expect(p.cadence).toBe('twice a month');
    expect(p.slots.map(s => s.label)).toEqual(['mid-month', 'end of month']);
  });

  it('knows the mid-month one is always the same and the month-end one varies', () => {
    const [mid, end] = p.slots;
    expect(mid).toMatchObject({ day: 15, amount: 3314 });
    expect(mid.steady.same).toBe(true);
    expect(end.lastDay).toBe(true);
    expect(end.steady.same).toBe(false);
    expect(end.amount).toBe(3050);   // median of the last three: 3100, 2950, 3050
  });
});

describe('paycheck amounts that change', () => {
  // The real shape: the 15th was $2,852.35 to the cent through June, then
  // dropped and wobbles a little; the month end has a July bonus.
  const mid = [[d(2026, 2, 13), 2852.35], [d(2026, 3, 13), 2852.34], [d(2026, 4, 15), 2852.35], [d(2026, 5, 15), 2852.35], [d(2026, 6, 15), 2852.34],
    [d(2026, 7, 15), 2696.38], [d(2026, 8, 14), 2705.01], [d(2026, 9, 15), 2663.83]];
  const end = [[d(2026, 2, 27), 3937.56], [d(2026, 3, 31), 3999.5], [d(2026, 4, 30), 3999.49], [d(2026, 5, 29), 3314.12], [d(2026, 6, 30), 4013.82],
    [d(2026, 7, 31), 7573.87], [d(2026, 8, 31), 4076.34], [d(2026, 9, 30), 3922.07]];
  const [p] = detectPaychecks({ transactions: [...mid, ...end].map(([x, a]) => tx(x, a, 'Paycheck', PAY)), incomeCategories: ['Paycheck'], today });
  const [m, e] = p.slots;

  it('uses the new level, and says what it used to be', () => {
    expect(m.amount).toBe(2696.38);
    expect(m.steady).toMatchObject({ same: false, close: true, lo: 2663.83, hi: 2705.01 });
    expect(m.changedFrom).toMatchObject({ amount: 2852.34, count: 3 });   // Apr–Jun: detection looks back ~200 days
    expect(m.changedFrom.until).toEqual(d(2026, 6, 15));
    expect(paycheckDetail(m)).toBe('mid-month · within $41.18 the last 3 times ($2,663.83–$2,705.01). It was $2,852.34 every time until Jun 15');
  });

  it('leaves a bonus out of the usual month-end amount, and says so', () => {
    expect(e.amount).toBe(4013.82);   // the last three regular ones: Jun, Aug, Sep (July's bonus left out)
    expect(e.steady).toMatchObject({ lo: 3922.07, hi: 4076.34 });
    expect(e.outliers).toEqual([{ date: d(2026, 7, 31), amount: 7573.87 }]);
    expect(paycheckDetail(e)).toMatch(/Left out as a one-off: \$7,574 on Jul 31/);
  });
});

describe('projectPaychecks', () => {
  const paychecks = detectPaychecks({ transactions: ledger(), incomeCategories: ['Paycheck'], today });
  it('projects each deposit to its next business day, skipping ones already paid', () => {
    const next = projectPaychecks(paychecks, today, d(2026, 11, 20));
    expect(next.map(x => [x.date, x.amount])).toEqual([
      [d(2026, 10, 15), 3314],   // Thursday
      [d(2026, 10, 30), 3050],   // Oct 31 is a Saturday
      [d(2026, 11, 13), 3314],   // Nov 15 is a Sunday
    ]);
  });
  it('steps every-two-weeks pay by calendar days, across the clocks changing', () => {
    const t = [d(2026, 8, 21), d(2026, 9, 4), d(2026, 9, 18), d(2026, 10, 2)].map(x => tx(x, 2000, 'Paycheck', 'ACME PAYROLL'));
    const p = detectPaychecks({ transactions: t, incomeCategories: ['Paycheck'], today });
    expect(p[0].cadence).toBe('every two weeks');
    expect(projectPaychecks(p, today, d(2026, 11, 20)).map(x => x.date))
      .toEqual([d(2026, 10, 16), d(2026, 10, 30), d(2026, 11, 13)]);
  });
  it('moves a weekend to the Friday before', () => {
    expect(businessDayOnOrBefore(d(2026, 8, 15))).toEqual(d(2026, 8, 14));
    expect(businessDayOnOrBefore(d(2026, 10, 15))).toEqual(d(2026, 10, 15));
  });
});

describe('detectCashBills', () => {
  it('finds a steady monthly bill paid from cash, not card payments or one-offs', () => {
    const bills = detectCashBills({ transactions: ledger(), isCashAccount: t => t.account === 'Dan checking', today });
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({ day: 1, amount: 5350, category: 'Rent' });
  });
});

describe('planUpcomingCash', () => {
  const paychecks = detectPaychecks({ transactions: ledger(), incomeCategories: ['Paycheck'], today });
  const bills = detectCashBills({ transactions: ledger(), isCashAccount: t => t.account === 'Dan checking', today });
  const cardPayments = [
    { card: 'CREDIT CARD (-1947)', displayName: 'Sapphire', date: d(2026, 10, 13), amount: 6914.52, statementClosed: true, statementFrom: d(2026, 8, 24), statementClose: d(2026, 9, 23), chargeCount: 60 },
    { card: 'CREDIT CARD (-0664)', displayName: 'Freedom', date: d(2026, 10, 26), amount: 870, statementClosed: false, statementFrom: d(2026, 9, 8), statementClose: d(2026, 10, 7), chargeCount: 6 },
  ];
  const plan = planUpcomingCash({ cashOnHand: 664, cardPayments, paychecks, bills, today });
  const ev = plan.events.map(e => [e.date.getMonth() + 1, e.date.getDate(), e.kind, e.amount]);

  it('lays out what comes in and goes out, in order', () => {
    expect(ev).toEqual([
      [10, 13, 'card', -6914.52],
      [10, 15, 'paycheck', 3314],
      [10, 26, 'card', -870],
      [10, 30, 'paycheck', 3050],
      [11, 1, 'bill', -5350],
      [11, 13, 'paycheck', 3314],
    ]);
    expect(plan.nextPaycheck.date).toEqual(d(2026, 10, 15));
    expect(plan.nextCardPayment.label).toBe('Sapphire payment');
  });

  it('says what pays for each bill, and where it falls short', () => {
    const [sapphire, , freedom, , rent] = plan.events;
    // Due before payday with $664 on hand: short.
    expect(sapphire.paidFrom).toEqual([{ source: 'cash on hand', amount: 664 }]);
    expect(sapphire.shortBy).toBe(6250.52);
    expect(plan.firstShort).toBe(sapphire);
    expect(freedom.paidFrom).toEqual([{ source: 'Oct 15 paycheck', amount: 870 }]);
    expect(rent.paidFrom).toEqual([{ source: 'Oct 15 paycheck', amount: 2444 }, { source: 'Oct 30 paycheck', amount: 2906 }]);
    expect(rent.shortBy).toBeUndefined();
  });

  it('keeps a running balance and totals', () => {
    expect(plan.events.map(e => e.balance)).toEqual([-6250.52, -2936.52, -3806.52, -756.52, -6106.52, -2792.52]);
    expect(plan.totals).toEqual({ in: 9678, out: 13134.52, end: -2792.52 });
  });

  it('says whether a card amount is final', () => {
    expect(plan.events[0].detail).toMatch(/has closed/);
    expect(plan.events[2].detail).toMatch(/still open.*6 charges/);
    expect(plan.events[1].detail).toMatch(/same amount the last 3 times/);
    expect(plan.events[3].detail).toMatch(/ranged/);
  });
});
