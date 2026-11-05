import { describe, it, expect } from 'vitest';
import { buildLots } from './robinhood.js';
import { mergeLotSets, mergeStoredTrades } from './householdLots.js';

const t = (date, side, quantity, amount) => ({ date, symbol: 'AAPL', side, quantity, amount, price: Math.abs(amount / quantity) });

describe('household lots', () => {
  it("doesn't let one person's sell close the other's buy", () => {
    const mine = [t('2020-01-02', 'buy', 10, 1000)];
    const hers = [t('2024-01-02', 'buy', 5, 900), t('2025-01-02', 'sell', 5, 1100)];
    const merged = mergeLotSets([buildLots(mine, [], {}), buildLots(hers, [], {})]);
    expect(merged.open).toHaveLength(1);
    expect(merged.open[0].costBasis).toBeCloseTo(1000);
    expect(merged.closed).toHaveLength(1);
    expect(merged.closed[0].costBasis).toBeCloseTo(900);
    // Pooled, her sell would have closed half of my 2020 lot instead.
    const pooled = buildLots([...mine, ...hers], [], {});
    expect(pooled.closed[0].costBasis).toBeCloseTo(500);
  });

  it('pools the ledgers and skips empty sets', () => {
    const a = { trades: [1], income: [{ amount: 2 }], transfers: [] };
    const b = { trades: [2], transfers: [{ amount: 5 }] };
    expect(mergeStoredTrades([a, null, { trades: [] }, b])).toMatchObject({
      trades: [1, 2], income: [{ amount: 2 }], transfers: [{ amount: 5 }], corporateActions: [],
    });
    expect(mergeStoredTrades([null])).toBe(null);
  });
});
