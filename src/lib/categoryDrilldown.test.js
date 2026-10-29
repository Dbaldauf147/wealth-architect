import { describe, it, expect } from 'vitest';
import { categoryDrilldown, isTrendSpend, placeOf } from './categoryDrilldown.js';

const tx = (date, amount, category, description) => ({ date, amount, category, description });

const ledger = [
  tx('08/03/2026', -60, 'Groceries', 'WHOLE FOODS MARKET #10234 NEW YORK NY'),
  tx('08/17/2026', -40, 'Groceries', 'WHOLEFDS'),
  tx('08/20/2026', -100, 'Groceries', 'TRADER JOE S #552'),
  tx('08/09/2026', -300, 'Dining', 'TST* FEED AND GRAIN'),
  tx('08/30/2026', -500, 'Transfer', 'To savings'),          // moving money, not spending
  tx('09/05/2026', -150, 'Groceries', 'WHOLE FOODS MARKET #10234'),
  tx('09/12/2026', -50, 'Groceries', 'TRADER JOE S #552'),
  tx('09/14/2026', 30, 'Groceries', 'WHOLE FOODS REFUND'),  // refunds aren't netted, as on the table
  tx('09/20/2026', -800, 'Rent', 'LANDLORD'),
];

describe('categoryDrilldown', () => {
  const d = categoryDrilldown({ transactions: ledger, category: 'Groceries', months: ['2026-07', '2026-08', '2026-09'] });
  const m = Object.fromEntries(d.months.map(x => [x.key, x]));

  it('totals the category and its share of all spending each month', () => {
    expect(m['2026-08']).toMatchObject({ amount: 200, total: 500, count: 3 });
    expect(m['2026-08'].share).toBeCloseTo(0.4);
    expect(m['2026-09']).toMatchObject({ amount: 200, total: 1000 });
    expect(m['2026-09'].share).toBeCloseTo(0.2);
    expect(m['2026-07']).toMatchObject({ amount: 0, share: 0, places: [] });
  });

  it('ranks the places behind each month, with last month beside them', () => {
    expect(m['2026-09'].places.map(p => [p.name, p.amount, p.prev])).toEqual([
      ['Whole Foods Market', 150, 60],
      ['Trader Joe S', 50, 100],
    ]);
    expect(m['2026-09'].places[0].share).toBeCloseTo(0.75);
    expect(m['2026-08'].places[0]).toMatchObject({ name: 'Trader Joe S', prev: 0 });
  });

  it('caps the places listed and says how many more there were', () => {
    const one = categoryDrilldown({ transactions: ledger, category: 'Groceries', months: ['2026-08'], topPlaces: 1 });
    expect(one.months[0].places).toHaveLength(1);
    expect(one.months[0].more).toBe(2);
  });

  it('averages over the window and ranks places across it', () => {
    expect(d.avg).toBeCloseTo(400 / 3);
    expect(d.avgShare).toBeCloseTo(400 / 1500);
    expect(d.places[0]).toMatchObject({ name: 'Whole Foods Market', amount: 210 });
  });
});

describe('isTrendSpend / placeOf', () => {
  it('counts charges, not money moving or coming in', () => {
    expect(isTrendSpend(tx('1/1/2026', -5, 'Coffee', 'x'))).toBe(true);
    expect(isTrendSpend(tx('1/1/2026', -5, 'Credit Card Payment', 'x'))).toBe(false);
    expect(isTrendSpend(tx('1/1/2026', 5, 'Coffee', 'x'))).toBe(false);
  });

  it('names a place without processor prefixes or store numbers', () => {
    expect(placeOf({ description: 'SQ *COPPER MUG COFFEE 4421' }).name).toBe('Copper Mug Coffee');
  });
});
