import { describe, it, expect } from 'vitest';
import { buildWedgeBands, axisTicks, restackBands, OTHER_LABEL } from './wedgeChart.js';

const months = ['2026-01', '2026-02', '2026-03'];
const row = (cat, series) => ({ cat, series });

describe('buildWedgeBands', () => {
  it('stacks bands bottom-up with the largest category on the baseline', () => {
    const { bands } = buildWedgeBands({
      months,
      rows: [row('Small', [10, 10, 10]), row('Big', [100, 100, 100])],
    });
    expect(bands.map(b => b.cat)).toEqual(['Big', 'Small']);
    expect(bands[0].lower).toEqual([0, 0, 0]);
    expect(bands[0].upper).toEqual([100, 100, 100]);
    // The second band rides on top of the first rather than starting at zero.
    expect(bands[1].lower).toEqual([100, 100, 100]);
    expect(bands[1].upper).toEqual([110, 110, 110]);
  });

  it('reports the stacked total and peak', () => {
    const { monthTotals, max } = buildWedgeBands({
      months,
      rows: [row('A', [10, 50, 20]), row('B', [5, 5, 5])],
    });
    expect(monthTotals).toEqual([15, 55, 25]);
    expect(max).toBe(55);
  });

  it('rolls everything past topN into one Other band at the top', () => {
    const rows = [
      row('A', [100, 100, 100]),
      row('B', [90, 90, 90]),
      row('C', [7, 7, 7]),
      row('D', [3, 3, 3]),
    ];
    const { bands } = buildWedgeBands({ months, rows, topN: 2 });
    expect(bands.map(b => b.cat)).toEqual(['A', 'B', OTHER_LABEL]);
    const other = bands[2];
    expect(other.values).toEqual([10, 10, 10]);
    expect(other.rolledUp).toBe(2);
    expect(other.lower).toEqual([190, 190, 190]);
  });

  it('leaves the stack alone when there is nothing to roll up', () => {
    const { bands } = buildWedgeBands({ months, rows: [row('A', [1, 1, 1])], topN: 8 });
    expect(bands.map(b => b.cat)).toEqual(['A']);
  });

  // A category that only spent in the baseline half still arrives with a
  // full-length series of zeroes; it must not open a zero-height band.
  it('drops categories that never spent in the window', () => {
    const { bands } = buildWedgeBands({
      months,
      rows: [row('Live', [5, 5, 5]), row('Dormant', [0, 0, 0])],
    });
    expect(bands.map(b => b.cat)).toEqual(['Live']);
  });

  it('treats refunds and missing months as zero rather than negative height', () => {
    const { bands, monthTotals } = buildWedgeBands({
      months,
      rows: [row('A', [10, -40, undefined])],
    });
    expect(bands[0].values).toEqual([10, 0, 0]);
    expect(monthTotals).toEqual([10, 0, 0]);
  });

  it('returns an empty stack for no months or no rows', () => {
    expect(buildWedgeBands({ months: [], rows: [row('A', [1])] }).bands).toEqual([]);
    expect(buildWedgeBands({ months, rows: [] }).bands).toEqual([]);
    expect(buildWedgeBands().bands).toEqual([]);
  });

  it('averages each band over the window, not over its non-zero months', () => {
    const { bands } = buildWedgeBands({ months, rows: [row('A', [30, 0, 0])] });
    expect(bands[0].avg).toBe(10);
  });
});

describe('axisTicks', () => {
  it('rounds the top up to a readable step', () => {
    const { top, ticks } = axisTicks(4137, 4);
    expect(top).toBe(5000);
    expect(ticks).toEqual([0, 1250, 2500, 3750, 5000]);
  });

  it('keeps small maxima usable', () => {
    const { top } = axisTicks(37, 4);
    expect(top).toBeGreaterThanOrEqual(37);
    expect(top).toBeLessThanOrEqual(50);
  });

  it('degrades to a single zero tick when there is no spend', () => {
    expect(axisTicks(0)).toEqual({ top: 0, ticks: [0] });
  });
});

describe('restackBands', () => {
  const { bands } = buildWedgeBands({
    months,
    rows: [row('Rent', [100, 100, 100]), row('Food', [20, 40, 30]), row('Fun', [5, 5, 50])],
  });

  it('drops hidden bands and closes the gap they leave', () => {
    const out = restackBands(bands, new Set(['Rent']));
    expect(out.bands.map(b => b.cat)).toEqual(['Food', 'Fun']);
    expect(out.bands[0].lower).toEqual([0, 0, 0]);
    expect(out.bands[1].lower).toEqual([20, 40, 30]);
    expect(out.monthTotals).toEqual([25, 45, 80]);
    expect(out.max).toBe(80);
  });

  it('keeps each band\'s colour and stack order', () => {
    const out = restackBands(bands, new Set(['Food']));
    expect(out.bands.map(b => [b.cat, b.color])).toEqual([[bands[0].cat, bands[0].color], [bands[2].cat, bands[2].color]]);
  });

  it('is the full stack when nothing is hidden, and empty when everything is', () => {
    expect(restackBands(bands, new Set()).bands.map(b => b.upper)).toEqual(bands.map(b => b.upper));
    const none = restackBands(bands, new Set(bands.map(b => b.cat)));
    expect(none.bands).toEqual([]);
    expect(none.max).toBe(0);
  });
});
