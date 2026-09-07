import { describe, it, expect } from 'vitest';
import { aboveRangeCategories, buildWeeklySummary, lastCompletedWeek } from './weeklySummary.js';

// A fixed "now" so window boundaries are assertable: Tue 2026-08-25. Window 0
// is the 30 days ending that day; each baseline window is the 30 before it.
const NOW = new Date(2026, 7, 25);
const CURRENT = '2026-08-20';
const BASELINE = ['2026-07-20', '2026-06-20', '2026-05-25'];

/** One category that spent `current` in the last 30 days and `each` in every
 *  one of the three baseline windows. */
function category(name, current, each) {
  return [
    { date: CURRENT, category: name, amount: -current },
    ...BASELINE.map(date => ({ date, category: name, amount: -each })),
  ];
}

describe('aboveRangeCategories', () => {
  it('ranks by 30-day spend, not by how far over the band a category ran', () => {
    const txns = [
      // $60 over its $160 ceiling, but only $220 of spend.
      ...category('Venmo', 220, 128),
      // Only $41 over its ceiling, but ten times the spend.
      ...category('Travel', 2372, 1865),
    ];
    const out = aboveRangeCategories({ transactions: txns, asOf: NOW });
    expect(out.map(r => r.name)).toEqual(['Travel', 'Venmo']);
    expect(out[0].current).toBe(2372);
  });

  it('leaves out categories that stayed inside their band', () => {
    const txns = [...category('Groceries', 400, 400), ...category('Travel', 2372, 1865)];
    const out = aboveRangeCategories({ transactions: txns, asOf: NOW });
    expect(out.map(r => r.name)).toEqual(['Travel']);
  });

  it('drops excluded categories entirely, however far over they ran', () => {
    const txns = [...category('Transfer', 12127, 9174), ...category('Travel', 2372, 1865)];
    const out = aboveRangeCategories({
      transactions: txns,
      asOf: NOW,
      excludedCategories: ['Transfer'],
    });
    expect(out.map(r => r.name)).toEqual(['Travel']);
  });

  it('never reports Income as overspending', () => {
    const txns = [...category('Income', 9000, 1000)];
    expect(aboveRangeCategories({ transactions: txns, asOf: NOW })).toEqual([]);
  });
});

/* ── The reported week and the week the panels describe must be the same one ──
   The Sep 6 email carried a "top merchant" of $260.21 inside a week whose
   stated total was $257.71, which cannot both be true of one window. */

describe('buildWeeklySummary window consistency', () => {
  // Sent Sunday 2026-09-06. lastCompletedWeek is then Mon Aug 24 – Sun Aug 30,
  // while the week containing the send date is Aug 31 – Sep 6.
  const SENT = new Date(2026, 8, 6, 9, 0, 0);

  const txns = [
    // The reported week: $600 of spending.
    { date: '2026-08-25', description: 'Hotel', category: 'Travel', amount: -500 },
    { date: '2026-08-27', description: 'Dinner', category: 'Restaurants', amount: -100 },
    // The week the email happened to be sent in: $20.
    { date: '2026-09-02', description: 'Coffee', category: 'Restaurants', amount: -20 },
    // Baseline history so "normal" is not zero.
    { date: '2026-07-07', description: 'Old', category: 'Restaurants', amount: -80 },
    { date: '2026-06-09', description: 'Older', category: 'Restaurants', amount: -80 },
  ];

  it('reports the headline week in the week panel, not the week it was sent in', () => {
    const { start, end } = lastCompletedWeek(SENT);
    expect(start.getDate()).toBe(24);
    expect(end.getDate()).toBe(30);

    const s = buildWeeklySummary({ transactions: txns, start, end });
    // The email's own header covers Aug 24-30, so this must be the $600 week.
    expect(s.weekCompare.thisTotalToDate).toBe(600);
  });

  it('keeps the week panel and the top-category list describing one window', () => {
    const { start, end } = lastCompletedWeek(SENT);
    const s = buildWeeklySummary({ transactions: txns, start, end });
    const topTotal = s.topCategories.reduce((sum, c) => sum + c.amount, 0);
    // A single top category can never exceed the week it is supposedly part of.
    expect(s.weekCompare.thisTotalToDate).toBeGreaterThanOrEqual(topTotal);
  });

  it('compares the month the report ends in, not the month it was sent in', () => {
    const { start, end } = lastCompletedWeek(SENT);
    const s = buildWeeklySummary({ transactions: txns, start, end });
    expect(s.monthCompare.thisMonthLabel).toMatch(/August/);
  });
});
