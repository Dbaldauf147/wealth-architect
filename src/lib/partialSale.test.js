import { describe, it, expect } from 'vitest';
import { pickLots, scenarioBridge } from './partialSale.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1);
const lots = [
  { id: 'old-gain', buyT: NOW - 900 * DAY, value: 1000, costBasis: 400, quantity: 10 },
  { id: 'new-gain', buyT: NOW - 100 * DAY, value: 1000, costBasis: 900, quantity: 10 },
  { id: 'old-small', buyT: NOW - 500 * DAY, value: 1000, costBasis: 950, quantity: 10 },
  { id: 'loss', buyT: NOW - 200 * DAY, value: 1000, costBasis: 1200, quantity: 10 },
];

describe('pickLots', () => {
  it('sells oldest first and splits the last lot', () => {
    const r = pickLots(lots, 1500, 'fifo', NOW);
    expect(r.sold.map(s => [s.id, s.fraction])).toEqual([['old-gain', 1], ['old-small', 0.5]]);
    expect(r.sold[1].costBasis).toBe(475);
    expect(r.sold[1].quantity).toBe(5);
    expect(r.proceeds).toBe(1500);
    expect(r.fraction).toBe(0.375);
    expect(r.kept.reduce((t, k) => t + k.value, 0)).toBe(2500);
  });

  it('sells losses, then small long-term gains, then short-term', () => {
    const r = pickLots(lots, 4000, 'taxSmart', NOW);
    expect(r.sold.map(s => s.id)).toEqual(['loss', 'old-small', 'old-gain', 'new-gain']);
  });

  it('takes the same slice of every lot', () => {
    const r = pickLots(lots, 1000, 'proRata', NOW);
    expect(r.sold).toHaveLength(4);
    expect(r.sold.every(s => s.fraction === 0.25 && s.value === 250)).toBe(true);
  });

  it('clamps to the position and handles nothing', () => {
    expect(pickLots(lots, 99999, 'fifo', NOW).proceeds).toBe(4000);
    expect(pickLots(lots, 0, 'fifo', NOW).sold).toEqual([]);
  });
});

describe('scenarioBridge', () => {
  it('splits the gap into the tax drag and the performance gap', () => {
    const b = scenarioBridge({ value: 10000, tax: 1000, keepReturn: 0.05, altReturn: 0.1, years: 10 });
    expect(b.reinvested).toBe(9000);
    expect(b.taxDrag + b.performance).toBeCloseTo(b.difference, 6);
    expect(b.taxDrag).toBeCloseTo(-1000 * Math.pow(1.1, 10), 6);
  });

  it('a loss is a credit, not a drag', () => {
    const b = scenarioBridge({ value: 10000, tax: -500, keepReturn: 0.07, altReturn: 0.07, years: 5 });
    expect(b.taxDrag).toBeGreaterThan(0);
    expect(b.performance).toBeCloseTo(0, 6);
    expect(b.difference).toBeCloseTo(500 * Math.pow(1.07, 5), 6);
  });
});
