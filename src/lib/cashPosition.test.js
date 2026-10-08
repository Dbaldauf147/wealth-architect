import { describe, it, expect } from 'vitest';
import { buildCashPosition, classifyAccount, accountKey } from './cashPosition.js';

const row = (date, account, accountNum, cls, balance) => ({ date, account, accountNum, class: cls, balance });

// Checking and savings, two cards (one closed in February), and a brokerage
// account that isn't cash.
function history() {
  return [
    row('1/31/2026', 'Dan checking', 'xxxx1118', 'Asset', 3000),
    row('2/28/2026', 'Dan checking', 'xxxx1118', 'Asset', 1500),
    row('3/31/2026', 'Dan checking', 'xxxx1118', 'Asset', 800),
    row('3/31/2026', 'Money Market Savings', 'xxxx4194', 'Asset', 500),
    row('1/31/2026', 'CREDIT CARD (-1947)', '1947', 'Liability', 2000),
    row('2/28/2026', 'CREDIT CARD (-1947)', '1947', 'Liability', 2500),
    row('3/31/2026', 'CREDIT CARD (-1947)', '1947', 'Liability', 4000),
    row('1/31/2026', 'CREDIT CARD', '7676', 'Liability', 900),
    row('2/06/2026', 'CREDIT CARD', '7676', 'Liability', 1000),   // then stops: closed
    row('3/31/2026', 'Robinhood individual', '9179', 'Asset', 500000),
  ];
}

describe('classifyAccount', () => {
  it('splits cash, debt and everything else', () => {
    expect(classifyAccount('Dan checking', 'Asset')).toBe('cash');
    expect(classifyAccount('Money Market Savings', 'Asset')).toBe('cash');
    expect(classifyAccount('CMA-Preferred Deposit', 'Asset')).toBe('cash');
    expect(classifyAccount('CREDIT CARD (-1947)', 'Liability')).toBe('debt');
    expect(classifyAccount('Robinhood individual', 'Asset')).toBe('other');
    expect(classifyAccount('Schneider Electric 401(k) Plan', 'Asset')).toBe('other');
    expect(classifyAccount('Roth Contributory IRA ...169', 'Asset')).toBe('other');
    // A retirement plan with "savings" in its name is not cash.
    expect(classifyAccount('NRG AFFILIATES EMPLOYEES SAVINGS PLAN', 'Asset')).toBe('other');
    expect(classifyAccount('Venmo Bank Account', 'Asset')).toBe('cash');
  });
  it('falls back to the name when the class is missing (an older cached sheet)', () => {
    expect(classifyAccount('Cash Rewards', '')).toBe('debt');
    expect(classifyAccount('Dan checking', '')).toBe('cash');
    expect(classifyAccount('Individual ...521', '')).toBe('other');
  });
  it('keeps one identity across a rename', () => {
    expect(accountKey(row('', 'Robinhood Brokerage', '9179', 'Asset', 0)))
      .toBe(accountKey(row('', 'Robinhood individual', '9179', 'Asset', 0)));
  });
});

describe('buildCashPosition', () => {
  const r = buildCashPosition({ balanceHistory: history(), monthKeys: ['2025-12', '2026-01', '2026-02', '2026-03'], today: new Date(2026, 3, 2) });
  const m = Object.fromEntries(r.months.map(x => [x.key, x]));

  it('is cash minus cards at the end of each month', () => {
    expect(m['2026-01']).toMatchObject({ cash: 3000, debt: 2900, net: 100 });
    expect(m['2026-02']).toMatchObject({ cash: 1500, debt: 3500, net: -2000 });
  });

  it('stops counting a card once its snapshots stop', () => {
    // 7676's last snapshot is Feb 6; by Mar 31 that's > 35 days old.
    expect(m['2026-03']).toMatchObject({ cash: 1300, debt: 4000, net: -2700 });
    const closed = r.accounts.find(a => a.last4 === '7676');
    expect(closed).toMatchObject({ stale: true, latest: 0, lastBalance: 1000 });
  });

  it('leaves investments out unless switched on', () => {
    expect(r.accounts.find(a => a.last4 === '9179')).toMatchObject({ kind: 'other', included: false });
    const key = r.accounts.find(a => a.last4 === '9179').key;
    const withIt = buildCashPosition({ balanceHistory: history(), monthKeys: ['2026-03'], today: new Date(2026, 3, 2), overrides: { [key]: true } });
    expect(withIt.now.cash).toBe(1300 + 500000);
  });

  it('honours switching a cash account or card off', () => {
    const k = r.accounts.find(a => a.last4 === '1947').key;
    const off = buildCashPosition({ balanceHistory: history(), monthKeys: ['2026-03'], today: new Date(2026, 3, 2), overrides: { [k]: false } });
    expect(off.now).toMatchObject({ cash: 1300, debt: 0, net: 1300 });
  });

  it('reports now, and nothing for months before any history', () => {
    expect(r.now).toMatchObject({ cash: 1300, debt: 4000, net: -2700 });
    expect(r.now.asOf).toEqual(new Date(2026, 2, 31));
    expect(m['2025-12'].net).toBeNull();
  });

  it('lists cash first, then debt, then the rest', () => {
    expect(r.accounts.map(a => a.kind)).toEqual(['cash', 'cash', 'debt', 'debt', 'other']);
  });
});
