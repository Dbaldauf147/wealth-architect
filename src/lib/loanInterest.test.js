import { describe, it, expect } from 'vitest';
import { isInterestCharge, toISODate, paymentFromTransaction, loanInterestQueue, txnKey, mergeLoan, impliedBalances, balanceTimeline, interestPaidSeries, withBalanceEntry, loanLedger, balanceSeries, loanLinkType, linkedLoanTransactions, withLinkedTransactions } from './loanInterest.js';

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

describe('impliedBalances', () => {
  const loan = (payments, over = {}) => ({
    principal: 10000, rate: 0.1, rateType: 'daily', startDate: '2026-09-01', payments, ...over,
  });

  it('turns each payment back into the balance it was charged on', () => {
    // $10 a day on $10,000 at 0.1%/day; 30 days → $300.
    const { periods, remaining, paidDown } = impliedBalances(loan([
      { id: '1', date: '2026-10-01', amount: 300 },
      { id: '2', date: '2026-10-31', amount: 240 }, // 30 days on $8,000
    ]));
    expect(periods.map(p => [p.from, p.days])).toEqual([['2026-09-01', 30], ['2026-10-01', 30]]);
    expect(periods[0].balance).toBeCloseTo(10000);
    expect(remaining).toBeCloseTo(8000);
    expect(paidDown).toBeCloseTo(2000);
  });

  it('reads an APR as APR ÷ 365', () => {
    const { remaining } = impliedBalances(loan(
      [{ id: '1', date: '2026-09-11', amount: 10 }], // 10 days × $1/day at 0.01%/day
      { rate: 3.65, rateType: 'apr' },
    ));
    expect(remaining).toBeCloseTo(10000);
  });

  it('sums same-day payments and orders by date, not by log order', () => {
    const { periods, remaining } = impliedBalances(loan([
      { id: '3', date: '2026-10-11', amount: 50 },
      { id: '1', date: '2026-09-11', amount: 60 },
      { id: '2', date: '2026-09-11', amount: 40 }, // with #1: $100 over 10 days → $10,000
    ]));
    expect(periods.map(p => p.date)).toEqual(['2026-09-11', '2026-10-11']);
    expect(periods[0].balance).toBeCloseTo(10000);
    expect(remaining).toBeCloseTo(5000 / 3); // $50 over 30 days
  });

  it('implies nothing without days or a rate', () => {
    expect(impliedBalances(loan([{ id: '1', date: '2026-09-01', amount: 10 }])).remaining).toBeNull();
    expect(impliedBalances(loan([{ id: '1', date: '2026-09-11', amount: 10 }], { rate: 0 })).remaining).toBeNull();
    expect(impliedBalances(loan([])).remaining).toBeNull();
    expect(impliedBalances(null).periods).toEqual([]);
  });

  it('measures a payment from the one before it, even one dated before the start', () => {
    const { periods, remaining } = impliedBalances(loan([
      { id: '1', date: '2026-09-11', amount: 100 },
      { id: '2', date: '2026-08-01', amount: 5 }, // before the start: no days of its own
    ]));
    expect(periods[0]).toMatchObject({ date: '2026-08-01', balance: null });
    expect(periods[1]).toMatchObject({ from: '2026-08-01', days: 41 });
    expect(remaining).toBeCloseTo(100 / (0.001 * 41));
  });
});

describe('balanceTimeline', () => {
  const base = {
    principal: 10000, rate: 0.1, rateType: 'daily', startDate: '2026-09-01',
    payments: [{ id: '1', date: '2026-10-01', amount: 240 }], // 30 days → $8,000
  };

  it('starts at the principal and follows the payments', () => {
    const { points, current, paidDown } = balanceTimeline(base);
    expect(points.map(p => [p.date, p.source])).toEqual([['2026-09-01', 'start'], ['2026-10-01', 'payment']]);
    expect(current.balance).toBeCloseTo(8000);
    expect(paidDown).toBeCloseTo(2000);
  });

  it('takes an entered balance as current when it is the newest', () => {
    const { current, paidDown } = balanceTimeline({ ...base, balanceHistory: [{ date: '2026-10-15', amount: 6500 }] });
    expect(current).toMatchObject({ date: '2026-10-15', balance: 6500, source: 'entered' });
    expect(paidDown).toBe(3500);
  });

  it('lets an entered balance beat an implied one on the same date, and not an older one', () => {
    expect(balanceTimeline({ ...base, balanceHistory: [{ date: '2026-10-01', amount: 7900 }] }).current)
      .toMatchObject({ balance: 7900, source: 'entered' });
    expect(balanceTimeline({ ...base, balanceHistory: [{ date: '2026-09-15', amount: 9000 }] }).current.source)
      .toBe('payment');
  });

  it('copes with no loan or no principal', () => {
    expect(balanceTimeline(null)).toEqual({ points: [], current: null, borrowed: 0, paidDown: null });
    const { current, paidDown } = balanceTimeline({ balanceHistory: [{ date: '2026-10-01', amount: 500 }] });
    expect(current.balance).toBe(500);
    expect(paidDown).toBeNull();
  });
});

describe('interestPaidSeries', () => {
  it('sums by date and keeps a running total', () => {
    expect(interestPaidSeries({ payments: [
      { date: '2026-10-01', amount: 20 }, { date: '2026-09-01', amount: 30 }, { date: '2026-10-01', amount: 5 },
    ] })).toEqual([
      { date: '2026-09-01', amount: 30, total: 30 },
      { date: '2026-10-01', amount: 25, total: 55 },
    ]);
  });
});

describe('withBalanceEntry', () => {
  it('replaces the entry for a date, removes on null, and sorts', () => {
    const h = [{ date: '2026-10-01', amount: 9000 }];
    expect(withBalanceEntry(h, '2026-09-01', '9500')).toEqual([{ date: '2026-09-01', amount: 9500 }, h[0]]);
    expect(withBalanceEntry(h, '2026-10-01', 8800)).toEqual([{ date: '2026-10-01', amount: 8800 }]);
    expect(withBalanceEntry(h, '2026-10-01', null)).toEqual([]);
    expect(withBalanceEntry(undefined, '2026-10-01', 1)).toEqual([{ date: '2026-10-01', amount: 1 }]);
  });
});

describe('mergeLoan balanceHistory', () => {
  it('keeps balances entered on either side when unioning', () => {
    const local = { payments: [], balanceHistory: [{ date: '2026-10-01', amount: 1 }] };
    const remote = { payments: [], balanceHistory: [{ date: '2026-11-01', amount: 2 }] };
    expect(mergeLoan(local, remote).balanceHistory.map(e => e.date)).toEqual(['2026-10-01', '2026-11-01']);
  });
});

describe('loanLedger', () => {
  const loan = ledger => ({ name: 'Bridge', principal: 10000, startDate: '2026-09-01', ledger });

  it('starts with the original loan and keeps a running balance', () => {
    const { rows, borrowed, repaid, owed } = loanLedger(loan([
      { id: 'b', date: '2026-10-01', type: 'payment', amount: 2000 },
      { id: 'a', date: '2026-09-15', type: 'loan', amount: 5000, label: 'Second draw' },
    ]));
    expect(rows.map(r => [r.id, r.balance])).toEqual([['original', 10000], ['a', 15000], ['b', 13000]]);
    expect(rows[0]).toMatchObject({ label: 'Bridge', original: true });
    expect([borrowed, repaid, owed]).toEqual([15000, 2000, 13000]);
  });

  it('puts a new loan before a payment on the same day, and drops junk', () => {
    const { rows } = loanLedger(loan([
      { id: 'p', date: '2026-10-01', type: 'payment', amount: '300' },
      { id: 'l', date: '2026-10-01', type: 'loan', amount: 100 },
      { id: 'x', date: '2026-10-01', type: 'loan', amount: 0 },
      { id: 'y', date: '2026-10-01', type: 'fee', amount: 5 },
    ]));
    expect(rows.map(r => r.id)).toEqual(['original', 'l', 'p']);
    expect(rows[2].amount).toBe(300);
  });

  it('works with no original principal', () => {
    expect(loanLedger({ ledger: [{ id: 'a', date: '2026-10-01', type: 'loan', amount: 50 }] }))
      .toMatchObject({ borrowed: 50, repaid: 0, owed: 50 });
    expect(loanLedger(null)).toEqual({ rows: [], borrowed: 0, repaid: 0, owed: 0 });
  });

  it('feeds the balance timeline, and paid down counts every loan', () => {
    const { current, borrowed, paidDown } = balanceTimeline(loan([
      { id: 'a', date: '2026-09-15', type: 'loan', amount: 5000 },
      { id: 'b', date: '2026-10-01', type: 'payment', amount: 2000 },
    ]));
    expect(current).toMatchObject({ date: '2026-10-01', balance: 13000, source: 'ledger' });
    expect([borrowed, paidDown]).toEqual([15000, 2000]);
  });

  it('is unioned by id when merging', () => {
    const merged = mergeLoan(
      { payments: [], ledger: [{ id: 'a', date: '2026-10-01', type: 'loan', amount: 1 }] },
      { payments: [], ledger: [{ id: 'b', date: '2026-10-02', type: 'payment', amount: 1 }] },
    );
    expect(merged.ledger.map(e => e.id).sort()).toEqual(['a', 'b']);
  });
});

describe('loans linked by subcategory', () => {
  const loan = { principal: 10000, rate: 0.1, rateType: 'daily', startDate: '2026-09-01' };
  const txns = [
    { transactionId: 'a', date: '9/1/2026', description: 'Bridge loan', amount: 10000, category: 'Transfer', subcategory: 'Loan Taken' },
    { transactionId: 'b', date: '9/20/2026', description: 'Second draw', amount: 2500, category: 'Transfer', subcategory: 'loan taken' },
    { transactionId: 'c', date: '10/5/2026', description: 'Paydown', amount: -4000, category: 'Transfer', subcategory: 'Loan Payment', account: 'Checking' },
    { transactionId: 'd', date: '8/1/2026', description: 'Old loan', amount: -500, category: 'Transfer', subcategory: 'Loan Payment' },
    { transactionId: 'e', date: '10/6/2026', description: 'Card', amount: -900, category: 'Transfer', subcategory: 'Credit Card Payment' },
  ];

  it('reads the type from the subcategory, whatever the case', () => {
    expect(loanLinkType({ subcategory: 'Loan Taken' })).toBe('loan');
    expect(loanLinkType({ subcategory: ' loan  payment ' })).toBe('payment');
    expect(loanLinkType({ subcategory: 'Student Loans' })).toBeNull();
    expect(loanLinkType({})).toBeNull();
  });

  it('links draws and payments since the start, treating the start-day draw as the original loan', () => {
    const { entries, original, earlierCount } = linkedLoanTransactions({ transactions: txns, loan });
    expect(entries.map(e => [e.transactionId, e.type, e.amount, e.date])).toEqual([
      ['b', 'loan', 2500, '2026-09-20'],
      ['c', 'payment', 4000, '2026-10-05'],
    ]);
    expect(original.transactionId).toBe('a');
    expect(earlierCount).toBe(1);
  });

  it('feeds the ledger and the balance', () => {
    const view = withLinkedTransactions(loan, txns);
    expect(loanLedger(view)).toMatchObject({ borrowed: 12500, repaid: 4000, owed: 8500 });
    expect(balanceTimeline(view).current).toMatchObject({ date: '2026-10-05', balance: 8500, source: 'ledger' });
    // Folding in twice doesn't double up.
    expect(loanLedger(withLinkedTransactions(view, txns)).owed).toBe(8500);
  });

  it('leaves out what was unlinked, and what a hand-typed entry already covers', () => {
    const view = withLinkedTransactions({ ...loan, ignoredTransactionIds: ['c'], ledger: [{ id: 'm', type: 'loan', date: '2026-09-20', amount: 2500, transactionId: 'b' }] }, txns);
    expect(loanLedger(view)).toMatchObject({ borrowed: 12500, repaid: 0 });
    const { unlinked } = linkedLoanTransactions({ transactions: txns, loan: view });
    expect(unlinked.map(u => u.transactionId)).toEqual(['c']);
  });

  it('leaves a loan with nothing to link as it was', () => {
    expect(withLinkedTransactions(loan, [txns[4]])).toBe(loan);
    expect(withLinkedTransactions(null, txns)).toBeNull();
  });
});

describe('balanceSeries', () => {
  const loan = {
    principal: 10000, rate: 0.1, rateType: 'daily', startDate: '2026-09-01',
    payments: [{ id: '1', date: '2026-10-01', amount: 240 }], // 30 days → $8,000
    ledger: [
      { id: 'l', type: 'loan', date: '2026-09-20', amount: 2500 },
      { id: 'p1', type: 'payment', date: '2026-10-05', amount: 3000 },
      { id: 'p2', type: 'payment', date: '2026-10-05', amount: 1000 },
    ],
    balanceHistory: [{ date: '2026-10-10', amount: 8400 }],
  };

  it('keeps the interest estimate, the transactions and entered balances apart', () => {
    const { implied, ledger, entered } = balanceSeries(loan);
    expect(implied.map(p => [p.date, Math.round(p.balance)])).toEqual([['2026-09-01', 10000], ['2026-10-01', 8000]]);
    expect(ledger).toEqual([
      { date: '2026-09-01', balance: 10000 },
      { date: '2026-09-20', balance: 12500 },
      { date: '2026-10-05', balance: 8500 }, // same-day payments collapse to one point
    ]);
    expect(entered).toEqual([{ date: '2026-10-10', balance: 8400 }]);
  });

  it('copes with no loan', () => {
    expect(balanceSeries(null)).toEqual({ implied: [], ledger: [], entered: [] });
  });
});
