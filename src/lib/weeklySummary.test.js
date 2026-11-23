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

describe('monthProjection', () => {
  const t = (date, amount, category, description = category) => ({ date, amount, category, description, account: 'Checking' });
  const PAY = 'Summit Energy Se Des:payroll, ID:CERx5369 Ppd';
  const txns = [];
  for (const m of [8, 9, 10, 11]) {
    txns.push(t(`${m}/2/2026`, -5500, 'Rent', 'Zelle payment to, Landlord, for, "rent"'));
    txns.push(t(`${m}/2/2026`, 2400, 'Rent', 'Zelle payment from, Roommate, for, "rent"'));
    txns.push(t(`${m}/15/2026`, 2664, 'Paycheck', PAY));
    for (let i = 0; i < 8; i++) txns.push(t(`${m}/${20 + i}/2026`, -50 - i, `Cat ${i}`));
    txns.push(t(`${m}/30/2026`, 2664, 'Paycheck', PAY));
  }

  it('projects the month the week ended in, cut to the largest categories', async () => {
    const { monthProjection } = await import('./weeklySummary.js');
    const p = monthProjection({ transactions: txns, incomeCategories: ['Paycheck'], commissions: [], asOf: new Date(2026, 10, 15, 23, 59, 59, 999) });
    expect(p).toMatchObject({ key: '2026-11', label: 'November 2026', status: 'current', commissionsKnown: true });
    expect(p.income.rows.map(r => r.name)).toEqual(['Base salary', 'Rent received']);
    expect(p.income.projected).toBe(5328 + 2400);
    // Rent and the six largest of the eight small categories, then one fold-in row.
    expect(p.spending.rows).toHaveLength(7);
    expect(p.spending.rows[0]).toMatchObject({ name: 'Rent', actual: 5500, projected: 5500 });
    expect(p.spending.rows[6]).toMatchObject({ name: 'Everything else', other: true });
    // Nothing dated after the week's end is counted.
    expect(p.spending.actual).toBe(5500);
  });

  it('moves on to the new month when the week ends on a month’s last day', async () => {
    const { monthProjection } = await import('./weeklySummary.js');
    const p = monthProjection({ transactions: txns.filter(x => !x.date.startsWith('11/')), incomeCategories: ['Paycheck'], commissions: null, asOf: new Date(2026, 9, 31, 23, 59, 59, 999) });
    expect(p).toMatchObject({ key: '2026-11', status: 'current', commissionsKnown: false });
    expect(p.income.actual).toBe(0);
    expect(p.income.projected).toBe(5328 + 2400);
  });
});
