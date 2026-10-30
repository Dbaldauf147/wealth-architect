import { describe, it, expect } from 'vitest';
import { rankSpendShare, paretoFocus, isRentCategory, addMonths, monthSpan } from './spendShare.js';

const tx = (date, amount, category) => ({ date, amount, category, description: category });

const ledger = [
  // Before the period (Apr–Jun): the comparison.
  tx('04/03/2026', -2000, 'Rent'),
  tx('04/10/2026', -100, 'Groceries'),
  tx('05/10/2026', -300, 'Dining'),
  // The period (Jul–Sep).
  tx('07/01/2026', -2000, 'Rent'),
  tx('07/05/2026', -300, 'Groceries'),
  tx('08/05/2026', -100, 'Groceries'),
  tx('08/09/2026', -400, 'Dining'),
  tx('09/09/2026', -200, 'Travel'),
  tx('09/10/2026', 50, 'Groceries'),          // a refund, not counted
  tx('09/12/2026', -900, 'Transfer'),         // money moving, never counted
];

describe('rankSpendShare', () => {
  const r = rankSpendShare({ transactions: ledger, from: '2026-07', to: '2026-09', hidden: new Set(['Rent']) });

  it('ranks categories by share of what was spent, rent left out', () => {
    expect(r.rows.map(x => [x.rank, x.cat, x.amount])).toEqual([[1, 'Dining', 400], [2, 'Groceries', 400], [3, 'Travel', 200]]);
    expect(r.total).toBe(1000);
    expect(r.rows[0].share).toBeCloseTo(0.4);
    expect(r.rows[2].cumShare).toBeCloseTo(1);
    expect(r.rows[1].perMonth).toBeCloseTo(133.33);
  });

  it('reports what was hidden apart', () => {
    expect(r.hiddenTotal).toBe(2000);
    expect(r.hiddenCats).toEqual([{ cat: 'Rent', amount: 2000 }]);
    expect(r.all).toEqual(['Dining', 'Groceries', 'Rent', 'Travel']);
  });

  it('compares with the same number of months just before', () => {
    expect(r.prev).toEqual({ from: '2026-04', to: '2026-06', total: 400 });
    const dining = r.rows.find(x => x.cat === 'Dining');
    expect(dining.prevShare).toBeCloseTo(0.75);
    expect(r.rows.find(x => x.cat === 'Travel')).toMatchObject({ prevAmount: 0, prevShare: 0 });
  });

  it('marks the categories that make up 80% of spending', () => {
    expect(r.focus).toMatchObject({ count: 2, amount: 800, tailCount: 1, tailAmount: 200 });
    expect(r.focus.share).toBeCloseTo(0.8);
    expect(r.focus.tailShare).toBeCloseTo(0.2);
    expect(r.rows.map(x => x.focus)).toEqual([true, true, false]);
  });

  it('counts rent once it is shown', () => {
    const all = rankSpendShare({ transactions: ledger, from: '2026-07', to: '2026-09' });
    expect(all.rows[0]).toMatchObject({ cat: 'Rent', amount: 2000 });
    expect(all.total).toBe(3000);
    expect(all.hiddenTotal).toBe(0);
  });
});

describe('paretoFocus', () => {
  const rows = shares => {
    let cum = 0;
    return shares.map(share => { cum += share; return { share, cumShare: cum, amount: share * 100 }; });
  };

  it('takes the fewest top categories that reach 80%', () => {
    const f = paretoFocus(rows([0.5, 0.2, 0.15, 0.1, 0.05]));
    expect(f.count).toBe(3);
    expect(f.share).toBeCloseTo(0.85);
    expect(f.tailCount).toBe(2);
    expect(f.tailAmount).toBe(15);
  });

  it('stops at one category when it alone is 80%', () => {
    expect(paretoFocus(rows([0.9, 0.1])).count).toBe(1);
  });

  it('copes with nothing to rank', () => {
    expect(paretoFocus([])).toMatchObject({ count: 0, tailCount: 0 });
  });
});

describe('helpers', () => {
  it('knows rent when it sees it', () => {
    expect(isRentCategory('Rent')).toBe(true);
    expect(isRentCategory('Rent & Utilities')).toBe(true);
    expect(isRentCategory('Parent gifts')).toBe(false);
  });

  it('does month arithmetic across years', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-11', 14)).toBe('2027-01');
    expect(monthSpan('2025-11', '2026-02')).toBe(4);
    expect(monthSpan('2026-03', '2026-02')).toBe(0);
  });
});
