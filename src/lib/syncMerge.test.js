import { describe, it, expect } from 'vitest';
import { mergePromos, mergeTrades } from './syncMerge.js';

const promo = (id, over = {}) => ({ id, card: 'Chase Sapphire Reserve', name: id, value: 100, ...over });

describe('mergePromos', () => {
  it('keeps a promo added on another device when this one holds an older list', () => {
    const { promos } = mergePromos([promo('a')], [promo('a'), promo('b')]);
    expect(promos.map(p => p.id)).toEqual(['a', 'b']);
  });

  it('keeps a promo added here that the cloud has not seen', () => {
    const { promos } = mergePromos([promo('a'), promo('c')], [promo('a')]);
    expect(promos.map(p => p.id).sort()).toEqual(['a', 'c']);
  });

  it('without stamps, takes the cloud copy of a promo both sides have', () => {
    const { promos } = mergePromos([promo('a', { value: 1 })], [promo('a', { value: 2 })]);
    expect(promos[0].value).toBe(2);
  });

  it('lets a newer cloud list win outright, so deletions stick', () => {
    const remote = [promo('a')];
    const r = mergePromos([promo('a'), promo('b')], remote, '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z');
    expect(r.promos).toBe(remote);
    expect(r.at).toBe('2026-10-05T00:00:00Z');
  });

  it("takes this device's edits when they're newer, and keeps the cloud's extra promos", () => {
    const r = mergePromos(
      [promo('a', { value: 9 })], [promo('a', { value: 1 }), promo('b')],
      '2026-10-06T00:00:00Z', '2026-10-05T00:00:00Z',
    );
    expect(r.promos.map(p => [p.id, p.value])).toEqual([['a', 9], ['b', 100]]);
    expect(r.at).toBe('2026-10-06T00:00:00Z');
  });

  it('keeps "never set up" (null) apart from "deleted them all" ([])', () => {
    expect(mergePromos(null, null).promos).toBeNull();
    expect(mergePromos(null, [promo('a')]).promos).toHaveLength(1);
    expect(mergePromos([], null).promos).toEqual([]);
  });
});

describe('mergeTrades', () => {
  const imp = (importedAt, n = 1) => ({ importedAt, trades: Array.from({ length: n }, (_, i) => ({ id: i })) });

  it('keeps the newer import, whichever side it is on', () => {
    const older = imp('2026-09-01T00:00:00Z', 3);
    const newer = imp('2026-10-01T00:00:00Z', 5);
    expect(mergeTrades(older, newer)).toBe(newer);
    expect(mergeTrades(newer, older)).toBe(newer);
  });

  it('falls back to the cloud copy when there is no stamp to compare', () => {
    const remote = { trades: [{ id: 1 }] };
    expect(mergeTrades({ trades: [] }, remote)).toBe(remote);
  });

  it('falls back to whichever side exists', () => {
    const t = imp('2026-10-01T00:00:00Z');
    expect(mergeTrades(null, t)).toBe(t);
    expect(mergeTrades(t, null)).toBe(t);
    expect(mergeTrades(null, null)).toBeNull();
  });
});
