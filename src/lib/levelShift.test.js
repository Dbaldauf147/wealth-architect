import { describe, it, expect } from 'vitest';
import { findStepUp, absorbedStepUp } from './levelShift.js';

const rep = (v, n) => Array(n).fill(v);

describe('findStepUp', () => {
  it('finds a lasting rise and the month it started', () => {
    const step = findStepUp([...rep(1500, 8), ...rep(2000, 6)]);
    expect(step).toEqual({ index: 8, before: 1500, after: 2000 });
  });

  it('ignores flat or noisy spend', () => {
    expect(findStepUp(rep(300, 14))).toBeNull();
    expect(findStepUp([300, 340, 280, 310, 330, 290, 320, 300, 310, 290, 330, 300])).toBeNull();
  });

  it('ignores a single big month after an ordinary run', () => {
    expect(findStepUp([...rep(200, 9), 900, 200, 200])).toBeNull();
  });

  it('ignores a rise below the flag bar', () => {
    // +$30/mo: well over 25% but under $50.
    expect(findStepUp([...rep(60, 8), ...rep(90, 6)])).toBeNull();
    // +$100/mo on $1,000: over $50 but only 10%.
    expect(findStepUp([...rep(1000, 8), ...rep(1100, 6)])).toBeNull();
  });

  it('tolerates one soft month at the new level, such as a partial current month', () => {
    const step = findStepUp([...rep(100, 8), 400, 400, 400, 120]);
    expect(step?.index).toBe(8);
  });

  it('needs the new level to have held for three months', () => {
    expect(findStepUp([...rep(100, 10), 400, 400])).toBeNull();
  });

  it('finds a category that started from nothing', () => {
    const step = findStepUp([...rep(0, 6), ...rep(120, 6)]);
    expect(step).toMatchObject({ index: 6, before: 0, after: 120 });
  });
});

describe('absorbedStepUp', () => {
  it('reports a step that now sits inside the baseline window', () => {
    // 3 vs prior 3: baseline is months 8-10, recent 11-13. Step at 9.
    const r = absorbedStepUp([...rep(1500, 9), ...rep(2000, 5)], 3, 3);
    expect(r).toMatchObject({ index: 9, before: 1500, after: 2000, isNew: false, monthsInBaseline: 2 });
  });

  it('reports a step from before the baseline, counting the whole baseline', () => {
    const r = absorbedStepUp([...rep(1500, 6), ...rep(2000, 8)], 3, 3);
    expect(r).toMatchObject({ index: 6, monthsInBaseline: 3 });
  });

  it('stays quiet while the rise is still inside the recent window', () => {
    // Step at 11, the first recent month: the comparison already shows it.
    expect(absorbedStepUp([...rep(1500, 11), ...rep(2000, 3)], 3, 3)).toBeNull();
  });

  it('marks a category that did not exist before as new', () => {
    const r = absorbedStepUp([...rep(0, 7), ...rep(150, 7)], 3, 3);
    expect(r).toMatchObject({ isNew: true, index: 7 });
  });

  it('forgets a step older than a year', () => {
    expect(absorbedStepUp([...rep(1500, 6), ...rep(2000, 14)], 3, 3)).toBeNull();
    // Even a big jump: it must not resurface pinned to the oldest month in range.
    expect(absorbedStepUp([...rep(0, 6), ...rep(150, 14)], 3, 3)).toBeNull();
  });
});
