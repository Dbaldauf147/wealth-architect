import { describe, it, expect } from 'vitest';
import {
  periodWindowStart,
  isPromoCompleted,
  promoHasAutoMatch,
  transactionMatchesPromo,
  matchingTransactions,
  autoUsedForPromo,
  effectiveUsedFor,
  summarizeCardPromos,
  promoIsTracked,
  promoTagCounts,
} from './cardPromos.js';

// A fixed "now" so cycle boundaries are assertable: Tue 2026-08-25.
const NOW = new Date(2026, 7, 25);

const travelPromo = {
  id: 'travel',
  card: 'Chase Sapphire Reserve',
  name: '$300 Annual Travel Credit',
  value: 300,
  period: 'annual',
  matchSubcategory: 'Travel Credit',
};

const lyftPromo = {
  id: 'lyft',
  card: 'Chase Sapphire Reserve',
  name: '$10 Monthly Lyft Credit',
  value: 10,
  period: 'monthly',
  matchDescription: 'Lyft',
};

const manualPromo = {
  id: 'manual',
  card: 'Chase Sapphire Reserve',
  name: 'Priority Pass Select',
  value: 469,
  used: 100,
  period: 'annual',
};

describe('periodWindowStart', () => {
  it('starts monthly at the first of the month', () => {
    expect(periodWindowStart('monthly', NOW)).toEqual(new Date(2026, 7, 1));
  });

  it('starts quarterly at the first month of the quarter', () => {
    expect(periodWindowStart('quarterly', NOW)).toEqual(new Date(2026, 6, 1));
  });

  it('starts annual at January 1', () => {
    expect(periodWindowStart('annual', NOW)).toEqual(new Date(2026, 0, 1));
  });

  it('has no window for a one-time benefit', () => {
    expect(periodWindowStart('one-time', NOW)).toBeNull();
  });
});

describe('isPromoCompleted', () => {
  it('counts a mark made inside the current cycle', () => {
    expect(isPromoCompleted({ ...lyftPromo, completedAt: '2026-08-03' }, NOW)).toBe(true);
  });

  it('ignores a mark from a previous cycle', () => {
    // Ticked in July; August is a new month, so the credit is unused again.
    expect(isPromoCompleted({ ...lyftPromo, completedAt: '2026-07-30' }, NOW)).toBe(false);
  });

  it('keeps a one-time benefit completed forever', () => {
    const p = { id: 'x', period: 'one-time', value: 100, completedAt: '2019-01-01' };
    expect(isPromoCompleted(p, NOW)).toBe(true);
  });

  it('is false when never marked', () => {
    expect(isPromoCompleted(lyftPromo, NOW)).toBe(false);
  });
});

describe('transactionMatchesPromo', () => {
  it('matches on subcategory', () => {
    expect(transactionMatchesPromo({ subcategory: 'Travel Credit' }, travelPromo)).toBe(true);
  });

  it('matches a description in either direction', () => {
    expect(transactionMatchesPromo({ description: 'LYFT *RIDE 3PM' }, { matchDescription: 'lyft *ride 3pm' })).toBe(true);
    expect(transactionMatchesPromo({ description: 'Lyft' }, lyftPromo)).toBe(true);
  });

  it('falls back to the full description', () => {
    expect(transactionMatchesPromo({ description: 'PURCHASE', fullDescription: 'LYFT RIDE 0824' }, lyftPromo)).toBe(true);
  });

  it('does not match a promo with no rules at all', () => {
    expect(transactionMatchesPromo({ description: 'Lyft' }, manualPromo)).toBe(false);
    expect(promoHasAutoMatch(manualPromo)).toBe(false);
  });
});

describe('autoUsedForPromo', () => {
  const txns = [
    { date: '2026-08-10', description: 'Lyft ride', amount: -6 },
    { date: '2026-07-12', description: 'Lyft ride', amount: -9 },
    { date: '2026-08-14', description: 'Coffee', amount: -4 },
  ];

  it('only counts charges inside the current cycle', () => {
    expect(autoUsedForPromo(lyftPromo, txns, NOW)).toBe(6);
  });

  it('counts either sign, so a charge or a statement credit both track', () => {
    const credits = [{ date: '2026-08-10', description: 'Lyft credit', amount: 6 }];
    expect(autoUsedForPromo(lyftPromo, credits, NOW)).toBe(6);
  });

  it('returns null for a hand-tracked promo so the typed value wins', () => {
    expect(autoUsedForPromo(manualPromo, txns, NOW)).toBeNull();
    expect(effectiveUsedFor(manualPromo, txns, NOW)).toBe(100);
  });

  it('lets a completion mark override the transaction total', () => {
    const p = { ...lyftPromo, completedAt: '2026-08-02' };
    expect(effectiveUsedFor(p, txns, NOW)).toBe(10);
  });
});

describe('matchingTransactions', () => {
  const txns = [
    { date: '2026-07-12', description: 'Lyft ride', amount: -9 },
    { date: '2026-08-10', description: 'Lyft ride', amount: -6 },
    { date: '2026-08-14', description: 'Coffee', amount: -4 },
  ];

  it('returns matches newest first, reaching past the current cycle', () => {
    const found = matchingTransactions(lyftPromo, txns);
    expect(found).toHaveLength(2);
    expect(found[0].date).toBe('2026-08-10');
    expect(found[1].date).toBe('2026-07-12');
  });

  it('returns nothing for a promo with no match rules', () => {
    expect(matchingTransactions(manualPromo, txns)).toEqual([]);
  });
});

describe('summarizeCardPromos', () => {
  const txns = [
    { date: '2026-08-10', description: 'Lyft ride', amount: -6, account: 'CSR' },
    { date: '2026-03-02', description: 'Delta flight', subcategory: 'Travel Credit', amount: -220, account: 'CSR' },
  ];

  it('reports the most recent transaction per promo', () => {
    const s = summarizeCardPromos({ promos: [lyftPromo, travelPromo], transactions: txns, asOf: NOW });
    const lyft = s.items.find(i => i.id === 'lyft');
    expect(lyft.lastTransaction).toMatchObject({ description: 'Lyft ride', amount: 6, account: 'CSR' });
    expect(lyft.lastTransaction.inCurrentCycle).toBe(true);
  });

  it('flags a last charge that predates the current cycle', () => {
    // A monthly credit whose only hit was in March: used is 0 for August, but
    // the last-charge date still tells you when it was last touched.
    const marchOnly = [{ date: '2026-03-04', description: 'Lyft ride', amount: -8 }];
    const s = summarizeCardPromos({ promos: [lyftPromo], transactions: marchOnly, asOf: NOW });
    expect(s.items[0].used).toBe(0);
    expect(s.items[0].lastTransaction.inCurrentCycle).toBe(false);
  });

  it('reports no transaction for a hand-tracked promo', () => {
    const s = summarizeCardPromos({ promos: [manualPromo], transactions: txns, asOf: NOW });
    expect(s.items[0].lastTransaction).toBeNull();
    expect(s.items[0].tracked).toBe(false);
  });

  it('never counts more used than the promo is worth', () => {
    // $900 of matching travel against a $300 credit is used up, not 300%.
    const lots = [
      { date: '2026-02-01', subcategory: 'Travel Credit', amount: -500 },
      { date: '2026-04-01', subcategory: 'Travel Credit', amount: -400 },
    ];
    const s = summarizeCardPromos({ promos: [travelPromo], transactions: lots, asOf: NOW });
    expect(s.items[0].remaining).toBe(0);
    expect(s.totalUsed).toBe(300);
    expect(s.remaining).toBe(0);
  });

  it('ranks by what is still unclaimed and caps the list', () => {
    const many = [travelPromo, lyftPromo, manualPromo];
    const s = summarizeCardPromos({ promos: many, transactions: [], asOf: NOW, limit: 2 });
    expect(s.items.map(i => i.id)).toEqual(['manual', 'travel']);
    expect(s.moreCount).toBe(1);
    expect(s.count).toBe(3);
  });

  it('totals value and remaining across every promo', () => {
    const s = summarizeCardPromos({ promos: [lyftPromo, travelPromo], transactions: txns, asOf: NOW });
    expect(s.totalValue).toBe(310);
    expect(s.totalUsed).toBe(226);
    expect(s.remaining).toBe(84);
  });

  it('handles an empty promo list without dividing by zero', () => {
    const s = summarizeCardPromos({ promos: [], transactions: txns, asOf: NOW });
    expect(s).toMatchObject({ totalValue: 0, totalUsed: 0, remaining: 0, pct: 0, count: 0, moreCount: 0 });
    expect(s.items).toEqual([]);
  });
});

/* ── Hand-tagging transactions to a promo ── */

describe('promo tags', () => {
  const hotel = { transactionId: 'txn-hotel', date: '2026-08-05', description: 'Hyatt Regency', amount: -450 };
  const coffee = { transactionId: 'txn-coffee', date: '2026-08-14', description: 'Coffee', amount: -4 };
  const lyft = { transactionId: 'txn-lyft', date: '2026-08-10', description: 'Lyft ride', amount: -6 };

  it('counts a tagged charge against a promo with no match rules at all', () => {
    const tags = { 'txn-hotel': 'manual' };
    expect(promoIsTracked(manualPromo, tags)).toBe(true);
    expect(autoUsedForPromo(manualPromo, [hotel, coffee], NOW, tags)).toBe(450);
    // The typed "used" value no longer applies once tags are doing the counting.
    expect(effectiveUsedFor(manualPromo, [hotel, coffee], NOW, tags)).toBe(450);
  });

  it('leaves an untagged promo on its typed value', () => {
    expect(promoIsTracked(manualPromo, {})).toBe(false);
    expect(effectiveUsedFor(manualPromo, [hotel], NOW, {})).toBe(100);
  });

  it('keeps a tagged transaction out of every other promo that would have claimed it', () => {
    const tags = { 'txn-lyft': 'manual' };
    // Lyft's description rule matches this charge, but the tag sends it elsewhere.
    expect(autoUsedForPromo(lyftPromo, [lyft], NOW, tags)).toBe(0);
    expect(autoUsedForPromo(manualPromo, [lyft], NOW, tags)).toBe(6);
  });

  it('still honours a promo\'s own rules for untagged transactions', () => {
    const tags = { 'txn-hotel': 'manual' };
    expect(autoUsedForPromo(lyftPromo, [lyft, hotel], NOW, tags)).toBe(6);
  });

  it('respects the cycle window for tagged charges too', () => {
    const old = { transactionId: 'txn-old', date: '2026-07-02', description: 'Lyft ride', amount: -8 };
    const tags = { 'txn-old': 'lyft' };
    expect(autoUsedForPromo(lyftPromo, [old], NOW, tags)).toBe(0);
    // matchingTransactions reaches past the cycle on purpose.
    expect(matchingTransactions(lyftPromo, [old], tags)).toHaveLength(1);
  });

  it('marks which matches came from a tag', () => {
    const tags = { 'txn-hotel': 'lyft' };
    const found = matchingTransactions(lyftPromo, [lyft, hotel], tags);
    expect(found.map(f => [f.transactionId, f._tagged])).toEqual([
      ['txn-lyft', false],
      ['txn-hotel', true],
    ]);
  });

  it('counts tags per promo, ignoring cleared ones', () => {
    expect(promoTagCounts({ a: 'travel', b: 'travel', c: 'lyft', d: '' })).toEqual({ travel: 2, lyft: 1 });
  });

  it('reports tagged spend and tag counts through the summary', () => {
    const s = summarizeCardPromos({
      promos: [manualPromo],
      transactions: [hotel, coffee],
      asOf: NOW,
      promoTags: { 'txn-hotel': 'manual' },
    });
    expect(s.items[0]).toMatchObject({ id: 'manual', used: 450, tracked: true, taggedCount: 1 });
    // A $469 benefit with $450 tagged to it still has $19 left.
    expect(s.items[0].remaining).toBe(19);
  });
});
