import { describe, it, expect } from 'vitest';
import { cashFlowBreakdown, isInvestingMove, isMoneyMove } from './cashflowExport.js';

const tx = (date, amount, category, account = 'Dan checking', description = category) => ({ date, amount, category, account, description });

// One month, worked by hand:
//   paycheck 6,000 · rent 2,500 · restaurants 400 with a 50 refund · a 700 tax payment
//   → income 6,000, spending 2,500 + 350 + 700 = 3,550, surplus 2,450
//   sent to Robinhood 2,000 (filed as Transfer), 500 to an IRA (Retirement)
//   → invested 2,500, of which retirement 500 → kept as cash −50
//   The brokerage's side of each deposit, a card payment and a plain transfer
//   don't count for anything.
const ledger = [
  tx('3/01/2026', 6000, 'Paycheck', 'Dan checking', 'ACME PAYROLL'),
  tx('3/02/2026', -2500, 'Rent', 'Dan checking', 'Zelle to landlord'),
  tx('3/05/2026', -400, 'Restaurants', 'CREDIT CARD (-1947)', 'Dinner'),
  tx('3/09/2026', 50, 'Restaurants', 'Dan checking', 'Venmo from Sam'),
  tx('3/15/2026', -700, 'Tax Refund/Payment', 'Dan checking', 'IRS USATAXPYMT'),
  tx('3/10/2026', -2000, 'Transfer', 'Dan checking', 'Robinhood, Des:funds, ID:x1793'),
  tx('3/10/2026', 2000, 'Transfer', 'Robinhood individual', 'Deposit from checking'),
  tx('3/12/2026', -500, 'Retirement', 'Dan checking', 'Roth IRA contribution'),
  tx('3/12/2026', 500, 'Retirement', 'Roth Contributory IRA ...169', 'Contribution'),
  tx('3/20/2026', -900, 'Credit Card Payment', 'Dan checking', 'Chase autopay'),
  tx('3/21/2026', -300, 'Transfer', 'Dan checking', 'To savings'),
];

describe('cashFlowBreakdown', () => {
  const { totals, qualifying, role } = cashFlowBreakdown(ledger, ['2026-03']);
  const m = totals['2026-03'];

  it('counts a refund once and a tax payment as spending', () => {
    expect(m.income).toBe(6000);
    expect(m.expenses).toBe(3550);
    expect(m.net).toBe(2450);
  });

  it('counts what was invested from the cash side, Robinhood "Transfer" included', () => {
    expect(m.invested).toBe(2500);
    expect(m.retirement).toBe(500);
    expect(m.kept).toBe(-50);
  });

  it('says which side each transaction is on', () => {
    expect(role(ledger[3])).toBe('expense');   // the refund nets into Restaurants
    expect(role(ledger[5])).toBe('move');
    expect(role(ledger[0])).toBe('income');
    expect(role(tx('4/01/2026', 1, 'Paycheck'))).toBeNull();
  });

  it('only calls net-negative categories spending categories', () => {
    expect([...qualifying].sort()).toEqual(['Rent', 'Restaurants']);
  });

  it('treats a refund-only month as money in, not negative spending', () => {
    const t = [tx('3/01/2026', -100, 'Shopping'), tx('4/03/2026', 40, 'Shopping', 'Dan checking', 'Return')];
    const out = cashFlowBreakdown(t, ['2026-03', '2026-04']).totals;
    expect(out['2026-04']).toMatchObject({ income: 40, expenses: 0 });
  });

  it('counts money taken back out of investments as negative investing', () => {
    const t = [tx('3/05/2026', 1500, 'Transfer', 'Dan checking', 'Robinhood withdrawal')];
    expect(cashFlowBreakdown(t, ['2026-03']).totals['2026-03']).toMatchObject({ invested: -1500, kept: 1500, income: 0 });
  });
});

describe('isInvestingMove / isMoneyMove', () => {
  it('needs a cash account to read a brokerage name as investing', () => {
    expect(isInvestingMove(tx('3/1/2026', -10, 'Misc', 'Dan checking', 'Instant Payment; Robinhood Securities'))).toBe(true);
    // A fee charged inside the brokerage is spending there, not a move.
    expect(isInvestingMove(tx('3/1/2026', -5, 'Misc', 'Robinhood individual', 'Robinhood Gold monthly fee'))).toBe(false);
    expect(isMoneyMove(tx('3/1/2026', -5, 'Restaurants', 'CREDIT CARD (-1947)', 'Tst* Rothmanns Steak'))).toBe(false);
  });
});
