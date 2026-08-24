import { describe, it, expect } from 'vitest';
import {
  merchantTokens, merchantKey, looseMerchantKey, ruleDescriptionFor,
  buildHistoryIndex, suggestCategories, findSameMerchant, LOW_CONFIDENCE,
} from './suggest';
import { ruleMatches, normalizeDesc } from './categorize';

const NOW = new Date('2026-08-23');

const HISTORY = [
  { date: '2026-08-01', description: 'SQ *BLUE BOTTLE COFFEE OAKLAND', amount: -6.5, category: 'Food & Drink', transactionId: 'h1' },
  { date: '2026-07-11', description: 'BLUE BOTTLE COFFEE #77', amount: -5.25, category: 'Food & Drink', transactionId: 'h2' },
  { date: '2026-06-11', description: 'BLUE BOTTLE COFFEE #77', amount: -5.25, category: 'Food & Drink', transactionId: 'h3' },
  { date: '2026-08-02', description: 'SHELL OIL 5711', amount: -48.1, category: 'Transportation', transactionId: 'h4' },
  { date: '2026-07-02', description: 'SHELL OIL 2211', amount: -51, category: 'Transportation', transactionId: 'h5' },
  { date: '2026-08-05', description: 'CON EDISON PAYMENT', amount: -140, category: 'Bills & Utilities', transactionId: 'h6' },
  { date: '2026-08-05', description: 'AMAZON MKTPLACE', amount: -30, category: 'Shopping', transactionId: 'h7' },
  { date: '2026-07-05', description: 'AMAZON MKTPLACE', amount: -22.4, category: 'Shopping', transactionId: 'h8' },
  { date: '2026-06-05', description: 'AMAZON MKTPLACE', amount: -12, category: 'Household', transactionId: 'h9' },
];

const index = buildHistoryIndex(HISTORY, { now: NOW });
const top = (desc, opts) => suggestCategories({ description: desc, amount: -10 }, index, opts)[0];

describe('merchantTokens', () => {
  it('drops card-network noise and store numbers', () => {
    expect(merchantTokens('CHECKCARD 0412 STARBUCKS STORE 09876 SEATTLE WA'))
      .toEqual(['starbucks', 'seattle', 'wa']);
  });

  it('finds nothing identifying in a pure junk description', () => {
    expect(merchantTokens('ACH DEBIT 12345')).toEqual([]);
  });
});

describe('merchantKey', () => {
  it('keys the same shop the same way despite a prefix and a store number', () => {
    expect(merchantKey('SQ *BLUE BOTTLE COFFEE 1234 OAKLAND CA'))
      .toBe(merchantKey('POS DEBIT BLUE BOTTLE COFFEE #77'));
  });

  // The precise key is three words, so an appended city splits a merchant in
  // two. The loose key is what puts them back together.
  it('falls back to two words when a city gets appended', () => {
    expect(merchantKey('SHELL OIL 5711')).not.toBe(merchantKey('SHELL OIL 9987 BROOKLYN NY'));
    expect(looseMerchantKey('SHELL OIL 5711')).toBe(looseMerchantKey('SHELL OIL 9987 BROOKLYN NY'));
  });
});

describe('ruleDescriptionFor', () => {
  // A rule matches by plain substring, so whatever it returns has to appear
  // verbatim in the description — reordered or de-punctuated words would
  // produce a rule that matches nothing.
  it('returns a run of words that really appears in the description', () => {
    for (const desc of [
      'SQ *BLUE BOTTLE COFFEE OAKLAND',
      'SHELL OIL 5711 BROOKLYN NY',
      'CON EDISON PAYMENT',
      'AMAZON MKTPLACE US',
    ]) {
      const rule = ruleDescriptionFor(desc);
      expect(rule.length).toBeGreaterThan(0);
      expect(normalizeDesc(desc)).toContain(rule);
    }
  });

  it('produces a rule that actually matches its own transaction', () => {
    const txn = { description: 'SQ *BLUE BOTTLE COFFEE OAKLAND', amount: -6.5 };
    const rule = { description: ruleDescriptionFor(txn.description), category: 'Food & Drink' };
    expect(ruleMatches(rule, txn)).toBe(true);
  });

  it('refuses to build a rule from a description with nothing in it', () => {
    expect(ruleDescriptionFor('ACH DEBIT 12345')).toBe('');
    expect(ruleDescriptionFor('POS 4411')).toBe('');
  });
});

describe('suggestCategories', () => {
  it('recognises a merchant it has seen before, through the noise', () => {
    const s = top('POS DEBIT BLUE BOTTLE COFFEE 442');
    expect(s.category).toBe('Food & Drink');
    expect(s.source).toBe('merchant');
    expect(s.confidence).toBeGreaterThan(0.8);
  });

  it('matches a merchant even when a city is appended', () => {
    const s = top('SHELL OIL 9987 BROOKLYN NY');
    expect(s.category).toBe('Transportation');
    expect(s.confidence).toBeGreaterThan(LOW_CONFIDENCE);
  });

  it('prefers the category a split merchant is usually filed under', () => {
    const all = suggestCategories({ description: 'AMAZON MKTPLACE US', amount: -19 }, index, { limit: 3 });
    expect(all[0].category).toBe('Shopping');
    expect(all.map(s => s.category)).toContain('Household');
  });

  it('offers most-used categories, marked as a shrug, when nothing matches', () => {
    const all = suggestCategories({ description: 'ZZQ UNKNOWN VENDOR 8817', amount: -63 }, index, { limit: 3 });
    expect(all.length).toBeGreaterThan(0);
    expect(all.every(s => s.source === 'common')).toBe(true);
    expect(all.every(s => s.confidence < LOW_CONFIDENCE)).toBe(true);
  });

  it('lets a rule the user wrote beat anything inferred', () => {
    const s = top('BLUE BOTTLE COFFEE #77', { rules: [{ category: 'Entertainment' }] });
    expect(s.category).toBe('Entertainment');
    expect(s.confidence).toBe(1);
    expect(s.source).toBe('rule');
  });

  it('always explains itself', () => {
    for (const desc of ['BLUE BOTTLE COFFEE #77', 'ZZQ UNKNOWN VENDOR', 'CON EDISON']) {
      for (const s of suggestCategories({ description: desc, amount: -10 }, index, { limit: 3 })) {
        expect(s.reason).toBeTruthy();
      }
    }
  });

  it('never suggests Uncategorized', () => {
    const withUncat = buildHistoryIndex(
      [...HISTORY, { date: '2026-08-01', description: 'MYSTERY', amount: -1, category: 'Uncategorized' }],
      { now: NOW },
    );
    const all = suggestCategories({ description: 'MYSTERY', amount: -1 }, withUncat, { limit: 5 });
    expect(all.map(s => s.category)).not.toContain('Uncategorized');
  });

  it('has nothing to say with no history at all', () => {
    expect(suggestCategories({ description: 'ANYTHING', amount: -5 }, buildHistoryIndex([], { now: NOW }))).toEqual([]);
  });
});

describe('findSameMerchant', () => {
  it('finds the uncategorized siblings and leaves the filed ones alone', () => {
    const pending = [
      { transactionId: 'n1', description: 'POS DEBIT BLUE BOTTLE COFFEE 442', amount: -7.1, category: '' },
      { transactionId: 'n2', description: 'BLUE BOTTLE COFFEE 9 SF CA', amount: -4, category: '' },
      { transactionId: 'n3', description: 'SHELL OIL 1', amount: -40, category: '' },
      { transactionId: 'n4', description: 'BLUE BOTTLE COFFEE 3', amount: -5, category: 'Food & Drink' },
    ];
    expect(findSameMerchant(pending[0], pending).map(t => t.transactionId)).toEqual(['n2']);
    expect(findSameMerchant(pending[0], pending, { includeCategorized: true }).map(t => t.transactionId))
      .toEqual(['n2', 'n4']);
  });
});
