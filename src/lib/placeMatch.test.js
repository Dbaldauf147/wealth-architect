import { describe, it, expect } from 'vitest';
import { merchantKey, nameScore, suggestPlace, isEatingOutCharge, isoDay } from './placeMatch.js';

describe('merchantKey', () => {
  it('strips processor prefixes, store numbers and tails', () => {
    expect(merchantKey('Tst* Radegast Hall and Bi')).toBe('radegast hall and bi');
    expect(merchantKey('TST*FEED AND GRAIN')).toBe('feed and grain');
    expect(merchantKey('Sq *copper Mug Coffee')).toBe('copper mug coffee');
    expect(merchantKey('Dd *doordash Narachick')).toBe('narachick');
    expect(merchantKey('Wendys 2514')).toBe('wendys');
    expect(merchantKey('Starbucks Store X7220')).toBe('starbucks store');
    expect(merchantKey('TRADER JOE S #123 NEW YORK NY')).toBe('trader joe s');
    expect(merchantKey("Tst* Abe's Pagoda Bar - 1")).toBe("abe's pagoda bar");
  });
  it('gives the same key to the same merchant however it was cased', () => {
    expect(merchantKey('SQ *COPPER MUG COFFEE')).toBe(merchantKey('Sq *copper Mug Coffee'));
  });
});

describe('nameScore', () => {
  it('matches a bank-truncated name to the full spot name', () => {
    expect(nameScore('radegast hall and bi', 'Radegast Hall & Biergarten')).toBe(0.9);
    expect(nameScore('narachick', 'NaraChick')).toBe(1);
  });
  it('scores shared words when neither is a prefix', () => {
    expect(nameScore('kuku korean cuisine', 'Kuku Korean')).toBeGreaterThanOrEqual(0.5);
  });
  it('does not match short or unrelated names', () => {
    expect(nameScore('bar', 'Barbuto')).toBeLessThan(0.5);
    expect(nameScore('copper mug coffee', 'Sweetgreen')).toBe(0);
  });
});

describe('suggestPlace', () => {
  const places = [
    { id: 'rad', name: 'Radegast Hall & Biergarten' },
    { id: 'cava', name: 'CAVA' },
    { id: 'fg', name: 'Feed and Grain' },
  ];
  it('prefers a remembered rule over a name guess', () => {
    const s = suggestPlace('Tst*feed and Grain', places, { 'feed and grain': { placeId: 'rad' } });
    expect(s.place.id).toBe('rad');
    expect(s.via).toBe('rule');
  });
  it('falls back to the name, and ignores a rule pointing at a deleted spot', () => {
    const s = suggestPlace('Tst*feed and Grain', places, { 'feed and grain': { placeId: 'gone' } });
    expect(s).toMatchObject({ via: 'name', place: { id: 'fg' } });
  });
  it('returns null when nothing is close', () => {
    expect(suggestPlace('Sq *xixa', places, {})).toBeNull();
  });
});

describe('helpers', () => {
  it('picks out eating-out charges, not refunds or other categories', () => {
    expect(isEatingOutCharge({ amount: -12, category: 'Restaurants' })).toBe(true);
    expect(isEatingOutCharge({ amount: 12, category: 'Restaurants' })).toBe(false);
    expect(isEatingOutCharge({ amount: -12, category: 'Alcohol' })).toBe(true);
    expect(isEatingOutCharge({ amount: -12, category: 'Groceries' })).toBe(false);
  });
  it('turns ledger dates into ISO days', () => {
    expect(isoDay('9/2/2026')).toBe('2026-09-02');
    expect(isoDay('2026-09-02')).toBe('2026-09-02');
    expect(isoDay('nope')).toBe('');
  });
});
