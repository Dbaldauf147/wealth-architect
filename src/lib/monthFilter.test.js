import { describe, it, expect } from 'vitest';
import { monthKeyOf, parseDefault, parseMonth, sameSet } from './monthFilter.js';
import { normalizeSpendPrefs, activeHidden, mergeSpendPrefs, spendPrefsFromLegacy } from './monthFilter.js';

describe('monthFilter', () => {
  it('keys a date by its local month', () => {
    expect(monthKeyOf(new Date(2026, 10, 22))).toBe('2026-11');
    expect(monthKeyOf(new Date(2027, 0, 1))).toBe('2027-01');
  });

  it('reads the default, tolerating junk', () => {
    expect(parseDefault('["Rent","Boat"]')).toEqual(['Rent', 'Boat']);
    expect(parseDefault(null)).toEqual([]);
    expect(parseDefault('{oops')).toEqual([]);
    expect(parseDefault('{"a":1}')).toEqual([]);
  });

  it("uses this month's filter only in the month it was made", () => {
    const raw = JSON.stringify({ month: '2026-11', hidden: ['Rent'] });
    expect(parseMonth(raw, '2026-11')).toEqual(['Rent']);
    expect(parseMonth(raw, '2026-12')).toBeNull();
    expect(parseMonth(JSON.stringify({ month: '2026-11', hidden: [] }), '2026-11')).toEqual([]);
    expect(parseMonth(null, '2026-11')).toBeNull();
    expect(parseMonth('nope', '2026-11')).toBeNull();
  });

  it('compares sets', () => {
    expect(sameSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameSet(new Set(['a']), new Set(['a', 'b']))).toBe(false);
  });
});

describe('the synced prefs', () => {
  it('tidies whatever was stored', () => {
    expect(normalizeSpendPrefs(null)).toEqual({ hidden: [], month: null, monthHidden: [], expected: {}, updatedAt: 0 });
    expect(normalizeSpendPrefs({ hidden: ['Travel', 3], monthHidden: ['Boat'], expected: { Rent: 5000, Bad: 'x', Neg: -1 }, updatedAt: '9' }))
      .toEqual({ hidden: ['Travel'], month: null, monthHidden: [], expected: { Rent: 5000 }, updatedAt: 9 });
  });

  it('uses this month’s filter in its month and the default in any other', () => {
    const p = { hidden: ['Travel'], month: '2026-11', monthHidden: ['Travel', 'Boat'] };
    expect(activeHidden(p, '2026-11')).toEqual(['Travel', 'Boat']);
    expect(activeHidden(p, '2026-12')).toEqual(['Travel']);
    expect(activeHidden(null, '2026-11')).toEqual([]);
  });

  it('keeps the copy changed most recently', () => {
    const a = { hidden: ['A'], updatedAt: 5 };
    const b = { hidden: ['B'], updatedAt: 9 };
    expect(mergeSpendPrefs(a, b).hidden).toEqual(['B']);
    expect(mergeSpendPrefs(b, a).hidden).toEqual(['B']);
    expect(mergeSpendPrefs(null, b).hidden).toEqual(['B']);
    expect(mergeSpendPrefs(a, undefined).hidden).toEqual(['A']);
    expect(mergeSpendPrefs(null, undefined).hidden).toEqual([]);
  });

  it('carries over what the browser held before it synced', () => {
    const p = spendPrefsFromLegacy({ hidden: '["Travel"]', monthHidden: '{"month":"2026-11","hidden":["Travel","Boat"]}', expected: '{"Rent":5510}' });
    expect(p).toEqual({ hidden: ['Travel'], month: '2026-11', monthHidden: ['Travel', 'Boat'], expected: { Rent: 5510 }, updatedAt: 1 });
    expect(spendPrefsFromLegacy({ hidden: null, monthHidden: 'garbage', expected: null }).updatedAt).toBe(0);
    // Anything saved since wins over the carried-over copy.
    expect(mergeSpendPrefs(p, { hidden: [], updatedAt: 1700000000000 }).hidden).toEqual([]);
  });
});
