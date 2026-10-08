import { describe, it, expect } from 'vitest';
import { computeCashBridge, monthRange, pairInternalMoves } from './cashBridge.js';

const bal = (date, account, accountNum, cls, balance) => ({ date, account, accountNum, class: cls, balance });
const tx = (date, amount, category, account, accountNum, description = category) => ({ date, amount, category, account, accountNum, description });

// Worked by hand. Feb–Mar 2026.
//   checking …1118: 1,000 → +5,000 pay − 2,000 rent − 500 card payment = 3,500 (Feb)
//                   → − 1,000 to brokerage + 10 interest that never imported = 2,510 (Mar)
//   card …1947 owes: 500 → + 300 groceries − 500 payment = 300, flat in March
//   card …7676 owes 400, last update Feb 6 — drops out mid-March
//   brokerage …9179: not counted; receives the 1,000 and a 50 dividend
// Position: Jan 31 = 1,000 − 900 = 100 · Feb 28 = 3,500 − 700 = 2,800 · Mar 31 = 2,510 − 300 = 2,210
function balances() {
  return [
    bal('1/31/2026', 'Dan checking', 'xxxx1118', 'Asset', 1000),
    bal('2/28/2026', 'Dan checking', 'xxxx1118', 'Asset', 3500),
    bal('3/31/2026', 'Dan checking', 'xxxx1118', 'Asset', 2510),
    bal('1/31/2026', 'CREDIT CARD (-1947)', '1947', 'Liability', 500),
    bal('2/28/2026', 'CREDIT CARD (-1947)', '1947', 'Liability', 300),
    bal('3/31/2026', 'CREDIT CARD (-1947)', '1947', 'Liability', 300),
    bal('1/31/2026', 'CREDIT CARD', '7676', 'Liability', 400),
    bal('2/06/2026', 'CREDIT CARD', '7676', 'Liability', 400),
    bal('3/31/2026', 'Robinhood individual', '9179', 'Asset', 20000),
  ];
}
function ledger() {
  return [
    tx('2/15/2026', 5000, 'Paycheck', 'Dan checking', 'xxxx1118', 'ACME PAYROLL'),
    tx('2/01/2026', -2000, 'Housing', 'Dan checking', 'xxxx1118', 'Rent'),
    tx('2/10/2026', -300, 'Groceries', 'CREDIT CARD (-1947)', '1947', 'Trader Joes'),
    tx('2/20/2026', -500, 'Credit Card Payment', 'Dan checking', 'xxxx1118', 'Payment to card'),
    tx('2/20/2026', 500, 'Credit Card Payment', 'CREDIT CARD (-1947)', '1947', 'Payment thank you'),
    tx('3/05/2026', -1000, 'Investments', 'Dan checking', 'xxxx1118', 'To Robinhood'),
    tx('3/05/2026', 1000, 'Investments', 'Robinhood individual', '9179', 'From checking'),
    tx('3/10/2026', 50, 'Income', 'Robinhood individual', '9179', 'Cash dividend of $50 from Voo'),
  ];
}

describe('computeCashBridge', () => {
  const r = computeCashBridge({ transactions: ledger(), balanceHistory: balances(), from: '2026-02', to: '2026-03', today: new Date(2026, 3, 5) });
  const line = id => r.lines.find(l => l.id === id).amount;

  it('starts from the Cash Flow surplus and ends at the actual change', () => {
    expect(r.surplus).toBe(5050 - 2300);
    expect(r.start.net).toBe(100);
    expect(r.end.net).toBe(2210);
    expect(r.actualChange).toBe(2110);
  });

  it('names each reason the two differ', () => {
    expect(line('outsideIncome')).toBe(-50);     // the dividend stayed in the brokerage
    expect(line('investing')).toBe(-1000);       // sent to the brokerage
    expect(line('cardPayments')).toBe(0);        // checking → counted card cancels out
    expect(line('transfers')).toBe(0);
    expect(line('outsideSpending')).toBe(0);
    expect(line('other')).toBe(0);
    expect(line('timing')).toBe(0);
    expect(line('accounts')).toBe(400);          // card …7676 stopped updating
    expect(line('unexplained')).toBe(10);        // interest with no transaction
  });

  it('always adds up', () => {
    const total = r.surplus + r.lines.reduce((s, l) => s + l.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(r.actualChange);
  });

  it('lists what is behind each line', () => {
    expect(r.lines.find(l => l.id === 'investing').items[0]).toMatchObject({ description: 'To Robinhood', amount: -1000 });
    expect(r.lines.find(l => l.id === 'outsideIncome').items[0]).toMatchObject({ account: 'Robinhood individual', effect: -50 });
    expect(r.lines.find(l => l.id === 'accounts').items[0].description).toMatch(/Stopped updating/);
  });

  it('breaks the same walk down by month', () => {
    const [feb, mar] = r.months;
    expect(feb).toMatchObject({ key: '2026-02', surplus: 2700, actual: 2700, gap: 0 });
    expect(mar).toMatchObject({ key: '2026-03', surplus: 50, actual: -590 });
    expect(mar.lines).toMatchObject({ investing: -1000, outsideIncome: -50, accounts: 400, unexplained: 10, other: 0 });
    expect(mar.top).toBe('investing');
  });

  it('counts a payment to a card the position no longer tracks', () => {
    // Pay the stale card from checking: cash leaves, nothing counted receives it.
    const t = [...ledger(), tx('3/20/2026', -400, 'Credit Card Payment', 'Dan checking', 'xxxx1118', 'Payment to old card')];
    const b = balances().map(x => (x.accountNum === 'xxxx1118' && x.date === '3/31/2026' ? { ...x, balance: 2110 } : x));
    const out = computeCashBridge({ transactions: t, balanceHistory: b, from: '2026-02', to: '2026-03', today: new Date(2026, 3, 5) });
    expect(out.lines.find(l => l.id === 'cardPayments').amount).toBe(-400);
    expect(out.lines.find(l => l.id === 'unexplained').amount).toBe(10);
  });

  it('pairs a card payment whose two sides are categorised differently', () => {
    // Checking side filed as Transfer, card side as Credit Card Payments: still one move.
    const t = ledger().map(x => (x.description === 'Payment to card' ? { ...x, category: 'Transfer' } : x));
    const out = computeCashBridge({ transactions: t, balanceHistory: balances(), from: '2026-02', to: '2026-03', today: new Date(2026, 3, 5) });
    expect(out.lines.find(l => l.id === 'transfers').amount).toBe(0);
    expect(out.lines.find(l => l.id === 'cardPayments').amount).toBe(0);
    expect(out.internal).toMatchObject({ count: 2, volume: 500 });
  });

  it('counts a refund once and a tax payment as spending, so nothing is left to correct', () => {
    // A 100 refund in Groceries nets against Groceries (not income as well);
    // a 700 tax payment under Tax Refund/Payment is spending that month.
    const t = [...ledger(),
      tx('2/12/2026', 100, 'Groceries', 'Dan checking', 'xxxx1118', 'Refund'),
      tx('3/15/2026', -700, 'Tax Refund/Payment', 'Dan checking', 'xxxx1118', 'IRS payment')];
    const b = balances().map(x => (x.accountNum !== 'xxxx1118' ? x
      : x.date === '2/28/2026' ? { ...x, balance: 3500 + 100 }
        : x.date === '3/31/2026' ? { ...x, balance: 2510 + 100 - 700 } : x));
    const out = computeCashBridge({ transactions: t, balanceHistory: b, from: '2026-02', to: '2026-03', today: new Date(2026, 3, 5) });
    const l = id => out.lines.find(x => x.id === id).amount;
    expect(out.surplus).toBe(2750 + 100 - 700);
    expect(out.lines.map(x => x.id)).not.toContain('refundsTwice');
    expect(l('other')).toBe(0);
    expect(l('unexplained')).toBe(10);
    const total = out.surplus + out.lines.reduce((sum, x) => sum + x.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(out.actualChange);
  });

  it('counts a refund-only month as money in', () => {
    const t = [...ledger(), tx('3/12/2026', 100, 'Groceries', 'Dan checking', 'xxxx1118', 'Refund')];
    const b = balances().map(x => (x.accountNum === 'xxxx1118' && x.date === '3/31/2026' ? { ...x, balance: 2610 } : x));
    const out = computeCashBridge({ transactions: t, balanceHistory: b, from: '2026-02', to: '2026-03', today: new Date(2026, 3, 5) });
    expect(out.surplus).toBe(2850);
    expect(out.lines.find(x => x.id === 'other').amount).toBe(0);
  });

  it('counts a "Transfer" to a brokerage as investing', () => {
    // How the live ledger files Robinhood deposits: category Transfer, the
    // brokerage named only in the description.
    const t = ledger().map(x => (x.description === 'To Robinhood' ? { ...x, category: 'Transfer', description: 'Robinhood, Des:funds, ID:x1793' } : x));
    const out = computeCashBridge({ transactions: t, balanceHistory: balances(), from: '2026-02', to: '2026-03', today: new Date(2026, 3, 5) });
    expect(out.lines.find(x => x.id === 'investing').amount).toBe(-1000);
    expect(out.lines.find(x => x.id === 'transfers').amount).toBe(0);
  });

  it('flags an old card frozen while a new one had started (a replaced card)', () => {
    // …7676 sat at 400 from Jan 31 to its last update Feb 6; …1947 started Jan 31.
    expect(r.overlaps).toHaveLength(1);
    expect(r.overlaps[0]).toMatchObject({ old: 'CREDIT CARD …7676', replacedBy: ['CREDIT CARD (-1947)'], balance: 400 });
    expect(r.overlaps[0].lastUpdate).toEqual(new Date(2026, 1, 6));
  });

  it('does not flag an old card whose balance was still moving', () => {
    const b = balances().map(x => (x.accountNum === '7676' && x.date === '2/06/2026' ? { ...x, balance: 150 } : x));
    const out = computeCashBridge({ transactions: ledger(), balanceHistory: b, from: '2026-02', to: '2026-03', today: new Date(2026, 3, 5) });
    expect(out.overlaps).toHaveLength(0);
  });

  it('returns nothing without balance history', () => {
    expect(computeCashBridge({ transactions: ledger(), balanceHistory: [], from: '2026-02', to: '2026-03' })).toBeNull();
  });
});

describe('pairInternalMoves', () => {
  const r = (date, amount, account) => ({ date: new Date(date), amount, account });
  it('pairs opposite amounts across accounts within a week, nearest first', () => {
    const a = r('2026-02-20', -500, 'checking');
    const b = r('2026-02-21', 500, 'card');
    const c = r('2026-03-20', 500, 'card');   // too far from a
    const p = pairInternalMoves([a, b, c]);
    expect(p.has(a) && p.has(b)).toBe(true);
    expect(p.has(c)).toBe(false);
  });
  it('pairs a payment with its own reversal', () => {
    const a = r('2026-05-15', 3407.91, 'card');
    const b = r('2026-05-15', -3407.91, 'card');
    expect(pairInternalMoves([a, b]).size).toBe(2);
  });
});

describe('monthRange', () => {
  it('runs inclusive across a year end', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});
