import { describe, it, expect } from 'vitest';
import { isInterestCharge, toISODate, paymentFromTransaction, loanInterestQueue, txnKey } from './loanInterest.js';

const txn = (over = {}) => ({
  transactionId: 'a', date: '9/20/2026', description: 'Ring Loan Interest', amount: -42.5,
  account: 'Checking', category: 'Interest', subcategory: '', ...over,
});

describe('isInterestCharge', () => {
  it('takes money out categorized as interest, in either field', () => {
    expect(isInterestCharge(txn())).toBe(true);
    expect(isInterestCharge(txn({ category: 'Fees & Charges', subcategory: 'Interest Charges' }))).toBe(true);
  });
  it('leaves out interest earned and everything else', () => {
    expect(isInterestCharge(txn({ amount: 3.1, category: 'Income', subcategory: 'Interest' }))).toBe(false);
    expect(isInterestCharge(txn({ category: 'Dining' }))).toBe(false);
  });
});

describe('toISODate', () => {
  it('handles sheet and ISO dates without shifting a day', () => {
    expect(toISODate('9/5/2026')).toBe('2026-09-05');
    expect(toISODate('2026-09-05')).toBe('2026-09-05');
    expect(toISODate('nope')).toBe('');
  });
});

describe('paymentFromTransaction', () => {
  it('logs the charge as a positive payment that remembers its transaction', () => {
    expect(paymentFromTransaction(txn())).toEqual({
      date: '2026-09-20', amount: 42.5, note: 'Ring Loan Interest', transactionId: 'a',
    });
  });
});

describe('loanInterestQueue', () => {
  const loan = { startDate: '2026-06-15', payments: [{ id: 'p1', transactionId: 'tagged' }], ignoredTransactionIds: ['ign'] };
  const txns = [
    txn({ transactionId: 'new1', date: '8/1/2026' }),
    txn({ transactionId: 'new2', date: '9/1/2026' }),
    txn({ transactionId: 'tagged' }),
    txn({ transactionId: 'ign' }),
    txn({ transactionId: 'old', date: '5/1/2026' }),
    txn({ transactionId: 'food', category: 'Dining' }),
  ];

  it('offers only untagged, unignored charges since the loan started, newest first', () => {
    const q = loanInterestQueue({ transactions: txns, loan });
    expect(q.pending.map(t => t.key)).toEqual(['new2', 'new1']);
    expect(q.ignored.map(t => t.key)).toEqual(['ign']);
    expect(q.earlierCount).toBe(1);
  });

  it('can include charges from before the loan started', () => {
    const q = loanInterestQueue({ transactions: txns, loan, includeEarlier: true });
    expect(q.pending.map(t => t.key)).toEqual(['new2', 'new1', 'old']);
    expect(q.earlierCount).toBe(0);
  });

  it('keys rows without a transaction ID the way the rest of the app does', () => {
    const t = txn({ transactionId: '' });
    expect(txnKey(t)).toBe('9/20/2026|Ring Loan Interest|-42.5');
    expect(loanInterestQueue({ transactions: [t], loan: { payments: [] } }).pending[0].key).toBe(txnKey(t));
  });
});
