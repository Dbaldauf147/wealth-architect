import { describe, it, expect } from 'vitest';
import { summarizeNextCardBill } from './nextCardBill.js';
import { renderWeeklyEmailHtml } from './renderWeeklyEmail.js';

const asOf = new Date('2026-11-09T13:00:00Z'); // Mon Nov 9, 8am Eastern
const pay = (y, m, d, displayName, amount, extra = {}) => ({
  card: displayName, displayName, date: new Date(y, m - 1, d), amount,
  statementClosed: true, statementClose: new Date(y, m - 1, d - 25), ...extra,
});
const checking = { name: 'BoA Checking (…1118)', balance: 5000, updated: '11/8/2026' };

describe('summarizeNextCardBill', () => {
  it('takes the soonest payment and subtracts it from checking', () => {
    const bill = summarizeNextCardBill({
      payments: [pay(2026, 11, 20, 'Sapphire', 800), pay(2026, 11, 14, 'Prime Visa', 1234.56)],
      payingAccount: checking, asOf,
    });
    expect(bill.dateKey).toBe('2026-11-14');
    expect(bill.daysAway).toBe(5);
    expect(bill.total).toBe(1234.56);
    expect(bill.leftAfter).toBe(3765.44);
    expect(bill.later).toEqual([expect.objectContaining({ name: 'Sapphire', amount: 800, leftAfter: 2965.44 })]);
  });

  it('adds up cards due the same day', () => {
    const bill = summarizeNextCardBill({
      payments: [pay(2026, 11, 14, 'A', 100), pay(2026, 11, 14, 'B', 50)],
      payingAccount: checking, asOf,
    });
    expect(bill.cards).toHaveLength(2);
    expect(bill.total).toBe(150);
    expect(bill.leftAfter).toBe(4850);
  });

  it('skips past and zero payments, and works without a checking account', () => {
    const bill = summarizeNextCardBill({
      payments: [pay(2026, 11, 2, 'Old', 99), pay(2026, 11, 12, 'Zero', 0), pay(2026, 12, 1, 'Next', 10)],
      payingAccount: null, asOf,
    });
    expect(bill.cards[0].name).toBe('Next');
    expect(bill.leftAfter).toBeNull();
  });

  it('returns null with nothing upcoming', () => {
    expect(summarizeNextCardBill({ payments: [], payingAccount: checking, asOf })).toBeNull();
  });
});

describe('weekly email next-card-bill block', () => {
  const base = {
    range: { start: '2026-11-02', end: '2026-11-08' },
    expenseTotal: 0, priorTotal: 0, wowDelta: 0, wowPct: 0,
    topCategories: [], topMerchants: [], uncategorized: [],
    transactionCount: 0, uncategorizedCount: 0,
    monthlyTrends: null, monthCompare: null, weekCompare: null,
    aboveRange: [], suboptimalCards: null, cardPromos: null,
  };

  it('renders first, above the other sections', () => {
    const nextCardBill = summarizeNextCardBill({ payments: [pay(2026, 11, 14, 'Prime Visa', 1234.56)], payingAccount: checking, asOf });
    const html = renderWeeklyEmailHtml({ ...base, nextCardBill });
    const i = html.indexOf('Next card bill');
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(html.indexOf('Uncategorized') === -1 ? html.indexOf('Everything categorized') : html.indexOf('Uncategorized'));
    expect(html).toContain('$1,234.56');
    expect(html).toContain('Due Saturday, November 14');
    expect(html).toContain('$5,000.00');
    expect(html).toContain('$3,765.44');
  });

  it('is absent when there is no bill', () => {
    expect(renderWeeklyEmailHtml({ ...base, nextCardBill: null })).not.toContain('Next card bill');
  });
});
