import { describe, it, expect } from 'vitest';
import { explainCardChoice, findSuboptimalCharges, classifyRewardCategory } from './cardRewards.js';

const charge = (over = {}) => ({
  transactionId: 't1', date: '2026-09-20', amount: -100, account: 'Sapphire Reserve',
  description: 'Starbucks', category: 'Dining', subcategory: '', ...over,
});

describe('explainCardChoice', () => {
  it('calls the top-paying card the right choice and quotes what matched', () => {
    const x = explainCardChoice(charge(), 'sapphire');
    expect(x.verdict).toBe('best');
    expect(x.categoryKey).toBe('dining');
    expect(x.matched).toBe('dining');
    expect(x.usedRate).toBe(4.5);
    expect(x.missed).toBe(0);
    expect(x.ranking.map(r => r.key)).toEqual(['sapphire', 'prime', 'bofa']);
    expect(x.ranking[0].earned).toBeCloseTo(4.5);
  });

  it('prices the gap when a better card was available', () => {
    const x = explainCardChoice(charge({ description: 'AMZN Mktp', category: 'Shopping' }), 'sapphire');
    expect(x.verdict).toBe('suboptimal');
    expect(x.bestKey).toBe('prime');
    expect(x.missed).toBeCloseTo(3.5);
  });

  it('falls back to the catch-all with nothing to quote', () => {
    const x = explainCardChoice(charge({ description: 'Random Shop', category: 'Misc' }), 'sapphire');
    expect(x.verdict).toBe('best');
    expect(x.matched).toBeNull();
    expect(x.categoryKey).toBe('other');
  });

  it('explains why rows are not scored', () => {
    expect(explainCardChoice(charge({ amount: 25 }), 'sapphire').verdict).toBe('notACharge');
    const rent = explainCardChoice(charge({ category: 'Rent', description: 'Landlord' }), 'sapphire');
    expect(rent.verdict).toBe('excluded');
    expect(rent.excludedReason).toMatch(/rent/);
    expect(explainCardChoice(charge(), 'ignore').verdict).toBe('ignored');
    const unk = explainCardChoice(charge(), null);
    expect(unk.verdict).toBe('unknownCard');
    expect(unk.ranking).toHaveLength(3);
  });
});

describe('findSuboptimalCharges still agrees with the explanation', () => {
  it('flags only the suboptimal charge and carries the source row', () => {
    const txns = [
      charge(),
      charge({ transactionId: 't2', description: 'AMZN Mktp', category: 'Shopping' }),
      charge({ transactionId: 't3', account: 'CREDIT CARD (-1947)' }),
    ];
    const r = findSuboptimalCharges({
      transactions: txns, asOf: new Date('2026-09-24T12:00:00'),
      cardKeyFor: a => (/sapphire/i.test(a) ? 'sapphire' : null),
    });
    expect(r.evaluatedCount).toBe(2);
    expect(r.flagged).toHaveLength(1);
    expect(r.flagged[0].txn.transactionId).toBe('t2');
    expect(r.totalMissed).toBeCloseTo(3.5);
    expect(r.unknownAccounts).toEqual([{ account: 'CREDIT CARD (-1947)', count: 1, total: 100 }]);
  });

  it('classifies with the same patterns as before', () => {
    expect(classifyRewardCategory({ description: 'Shell Oil 123' })).toBe('gas');
    expect(classifyRewardCategory({ category: 'Utilities', description: 'Con Ed gas' })).toBe('other');
  });
});
