import { describe, it, expect } from 'vitest';
import { computeOvershot, monthsSpanned } from './overshot.js';

const tx = (date, amount, category, description = category) => ({ date, amount, category, description });

// Five complete months and one in progress. Paycheck 5,000 on the 15th;
// rent 2,500 on the 1st and food 1,500 on the 10th every month.
//   Jan: 4,000 spent                       → under
//   Feb: + Travel 2,000 on the 20th        → 6,000, over by 1,000
//   Mar: + Shopping 1,500                  → 5,500, over by 500
//   Apr: + Shopping 1,200                  → 5,200, over by 200
//   May: a 1,000 food refund               → 3,000 spent; the refund is also
//        income, exactly as Cash Flow counts it (6,000)
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

  it('nets a refund into spending rather than counting it as income-only', () => {
    expect(m['2026-05']).toMatchObject({ income: 6000, spending: 3000, over: false });
  });

  it('finds the day the month ran out of income', () => {
    const feb = m['2026-02'];
    // 2,500 on the 1st, 4,000 by the 10th, 6,000 on the 20th → passes 5,000 on the 20th.
    expect(feb.runOutDate).toEqual(new Date(2026, 1, 20));
    expect(m['2026-01'].runOutDate).toBeNull();
  });

  it('still finds the day when a category nets positive that month', () => {
    // Cash Flow counts a month's spending as each category's |net|, so a
    // category refunded more than it cost that month still adds to spending.
    // A plain signed running total would never reach the month's figure.
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
    expect(jul).toMatchObject({ income: 1400, spending: 1200, over: false });
    const aug = out.months[1];
    expect(aug.over).toBe(true);
    expect(aug.runOutDate).toEqual(new Date(2026, 7, 5));
    const t2 = [...t, tx('07/25/2026', -600, 'Travel')];
    const jul2 = computeOvershot({ transactions: t2, monthKeys: ['2026-07', '2026-08'], today: new Date(2026, 8, 2) }).months[0];
    expect(jul2).toMatchObject({ spending: 1800, over: true });
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
    expect(r.months.filter(x => !x.partial).map(x => x.cumulative)).toEqual([1000, 0, -500, -700, 2300]);
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
