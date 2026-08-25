import { describe, it, expect } from 'vitest';
import { findRentCollisions, shiftForwardOneMonth, nextMonthKey } from './rentDuplicates.js';

const rent = (id, date, amount, description = 'Zelle payment for rent') => ({
  transactionId: id, date, amount, description, category: 'Rent',
});

describe('shiftForwardOneMonth', () => {
  it('keeps the day of the month', () => {
    expect(shiftForwardOneMonth('2026-08-10')).toBe('2026-09-10');
  });

  // The sheet hands dates over in whatever format it feels like; an ISO-only
  // reader leaves the move button dead for everyone whose column is M/D/YYYY.
  it('reads a non-ISO date', () => {
    expect(shiftForwardOneMonth('12/3/2025')).toBe('2026-01-03');
    expect(shiftForwardOneMonth('8/10/2026')).toBe('2026-09-10');
  });

  it('rolls the year over at December', () => {
    expect(shiftForwardOneMonth('2025-12-15')).toBe('2026-01-15');
  });

  it('clamps a day past the end of the target month', () => {
    expect(shiftForwardOneMonth('2026-01-31')).toBe('2026-02-28');
  });

  it('returns null for something unreadable', () => {
    expect(shiftForwardOneMonth('not a date')).toBeNull();
    expect(shiftForwardOneMonth('')).toBeNull();
  });
});

describe('nextMonthKey', () => {
  it('rolls the year over', () => {
    expect(nextMonthKey('2025-12')).toBe('2026-01');
    expect(nextMonthKey('2026-08')).toBe('2026-09');
  });
});

describe('findRentCollisions', () => {
  it('picks the genuinely latest payment when dates are not ISO', () => {
    // '12/15/2025' sorts ahead of '12/3/2025' as a string, which used to hand
    // back the 3rd as "the later one" and offer to move the wrong payment.
    const [c] = findRentCollisions([
      rent('a', '11/18/2025', 2915),
      rent('b', '12/15/2025', 3480),
      rent('c', '12/3/2025', 1000),
    ]);
    expect(c.payments.map(p => p.date)).toEqual(['11/18/2025', '12/3/2025', '12/15/2025']);
    expect(c.later.transactionId).toBe('b');
    expect(c.suggestedDate).toBe('2026-01-15');
  });

  it('counts a late-month payment against the month it is credited to', () => {
    // Nov 18 is closer to Dec 1 than to Nov 1, so it lands in December and
    // collides there — that snapping is the whole reason this check exists.
    const [c] = findRentCollisions([
      rent('a', '2025-11-18', 2915),
      rent('b', '2025-12-15', 3480),
    ]);
    expect(c.monthKey).toBe('2025-12');
  });

  it('reports the three surrounding months with their rent totals', () => {
    const [c] = findRentCollisions([
      rent('prev', '2025-11-02', 2200),
      rent('a', '2025-12-03', 1000),
      rent('b', '2025-12-15', 3480),
    ]);
    expect(c.months.map(m => [m.role, m.key, m.total, m.payments.length])).toEqual([
      ['before', '2025-11', 2200, 1],
      ['collision', '2025-12', 4480, 2],
      ['after', '2026-01', 0, 0],
    ]);
    // What the move would take out of one month and put into the next.
    expect(c.moveAmount).toBe(3480);
  });

  it('leaves a single payment per month alone', () => {
    expect(findRentCollisions([
      rent('a', '2025-11-02', 2200),
      rent('b', '2025-12-02', 2200),
    ])).toEqual([]);
  });

  it('honours a dismissal of that specific collision', () => {
    const txns = [rent('a', '2025-12-03', 1000), rent('b', '2025-12-15', 3480)];
    const [c] = findRentCollisions(txns);
    expect(findRentCollisions(txns, k => k === c.key)).toEqual([]);
  });

  it('ignores anything that is not rent income', () => {
    expect(findRentCollisions([
      { transactionId: 'a', date: '2025-12-03', amount: -1000, description: 'rent paid out' },
      { transactionId: 'b', date: '2025-12-15', amount: 3480, description: 'salary' },
    ])).toEqual([]);
  });
});
