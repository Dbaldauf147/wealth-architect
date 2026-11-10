import { describe, it, expect } from 'vitest';
import { newWatchRule, matchingWatchRules, flaggedTransactions, watchRuleCounts, watchRuleHasFilter, describeWatchRule, newFlaggedTransactions, renderWatchedVendorEmail } from './watchedVendors.js';

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

describe('watchedVendors emails', () => {
  const rule = newWatchRule({ id: 'dd', description: 'doordash', sign: 'negative' });
  const ledger = [
    { transactionId: 'a', date: '2026-11-01', description: 'DOORDASH*CHIPOTLE', amount: -24.5 },
    { transactionId: 'c', date: '2026-11-02', description: 'SHELL', amount: -60 },
  ];

  it('baselines a new rule without emailing', () => {
    const r = newFlaggedTransactions([rule], ledger, new Map());
    expect(r.notify).toEqual([]);
    expect(r.baselined).toEqual(['dd']);
    expect(r.nextState.get('dd').seen).toEqual(['a']);
  });

  it('emails only transactions not seen before, once', () => {
    const { nextState } = newFlaggedTransactions([rule], ledger, new Map());
    const more = [...ledger, { transactionId: 'e', date: '2026-11-05', description: 'DOORDASH*SWEETGREEN', amount: -80 }];
    const r = newFlaggedTransactions([rule], more, nextState);
    expect(r.notify.map(n => n.transactions.map(t => t.transactionId))).toEqual([['e']]);
    expect(newFlaggedTransactions([rule], more, r.nextState).notify).toEqual([]);
  });

  it('re-baselines when the filters change, and respects email off', () => {
    const { nextState } = newFlaggedTransactions([rule], ledger, new Map());
    const wider = { ...rule, sign: null };
    expect(newFlaggedTransactions([wider], [...ledger, { transactionId: 'r', date: '2026-11-03', description: 'DoorDash refund', amount: 5 }], nextState).baselined).toEqual(['dd']);
    const muted = { ...rule, email: false };
    const r = newFlaggedTransactions([muted], [...ledger, { transactionId: 'e', date: '2026-11-05', description: 'DOORDASH X', amount: -8 }], nextState);
    expect(r.notify).toEqual([]);
    expect(r.nextState.get('dd').seen).toContain('e');
  });

  it('renders a subject and escaped body', () => {
    const { subject, html } = renderWatchedVendorEmail([{ rule: { ...rule, note: '<b>too much</b>' }, transactions: [ledger[0]] }], { siteUrl: 'https://x' });
    expect(subject).toBe('Flagged vendor: new transaction at doordash');
    expect(html).toContain('&lt;b&gt;too much');
    expect(html).toContain('$24.50');
    expect(html).toContain('https://x/#transactions');
  });
});
