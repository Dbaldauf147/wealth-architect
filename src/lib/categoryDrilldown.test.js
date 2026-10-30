import { describe, it, expect } from 'vitest';
import { categoryDrilldown, isTrendSpend, placeOf, historyMonths, periodOf, periodLabel } from './categoryDrilldown.js';

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
    expect(placeOf({ description: 'Cvs/pharmacy #x4421' }).name).toBe('Cvs Pharmacy');
    expect(placeOf({ description: 'Planet Fitness G Des:iclub Fees ID:x1' }).name).toBe('Planet Fitness G');
    expect(placeOf({ description: 'Doordash*12/31-3 Order' }).name).toBe('Doordash');
  });

  it('groups a merchant whose every charge carries an order code', () => {
    const keys = ['Amazon.com*5E9HQ2GD0', 'Amazon.com*ad0nu6to3', 'Amazon Mktpl*W12G34Z56'].map(d => placeOf({ description: d }));
    expect(new Set(keys.map(k => k.key))).toEqual(new Set(['amazon']));
    expect(keys[0].name).toBe('Amazon');
    expect(placeOf({ description: 'Citibik*7 Rides' }).name).toBe('Citibik');
  });
});

describe('longer ranges', () => {
  it('lists every month from the first charge to today', () => {
    expect(historyMonths(ledger, new Date(2026, 9, 30))).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(historyMonths([], new Date(2026, 9, 30))).toEqual(['2026-10']);
  });

  it('names quarters and years', () => {
    expect(periodOf('2026-08', 'quarter')).toBe('2026-Q3');
    expect(periodOf('2026-08', 'year')).toBe('2026');
    expect(periodLabel('2026-Q3')).toBe('Q3 2026');
    expect(periodLabel('2026-08', true)).toBe('Aug 26');
    expect(periodLabel('2026')).toBe('2026');
  });

  it('groups months into quarters, keeping the average per month', () => {
    const q = categoryDrilldown({ transactions: ledger, category: 'Groceries', months: ['2026-07', '2026-08', '2026-09', '2026-10'], group: 'quarter' });
    expect(q.months.map(p => [p.key, p.monthCount, p.amount, p.total])).toEqual([['2026-Q3', 3, 400, 1500], ['2026-Q4', 1, 0, 0]]);
    expect(q.months[0].places[0]).toMatchObject({ name: 'Whole Foods Market', amount: 210 });
    expect(q.avg).toBe(100);
  });
});
