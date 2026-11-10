import { describe, it, expect } from 'vitest';
import { newWatchRule, matchingWatchRules, flaggedTransactions, watchRuleCounts, watchRuleHasFilter, describeWatchRule } from './watchedVendors.js';

const txns = [
  { transactionId: 'a', description: 'DOORDASH*CHIPOTLE', amount: -24.5 },
  { transactionId: 'b', description: 'DoorDash refund', amount: 12 },
  { transactionId: 'c', description: 'SHELL OIL 5732', amount: -60 },
  { transactionId: 'd', description: 'Amazon', fullDescription: 'AMAZON MKTPL*2K4 DOORDASH GIFT', amount: -100 },
];

describe('watchedVendors', () => {
  it('normalizes form input', () => {
    const r = newWatchRule({ description: '  doordash ', sign: 'negative', minAmount: '20', maxAmount: '' });
    expect(r).toMatchObject({ description: 'doordash', sign: 'negative', minAmount: 20, maxAmount: null, note: '' });
    expect(r.id).toMatch(/^watch_/);
    expect(newWatchRule({ sign: 'bogus' }).sign).toBeNull();
  });

  it('matches with the auto-categorization filters', () => {
    const any = newWatchRule({ id: 'any', description: 'doordash' });
    const charges = newWatchRule({ id: 'neg', description: 'doordash', sign: 'negative', maxAmount: 50 });
    expect(flaggedTransactions(txns, [any]).map(t => t.transactionId)).toEqual(['a', 'b', 'd']);
    expect(flaggedTransactions(txns, [charges]).map(t => t.transactionId)).toEqual(['a']);
    expect(matchingWatchRules(txns[0], [any, charges]).map(r => r.id)).toEqual(['any', 'neg']);
    expect(watchRuleCounts(txns, [any, charges])).toEqual({ any: 3, neg: 1 });
  });

  it('never flags with an empty rule', () => {
    const empty = { id: 'e', description: '', sign: null, minAmount: null, maxAmount: null };
    expect(watchRuleHasFilter(empty)).toBe(false);
    expect(flaggedTransactions(txns, [empty])).toEqual([]);
    expect(flaggedTransactions(txns, [])).toEqual([]);
  });

  it('describes a rule', () => {
    expect(describeWatchRule(newWatchRule({ description: 'shell', sign: 'negative', minAmount: 50 }))).toBe('contains "shell" · charges only · ≥ $50');
  });
});
