import { describe, it, expect } from 'vitest';
import { monthKeyOf, parseDefault, parseMonth, sameSet } from './monthFilter.js';

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
