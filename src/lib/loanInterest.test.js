import { describe, it, expect } from 'vitest';
import { isInterestCharge, toISODate, paymentFromTransaction, loanInterestQueue, txnKey, mergeLoan } from './loanInterest.js';

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

describe('mergeLoan', () => {
  const pay = (id, transactionId) => ({ id, date: '2026-09-20', amount: 10, note: '', ...(transactionId ? { transactionId } : {}) });
  const loan = (over = {}) => ({ name: 'Ring', principal: 1000, rate: 0.1, rateType: 'daily', startDate: '2026-06-15', payments: [], ...over });

  it('keeps a charge tagged on another device when this one holds an older copy', () => {
    const remote = loan({ payments: [pay('a', 't1'), pay('b', 't2')] });
    const local = loan({ payments: [pay('a', 't1')] }); // stale
    expect(mergeLoan(local, remote).payments.map(p => p.transactionId)).toEqual(['t1', 't2']);
  });

  it('keeps a tag made here that the cloud has not seen yet', () => {
    const remote = loan({ payments: [pay('a', 't1')] });
    const local = loan({ payments: [pay('a', 't1'), pay('c', 't3')] });
    expect(mergeLoan(local, remote).payments).toHaveLength(2);
  });

  it('treats the same tagged charge under two ids as one payment', () => {
    const merged = mergeLoan(loan({ payments: [pay('x', 't1')] }), loan({ payments: [pay('y', 't1')] }));
    expect(merged.payments).toHaveLength(1);
  });

  it('unions ignored charges, but never ignores one that is tagged', () => {
    const merged = mergeLoan(
      loan({ ignoredTransactionIds: ['t9', 't2'] }),
      loan({ payments: [pay('b', 't2')], ignoredTransactionIds: ['t8'] }),
    );
    expect(merged.ignoredTransactionIds.sort()).toEqual(['t8', 't9']);
  });

  it('lets a newer cloud copy win outright, so deletions stick', () => {
    const local = loan({ updatedAt: '2026-10-01T00:00:00Z', payments: [pay('a', 't1'), pay('b', 't2')] });
    const remote = loan({ updatedAt: '2026-10-05T00:00:00Z', payments: [pay('a', 't1')] });
    expect(mergeLoan(local, remote)).toBe(remote);
  });

  it('takes the newer copy\'s terms and still keeps the other side\'s tags', () => {
    const local = loan({ updatedAt: '2026-10-06T00:00:00Z', principal: 2000, payments: [pay('a', 't1')] });
    const remote = loan({ updatedAt: '2026-10-05T00:00:00Z', principal: 1000, payments: [pay('b', 't2')] });
    const merged = mergeLoan(local, remote);
    expect(merged.principal).toBe(2000);
    expect(merged.payments.map(p => p.transactionId)).toEqual(['t1', 't2']);
  });

  it('falls back to whichever side exists', () => {
    const l = loan();
    expect(mergeLoan(null, l)).toBe(l);
    expect(mergeLoan(l, null)).toBe(l);
    expect(mergeLoan(null, null)).toBeNull();
  });
});
