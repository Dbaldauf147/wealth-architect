import { describe, it, expect } from 'vitest';
import { aboveRangeCategories } from './weeklySummary.js';

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
