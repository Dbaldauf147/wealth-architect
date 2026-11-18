import { describe, it, expect } from 'vitest';
import { predictability, predictabilityLabel } from './normalRange';

describe('predictability', () => {
  it('is 100% when every period costs the same', () => {
    expect(predictability([1500, 1500, 1500, 1500, 1500, 1500])).toBe(100);
  });

  it('is high for small wobble and low for wild swings', () => {
    const steady = predictability([410, 390, 400, 420, 380, 400]);
    const wild = predictability([50, 900, 0, 300, 1200, 20]);
    expect(steady).toBeGreaterThan(90);
    expect(wild).toBeLessThan(30);
  });

  it('counts empty periods inside the history but not before it starts', () => {
    // Started three windows ago at a flat 200: fully predictable.
    expect(predictability([200, 200, 200, 0, 0, 0])).toBe(100);
    // Every other period: a gap in the middle is real unpredictability.
    expect(predictability([200, 0, 200, 0, 200, 0])).toBeLessThan(30);
  });

  it('declines to score with under three periods of history', () => {
    expect(predictability([300, 300, 0, 0, 0, 0])).toBeNull();
    expect(predictability([0, 0, 0, 0, 0, 0])).toBeNull();
    expect(predictability([])).toBeNull();
  });

  it('never goes below zero', () => {
    expect(predictability([5000, 0, 0, 0, 0, 1])).toBe(0);
  });

  it('labels scores in plain words', () => {
    expect(predictabilityLabel(95)).toBe('Very predictable');
    expect(predictabilityLabel(60)).toBe('Somewhat predictable');
    expect(predictabilityLabel(20)).toBe('Unpredictable');
    expect(predictabilityLabel(null)).toBe('Not enough history');
  });
});
