import { describe, it, expect } from 'vitest';
import { countUncatOver20Recent } from './uncategorized.js';

describe('countUncatOver20Recent', () => {
  const now = new Date('2026-10-20T12:00:00');
  it('counts uncategorized charges and credits over $20 in the last 30 days', () => {
    expect(countUncatOver20Recent([
      { date: '10/18/2026', amount: -45, category: '' },
      { date: '10/18/2026', amount: 25, category: 'Uncategorized' },
      { date: '10/18/2026', amount: -20, category: '' },
      { date: '10/18/2026', amount: -90, category: 'Groceries' },
      { date: '08/01/2026', amount: -90, category: '' },
    ], now)).toBe(2);
  });
});
