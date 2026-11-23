import { describe, it, expect } from 'vitest';
import { computeOvershot, monthsSpanned, expectedIncomeMonths, incomeBuckets, subtractRent } from './overshot.js';

const tx = (date, amount, category, description = category) => ({ date, amount, category, description });

// Five complete months and one in progress. Paycheck 5,000 on the 15th;
// rent 2,500 on the 1st and food 1,500 on the 10th every month.
//   Jan: 4,000 spent                       → under
//   Feb: + Travel 2,000 on the 20th        → 6,000, over by 1,000
//   Mar: + Shopping 1,500                  → 5,500, over by 500
//   Apr: + Shopping 1,200                  → 5,200, over by 200
//   May: a 1,000 food refund               → 3,000 spent; the refund nets
//        against food and isn't income as well (5,000)
//   Jun: in progress — rent + 500 food, no paycheck yet
function ledger() {
  const out = [];
  for (const [m, extra] of [['01'], ['02', ['Travel', 2000]], ['03', ['Shopping', 1500]], ['04', ['Shopping', 1200]], ['05']]) {
    out.push(tx(`${m}/15/2026`, 5000, 'Paycheck'));
    out.push(tx(`${m}/01/2026`, -2500, 'Housing', 'Rent'));
    out.push(tx(`${m}/10/2026`, -1500, 'Food & Drink'));
    if (extra) out.push(tx(`${m}/20/2026`, -extra[1], extra[0]));
  }
  out.push(tx('05/12/2026', 1000, 'Food & Drink', 'Refund'));
  out.push(tx('06/01/2026', -2500, 'Housing', 'Rent'));
  out.push(tx('06/04/2026', -500, 'Food & Drink'));
  // Moving money never counts.
  out.push(tx('02/03/2026', -9000, 'Transfer'));
  out.push(tx('03/03/2026', -4000, 'Credit Card Payment'));
  out.push(tx('04/03/2026', -3000, 'Investments'));
  return out;
}

describe('computeOvershot', () => {
  const keys = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
  const today = new Date(2026, 5, 10);
  const r = computeOvershot({ transactions: ledger(), monthKeys: keys, today });
  const m = Object.fromEntries(r.months.map(x => [x.key, x]));

  it('counts income and spending the way Cash Flow does', () => {
    expect(m['2026-01']).toMatchObject({ income: 5000, spending: 4000, over: false });
    expect(m['2026-02']).toMatchObject({ income: 5000, spending: 6000, over: true, gap: 1000 });
    expect(m['2026-03'].gap).toBe(500);
    expect(m['2026-04'].gap).toBe(200);
  });

  it('nets a refund into spending and does not count it as income too', () => {
    expect(m['2026-05']).toMatchObject({ income: 5000, spending: 3000, over: false });
  });

  it('finds the day the month ran out of income', () => {
    const feb = m['2026-02'];
    // 2,500 on the 1st, 4,000 by the 10th, 6,000 on the 20th → passes 5,000 on the 20th.
    expect(feb.runOutDate).toEqual(new Date(2026, 1, 20));
    expect(m['2026-01'].runOutDate).toBeNull();
  });

  it('still finds the day when a category nets positive that month', () => {
    // A category refunded more than it cost that month is money in that
    // month, not spending — the running total leaves it out.
    const t = [
      tx('07/15/2026', 1000, 'Paycheck'),
      tx('07/02/2026', -900, 'Housing'),
      tx('07/05/2026', -100, 'Shopping'),
      tx('07/20/2026', 400, 'Shopping', 'Refund'),       // Shopping nets +300 in July
      tx('08/05/2026', -2000, 'Shopping'),               // …but negative over the window
      tx('08/15/2026', 1000, 'Paycheck'),
    ];
    const out = computeOvershot({ transactions: t, monthKeys: ['2026-07', '2026-08'], today: new Date(2026, 8, 2) });
    const jul = out.months[0];
    expect(jul).toMatchObject({ income: 1300, spending: 900, over: false });
    const aug = out.months[1];
    expect(aug.over).toBe(true);
    expect(aug.runOutDate).toEqual(new Date(2026, 7, 5));
    const t2 = [...t, tx('07/25/2026', -600, 'Travel')];
    const jul2 = computeOvershot({ transactions: t2, monthKeys: ['2026-07', '2026-08'], today: new Date(2026, 8, 2) }).months[0];
    expect(jul2).toMatchObject({ spending: 1500, income: 1300, over: true });
    expect(jul2.runOutDate).toEqual(new Date(2026, 6, 25));
  });

  it('names what pushed a month over, against that category\'s typical month', () => {
    expect(m['2026-02'].drivers[0]).toMatchObject({ category: 'Travel', amount: 2000 });
    expect(m['2026-03'].drivers[0].category).toBe('Shopping');
  });

  it('keeps the month in progress out of the verdict and reports its pace', () => {
    expect(m['2026-06'].partial).toBe(true);
    expect(r.summary.completeCount).toBe(5);
    expect(r.pace).toMatchObject({ key: '2026-06', spending: 3000, alreadyOver: false });
    expect(r.pace.daysLeft).toBe(20);
  });

  it('tracks streaks and the three-month average', () => {
    expect(r.summary.overCount).toBe(3);
    expect(r.summary.longestStreak).toMatchObject({ length: 3, start: '2026-02', end: '2026-04' });
    expect(r.summary.currentStreak).toBe(0);
    expect(r.summary.totalGap).toBe(1700);
    expect(m['2026-04'].rolling.over).toBe(true);   // Feb–Apr averages over
    expect(m['2026-05'].rolling.over).toBe(false);  // Mar–May doesn't
    expect(r.summary.status).toBe('within');
  });

  it('marks where the running total went negative and came back', () => {
    expect(r.months.filter(x => !x.partial).map(x => x.cumulative)).toEqual([1000, 0, -500, -700, 1300]);
    expect(r.summary.crossings).toEqual([{ key: '2026-03', direction: 'under' }, { key: '2026-05', direction: 'back' }]);
  });

  it('calls a single bad month an edge, and a bad quarter above your means', () => {
    const edge = computeOvershot({ transactions: ledger(), monthKeys: keys.slice(0, 2), today: new Date(2026, 2, 5) });
    expect(edge.summary.status).toBe('edge');
    const above = computeOvershot({ transactions: ledger(), monthKeys: keys.slice(0, 4), today: new Date(2026, 4, 5) });
    expect(above.summary.status).toBe('above');
  });
});

describe('monthsSpanned', () => {
  it('runs from the first transaction to today with no gaps', () => {
    const t = [tx('11/20/2025', -5, 'Shopping'), tx('02/02/2026', -5, 'Shopping')];
    expect(monthsSpanned(t, new Date(2026, 2, 1))).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
    expect(monthsSpanned([], new Date())).toEqual([]);
  });
});

describe('expectedIncomeMonths', () => {
  const row = (date, kind, extra = {}) => ({
    date: new Date(date), kind, base: 3000, commissionPreTax: 0, commissionTakeHome: 0, total: 3000,
    projected: false, earnedMonth: null, status: 'expected', received: null, ...extra,
  });
  const schedule = [
    row('2026-11-14', 'mid', { status: 'received', received: 2990 }),
    row('2026-11-30', 'end', { commissionPreTax: 1000, commissionTakeHome: 600, total: 3600, earnedMonth: '2026-10' }),
    row('2026-12-15', 'mid'),
    row('2026-12-31', 'end', { commissionPreTax: 500, commissionTakeHome: 300, total: 3300, earnedMonth: '2026-11', projected: true }),
    row('2027-01-15', 'mid'),
  ];

  it('counts what landed, adds what is expected, by month', () => {
    const [nov, dec] = expectedIncomeMonths({ schedule, typicalSpending: 6000 });
    expect(nov).toMatchObject({ key: '2026-11', received: 2990, expected: 3600, total: 6590, base: 3000, commission: 600, commissionPreTax: 1000, earnedMonth: '2026-10', projected: false, paychecks: 2, leftOver: 590 });
    expect(dec).toMatchObject({ key: '2026-12', received: 0, total: 6300, commission: 300, projected: true, leftOver: 300 });
  });

  it('limits the months and leaves leftOver empty without a typical month', () => {
    const out = expectedIncomeMonths({ schedule, months: 2 });
    expect(out.map(m => m.key)).toEqual(['2026-11', '2026-12']);
    expect(out[0].leftOver).toBeNull();
  });

  it('is empty without a schedule', () => {
    expect(expectedIncomeMonths({ schedule: [] })).toEqual([]);
  });
});

describe('incomeBuckets', () => {
  const t = [
    tx('07/15/2026', 3000, 'Paycheck', 'ACME PAYROLL'),
    tx('07/31/2026', 3600, 'Paycheck', 'ACME PAYROLL'),
    tx('07/20/2026', 250, 'Interest'),
    tx('07/22/2026', 100, 'Paycheck', 'Expense reimbursement'),
    tx('07/05/2026', -2000, 'Housing', 'Rent'),
    tx('07/09/2026', 40, 'Housing', 'Refund'),
    tx('08/14/2026', 3000, 'Paycheck', 'ACME PAYROLL'),
    tx('08/20/2026', -500, 'Paycheck', 'Payroll correction'),
  ];
  const { months } = computeOvershot({ transactions: t, monthKeys: ['2026-07', '2026-08'], today: new Date(2026, 8, 2) });
  const paychecks = [
    { t: t[0], key: '2026-07', amount: 3000, base: 3000, commission: 0 },
    { t: t[1], key: '2026-07', amount: 3600, base: 3000, commission: 600 },
    { t: t[6], key: '2026-08', amount: 3000, base: 3000, commission: 0 },
  ];
  const b = incomeBuckets({ months, paychecks });

  it('splits payroll into base and commission, and the rest by category', () => {
    expect(months[0].income).toBe(6950);
    expect(b['2026-07']).toEqual({ base: 6000, commission: 600, other: 350, otherBy: [{ category: 'Interest', amount: 250 }, { category: 'Paycheck', amount: 100 }] });
  });
  it('always adds up to the month\'s income, even when a paycheck is netted down', () => {
    expect(months[1].income).toBe(2500);
    expect(b['2026-08']).toEqual({ base: 2500, commission: 0, other: 0, otherBy: [] });
  });
  it('is all other income without paychecks', () => {
    expect(incomeBuckets({ months, paychecks: [] })['2026-07']).toMatchObject({ base: 0, commission: 0, other: 6950 });
  });
});

describe('subtractRent', () => {
  const t = [
    tx('07/15/2026', 3000, 'Paycheck', 'ACME PAYROLL'),
    tx('07/31/2026', 3600, 'Paycheck', 'ACME PAYROLL'),
    tx('07/01/2026', -2000, 'Housing', 'Zelle to landlord for rent'),
    tx('07/10/2026', -5000, 'Travel'),
    tx('07/12/2026', -300, 'Travel', 'Car rental'),
    tx('08/01/2026', -2000, 'Rent'),
    tx('08/05/2026', -400, 'Food & Drink'),
  ];
  const { months } = computeOvershot({ transactions: t, monthKeys: ['2026-07', '2026-08'], today: new Date(2026, 7, 6) });
  const buckets = { '2026-07': { base: 6000, commission: 600, other: 0, otherBy: [] }, '2026-08': { base: 0, commission: 0, other: 0, otherBy: [] } };
  const expected = [
    { key: '2026-08', expected: 6500, base: 6000, commission: 500, leftOver: -800 },
    { key: '2026-09', expected: 6500, base: 6000, commission: 500, leftOver: -800 },
    { key: '2026-10', expected: 6500, base: 6000, commission: 500, leftOver: -800 },
  ];
  const projection = { key: '2026-08', income: 0, stillDue: 6500, projected: 6500, spending: 2400, over: false, gap: 0 };
  const r = subtractRent({ months, buckets, expected, projection });

  it('finds rent by category or description, not "rental"', () => {
    expect(months.map(m => m.rent)).toEqual([2000, 2000]);
  });
  it('takes rent off spending and income alike, base salary first, leaving the gap alone', () => {
    expect(r.months[0]).toMatchObject({ income: 4600, spending: 5300, rentOut: 2000, over: true, gap: 700 });
    expect(r.buckets['2026-07']).toMatchObject({ base: 4000, commission: 600 });
  });
  it('takes rent the month in progress hasn\'t earned yet off the paychecks still due', () => {
    expect(r.months[1]).toMatchObject({ income: 0, spending: 400 });
    expect(r.expected[0]).toMatchObject({ expected: 4500, base: 4000, commission: 500 });
    expect(r.projection).toMatchObject({ projected: 4500, stillDue: 4500, spending: 400, over: false });
  });
  it('takes the latest rent off next month only', () => {
    expect(r.expected[1]).toMatchObject({ expected: 4500, base: 4000, rentOut: 2000 });
    expect(r.expected[2]).toEqual(expected[2]);
  });
});

describe('rent received on Overshot', () => {
  const t = [
    tx('10/15/2026', 5000, 'Paycheck'),
    tx('10/01/2026', -5500, 'Rent', 'Zelle payment to, Landlord, for, "rent"'),
    tx('10/01/2026', 2400, 'Rent', 'Zelle payment from, Roommate, for, "rent"'),
  ];
  const r = computeOvershot({ transactions: t, monthKeys: ['2026-10'], today: new Date(2026, 10, 5) });

  it('shows it as income, with rent paid in full as spending', () => {
    expect(r.months[0]).toMatchObject({ income: 7400, spending: 5500, net: 1900, over: false, rent: 5500 });
    expect(r.months[0].incomeByCategory).toEqual({ Paycheck: 5000, 'Rent received': 2400 });
  });

  it('puts it in the other-income bucket', () => {
    const b = incomeBuckets({ months: r.months, paychecks: [] });
    expect(b['2026-10'].otherBy).toContainEqual({ category: 'Rent received', amount: 2400 });
  });
});
