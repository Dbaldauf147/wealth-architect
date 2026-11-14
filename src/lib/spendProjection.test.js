import { describe, it, expect } from 'vitest';
import { projectMonthSpending, sumDaily, withExpected } from './spendProjection.js';

const tx = (date, amount, category) => ({ date, amount, category, description: category });
const today = new Date(2026, 10, 14); // Nov 14, 2026

// Aug–Oct: rent 2,000 on the 1st, groceries 100 on the 5th and 300 on the 20th.
// Oct also has a 600 trip on the 25th. Nov so far: rent, 150 groceries, 90 gas.
function ledger() {
  const out = [];
  for (const m of ['08', '09', '10']) {
    out.push(tx(`2026-${m}-01T12:00:00`, -2000, 'Rent'));
    out.push(tx(`2026-${m}-05T12:00:00`, -100, 'Groceries'));
    out.push(tx(`2026-${m}-20T12:00:00`, -300, 'Groceries'));
  }
  out.push(tx('2026-10-25T12:00:00', -600, 'Travel'));
  out.push(tx('2026-11-01T12:00:00', -2000, 'Rent'));
  out.push(tx('2026-11-06T12:00:00', -150, 'Groceries'));
  out.push(tx('2026-11-10T12:00:00', -90, 'Gas'));
  // Not spending: money in, and money moving.
  out.push(tx('2026-11-12T12:00:00', 3000, 'Paycheck'));
  out.push(tx('2026-11-03T12:00:00', -5000, 'Transfer'));
  out.push(tx('2026-10-28T12:00:00', -900, 'Credit Card Payment'));
  return out;
}

describe('projectMonthSpending', () => {
  const p = projectMonthSpending({ transactions: ledger(), today });
  const cat = c => p.categories.find(x => x.category === c);

  it('adds what each category usually spends in the rest of the month', () => {
    expect(p).toMatchObject({ key: '2026-11', day: 14, daysInMonth: 30, daysLeft: 16, basis: ['2026-08', '2026-09', '2026-10'] });
    // Rent is done for the month; groceries still have their usual 300 to come.
    expect(cat('Rent')).toMatchObject({ soFar: 2000, remaining: 0, projected: 2000, typical: 2000, delta: 0 });
    expect(cat('Groceries')).toMatchObject({ soFar: 150, remaining: 300, projected: 450, typical: 400, delta: 50 });
    // One trip in three months: a third of it is expected.
    expect(cat('Travel')).toMatchObject({ soFar: 0, remaining: 200, projected: 200, typical: 200 });
    expect(cat('Gas')).toMatchObject({ soFar: 90, remaining: 0, projected: 90, typical: 0, delta: 90 });
  });
  it('totals the categories and leaves out income and transfers', () => {
    expect(p.soFar).toBe(2240);
    expect(p.remaining).toBe(500);
    expect(p.projected).toBe(2740);
    expect(p.typical).toBe(2600);
    expect(p.lastMonth).toBe(3000);
    expect(p.categories.map(c => c.category)).toEqual(['Rent', 'Groceries', 'Travel', 'Gas']);
  });
  it('draws the month day by day, the projection meeting the total on the last day', () => {
    expect(p.daily).toHaveLength(30);
    expect(p.daily[0]).toMatchObject({ day: 1, actual: 2000, projected: null, typical: 2000 });
    expect(p.daily[13]).toMatchObject({ day: 14, actual: 2240, projected: 2240 });
    expect(p.daily[14].actual).toBeNull();
    expect(p.daily[19]).toMatchObject({ day: 20, projected: 2540 });
    expect(p.daily[29]).toMatchObject({ day: 30, projected: 2740, typical: 2600 });
  });
  it('carries each category day by day, and they add up to the month', () => {
    expect(cat('Groceries').daily[5]).toMatchObject({ day: 6, actual: 150, projected: null });
    expect(cat('Groceries').daily[19]).toMatchObject({ day: 20, actual: null, projected: 450, typical: 400 });
    expect(cat('Travel').daily[29]).toMatchObject({ projected: 200 });
    expect(sumDaily(p.categories)).toEqual(p.daily);
    const noRent = sumDaily(p.categories.filter(c => c.category !== 'Rent'));
    expect(noRent[13]).toMatchObject({ actual: 240, projected: 240 });
    expect(noRent[29]).toMatchObject({ projected: 740, typical: 600 });
  });
  it('projects nothing more without history, or on the last day', () => {
    const fresh = projectMonthSpending({ transactions: ledger().filter(t => t.date.startsWith('2026-11')), today });
    expect(fresh).toMatchObject({ basis: [], soFar: 2240, remaining: 0, projected: 2240, lastMonth: null });
    const last = projectMonthSpending({ transactions: ledger(), today: new Date(2026, 10, 30) });
    expect(last.remaining).toBe(0);
  });
});

describe('withExpected', () => {
  const p = projectMonthSpending({ transactions: ledger(), today });
  const cat = c => p.categories.find(x => x.category === c);

  it('replaces the projection and keeps the usual shape of the days to come', () => {
    const g = withExpected(cat('Groceries'), 750); // 150 so far, usually 300 more on the 20th
    expect(g).toMatchObject({ projected: 750, remaining: 600, delta: 350, auto: 450, expected: 750 });
    expect(g.daily[13].projected).toBe(150);
    expect(g.daily[18].projected).toBe(150);
    expect(g.daily[19].projected).toBe(750);
    expect(g.daily[29].projected).toBe(750);
    expect(g.daily[5]).toEqual(cat('Groceries').daily[5]);
  });
  it('ramps evenly when nothing more was projected, and never goes below what is spent', () => {
    const gas = withExpected(cat('Gas'), 250); // 90 so far, nothing more projected
    expect(gas).toMatchObject({ projected: 250, remaining: 160 });
    expect(gas.daily[13].projected).toBe(90);
    expect(gas.daily[21].projected).toBe(170);
    expect(gas.daily[29].projected).toBe(250);
    expect(withExpected(cat('Rent'), 500)).toMatchObject({ projected: 2000, remaining: 0, expected: 500 });
  });
  it('leaves the category alone without a value', () => {
    expect(withExpected(cat('Rent'), undefined)).toBe(cat('Rent'));
  });
});
