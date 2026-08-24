import { describe, it, expect } from 'vitest';
import { buildReviewQueue, reviewStats, recentlyCategorized, needsReview, SORTS } from './reviewQueue';

const TXNS = [
  { transactionId: 'n1', date: '2026-08-20', description: 'BLUE BOTTLE COFFEE 442', amount: -7.1, category: '' },
  { transactionId: 'n2', date: '2026-08-19', description: 'BLUE BOTTLE COFFEE 9 OAKLAND CA', amount: -4, category: '' },
  { transactionId: 'n3', date: '2026-08-18', description: 'BIG PLUMBER LLC', amount: -2400, category: 'Uncategorized' },
  { transactionId: 'n4', date: '2025-02-18', description: 'ANCIENT SNACK', amount: -3, category: '' },
  { transactionId: 'n5', date: '2026-08-01', description: 'PAYROLL', amount: 5000, category: 'Income' },
];

describe('needsReview', () => {
  it('treats an empty category and the literal Uncategorized the same', () => {
    expect(needsReview({ category: '' })).toBe(true);
    expect(needsReview({ category: '   ' })).toBe(true);
    expect(needsReview({ category: 'Uncategorized' })).toBe(true);
    expect(needsReview({ category: 'Food & Drink' })).toBe(false);
    expect(needsReview(null)).toBe(false);
  });
});

describe('buildReviewQueue', () => {
  // Forty coffees from one shop is one decision, not forty.
  it('collapses one merchant into a single card, despite store number and city', () => {
    const q = buildReviewQueue(TXNS);
    const coffee = q.find(i => i.txn.description.includes('BLUE BOTTLE'));
    expect(coffee.groupSize).toBe(2);
    expect(coffee.groupTotal).toBeCloseTo(-11.1, 5);
    expect(q).toHaveLength(3);
  });

  it('leads with the charge worth most', () => {
    expect(buildReviewQueue(TXNS, { sort: 'impact' })[0].txn.description).toBe('BIG PLUMBER LLC');
  });

  it('orders by date when asked', () => {
    expect(buildReviewQueue(TXNS, { sort: 'oldest' })[0].txn.description).toBe('ANCIENT SNACK');
    expect(buildReviewQueue(TXNS, { sort: 'newest' })[0].txn.description).toContain('BLUE BOTTLE');
  });

  it('can leave a merchant ungrouped', () => {
    expect(buildReviewQueue(TXNS, { groupByMerchant: false })).toHaveLength(4);
  });

  it('drops whatever was skipped this session', () => {
    const q = buildReviewQueue(TXNS, { skipped: new Set(['n3']) });
    expect(q.map(i => i.txn.description)).not.toContain('BIG PLUMBER LLC');
  });

  // The lead card is the one whose description a person is most likely to
  // recognise, and its amount is what the whole group is worth.
  it('leads a group with its largest charge', () => {
    const q = buildReviewQueue(TXNS);
    const coffee = q.find(i => i.groupSize === 2);
    expect(coffee.txn.transactionId).toBe('n1');
  });

  it('never shows anything already categorized', () => {
    for (const item of buildReviewQueue(TXNS)) {
      for (const member of item.members) expect(needsReview(member)).toBe(true);
    }
  });

  it('copes with an empty list', () => {
    expect(buildReviewQueue([])).toEqual([]);
    expect(buildReviewQueue(null)).toEqual([]);
  });

  it('exposes a label for every sort it accepts', () => {
    for (const id of ['impact', 'newest', 'oldest']) expect(SORTS[id].label).toBeTruthy();
  });
});

describe('reviewStats', () => {
  it('counts what is left and what it is worth', () => {
    const s = reviewStats(TXNS);
    expect(s.count).toBe(4);
    expect(s.categorized).toBe(1);
    expect(s.amount).toBeCloseTo(2414.1, 5);
    expect(s.percentDone).toBeCloseTo(0.2, 5);
  });

  it('calls an empty file done rather than dividing by zero', () => {
    expect(reviewStats([]).percentDone).toBe(1);
  });
});

describe('recentlyCategorized', () => {
  it('floats the user’s own decisions above what the sheet supplied', () => {
    const txns = [
      { transactionId: 'a', date: '2026-01-01', category: 'Food & Drink' },
      { transactionId: 'b', date: '2026-08-01', category: 'Shopping' },
    ];
    expect(recentlyCategorized(txns, { a: 'Food & Drink' }).map(t => t.transactionId)).toEqual(['a', 'b']);
  });

  it('leaves out anything still needing review', () => {
    expect(recentlyCategorized(TXNS, {}).every(t => !needsReview(t))).toBe(true);
  });
});
