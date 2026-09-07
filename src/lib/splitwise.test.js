import { describe, it, expect } from 'vitest';
import {
  normalizeExpense,
  normalizeExpenses,
  summarizeBalances,
  summarizeExpenses,
  attachTransactionMatches,
} from './splitwise.js';

const ME = 101;

/** A Splitwise expense in the shape get_expenses actually returns. */
function expense({ id = 1, cost = '60.00', description = 'Dinner', date = '2026-09-04T00:00:00Z',
  myPaid = '60.00', myOwed = '30.00', theirPaid = '0.00', theirOwed = '30.00',
  payment = false, deleted = null, group = null, category = 'Dining out' } = {}) {
  return {
    id,
    cost,
    description,
    date,
    currency_code: 'USD',
    payment,
    deleted_at: deleted,
    group_id: group,
    category: { id: 5, name: category },
    created_by: { first_name: 'Dan', last_name: 'B' },
    users: [
      {
        user_id: ME,
        user: { id: ME, first_name: 'Dan', last_name: 'B' },
        paid_share: myPaid,
        owed_share: myOwed,
        net_balance: String(Number(myPaid) - Number(myOwed)),
      },
      {
        user_id: 202,
        user: { id: 202, first_name: 'Alice', last_name: 'K' },
        paid_share: theirPaid,
        owed_share: theirOwed,
        net_balance: String(Number(theirPaid) - Number(theirOwed)),
      },
    ],
  };
}

describe('normalizeExpense', () => {
  it('reads the expense from the current user\'s side', () => {
    const e = normalizeExpense(expense(), ME);
    expect(e).toMatchObject({
      description: 'Dinner', cost: 60, youPaid: 60, yourShare: 30, net: 30, currency: 'USD',
    });
    expect(e.others).toEqual([{ id: 202, name: 'Alice K', paid: 0, owed: 30, net: -30 }]);
  });

  it('gives a negative net when someone else fronted the bill', () => {
    const e = normalizeExpense(
      expense({ myPaid: '0.00', myOwed: '30.00', theirPaid: '60.00', theirOwed: '30.00' }),
      ME,
    );
    expect(e).toMatchObject({ youPaid: 0, yourShare: 30, net: -30 });
  });

  it('drops deleted expenses', () => {
    expect(normalizeExpense(expense({ deleted: '2026-09-05T00:00:00Z' }), ME)).toBeNull();
  });

  it('drops expenses the user is not a party to', () => {
    expect(normalizeExpense(expense(), 999)).toBeNull();
  });

  it('flags a settle-up rather than treating it as a purchase', () => {
    const e = normalizeExpense(expense({ payment: true, description: 'Payment' }), ME);
    expect(e.isSettlement).toBe(true);
  });

  it('sorts a list newest first', () => {
    const list = normalizeExpenses([
      expense({ id: 1, date: '2026-08-01T00:00:00Z' }),
      expense({ id: 2, date: '2026-09-04T00:00:00Z' }),
      expense({ id: 3, date: '2026-07-15T00:00:00Z' }),
    ], ME);
    expect(list.map(e => e.id)).toEqual([2, 1, 3]);
  });
});

describe('summarizeBalances', () => {
  const friends = [
    { id: 202, first_name: 'Alice', last_name: 'K', balance: [{ currency_code: 'USD', amount: '30.00' }] },
    { id: 303, first_name: 'Bob', last_name: 'L', balance: [{ currency_code: 'USD', amount: '-12.50' }] },
    { id: 404, first_name: 'Cleo', last_name: 'M', balance: [{ currency_code: 'USD', amount: '120.00' }] },
    { id: 505, first_name: 'Zero', last_name: 'N', balance: [] },
  ];

  it('splits the friend balances into owed-to-you and you-owe', () => {
    const s = summarizeBalances({ friends, defaultCurrency: 'USD' });
    expect(s.owedToYou).toBe(150);
    expect(s.youOwe).toBe(12.5);
    expect(s.net).toBe(137.5);
  });

  it('ranks people by the size of the position, either direction', () => {
    const s = summarizeBalances({ friends, defaultCurrency: 'USD' });
    expect(s.byPerson.map(p => p.name)).toEqual(['Cleo M', 'Alice K', 'Bob L']);
  });

  it('does not add group balances on top of the friend totals', () => {
    // Splitwise's per-friend balance already nets every group in, so counting
    // the group rows again would double the same debt.
    const groups = [{
      id: 7,
      name: 'Ski trip',
      members: [
        { id: 202, first_name: 'Alice', balance: [{ currency_code: 'USD', amount: '30.00' }] },
      ],
    }];
    const s = summarizeBalances({ friends, groups, defaultCurrency: 'USD' });
    expect(s.owedToYou).toBe(150);
    expect(s.groups[0]).toMatchObject({ name: 'Ski trip' });
  });

  it('keeps a foreign currency out of the headline but still reports it', () => {
    const s = summarizeBalances({
      friends: [
        ...friends,
        { id: 606, first_name: 'Euro', last_name: 'P', balance: [{ currency_code: 'EUR', amount: '40.00' }] },
      ],
      defaultCurrency: 'USD',
    });
    expect(s.owedToYou).toBe(150);
    expect(s.otherCurrencies).toEqual([{ currency: 'EUR', owedToYou: 40, youOwe: 0 }]);
  });

  it('survives an account with no friends', () => {
    expect(summarizeBalances({ friends: [], defaultCurrency: 'USD' }))
      .toMatchObject({ owedToYou: 0, youOwe: 0, net: 0, byPerson: [] });
  });
});

describe('summarizeExpenses', () => {
  it('totals what you fronted against what was actually yours', () => {
    const list = normalizeExpenses([
      expense({ id: 1 }),                                      // paid 60, share 30
      expense({ id: 2, myPaid: '0.00', theirPaid: '60.00' }),  // paid 0, share 30
      expense({ id: 3, payment: true }),                       // settle-up
    ], ME);
    expect(summarizeExpenses(list)).toMatchObject({
      youPaid: 60, yourShare: 60, net: 0, charges: 2, settlements: 1, count: 3,
    });
  });
});

describe('attachTransactionMatches', () => {
  const txns = [
    { transactionId: 't1', date: '2026-09-04', description: 'BLUE HILL RESTAURANT', account: 'Sapphire', amount: -60 },
    { transactionId: 't2', date: '2026-09-04', description: 'PAYCHECK', account: 'Chase', amount: 2500 },
    { transactionId: 't3', date: '2026-08-20', description: 'SOME SHOP', account: 'Sapphire', amount: -41.37 },
  ];

  it('matches the charge you fronted, on amount and date', () => {
    const [e] = attachTransactionMatches(normalizeExpenses([expense()], ME), txns);
    expect(e.match).toMatchObject({ transactionId: 't1', daysApart: 0, exact: true });
  });

  it('matches your half when you only paid half at the register', () => {
    const list = normalizeExpenses([
      expense({ cost: '82.74', myPaid: '41.37', myOwed: '41.37', theirPaid: '41.37', theirOwed: '41.37', date: '2026-08-21T00:00:00Z' }),
    ], ME);
    expect(attachTransactionMatches(list, txns)[0].match).toMatchObject({ transactionId: 't3' });
  });

  it('leaves an expense someone else paid unmatched', () => {
    const list = normalizeExpenses([expense({ myPaid: '0.00', theirPaid: '60.00' })], ME);
    expect(attachTransactionMatches(list, txns)[0].match).toBeNull();
  });

  it('never matches money coming in', () => {
    const list = normalizeExpenses([expense({ cost: '2500.00', myPaid: '2500.00', myOwed: '1250.00', theirOwed: '1250.00' })], ME);
    expect(attachTransactionMatches(list, txns)[0].match).toBeNull();
  });

  it('refuses to hand one charge to two identical expenses', () => {
    const list = normalizeExpenses([
      expense({ id: 1, date: '2026-09-04T00:00:00Z' }),
      expense({ id: 2, date: '2026-09-05T00:00:00Z' }),
    ], ME);
    const [a, b] = attachTransactionMatches(list, txns);
    const claimed = [a.match, b.match].filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].transactionId).toBe('t1');
  });

  it('will not reach past the date window', () => {
    const list = normalizeExpenses([expense({ date: '2026-07-01T00:00:00Z' })], ME);
    expect(attachTransactionMatches(list, txns)[0].match).toBeNull();
  });

  it('does not try to match a settle-up', () => {
    const list = normalizeExpenses([expense({ payment: true, myOwed: '0.00', theirOwed: '60.00' })], ME);
    expect(attachTransactionMatches(list, txns)[0].match).toBeNull();
  });

  it('prefers the exact amount over the nearer date', () => {
    const list = normalizeExpenses([expense({ date: '2026-08-21T00:00:00Z', cost: '41.37', myPaid: '41.37', myOwed: '20.68', theirOwed: '20.69' })], ME);
    const near = { transactionId: 't4', date: '2026-08-21', description: 'CLOSE BUT OFF', account: 'x', amount: -41.36 };
    expect(attachTransactionMatches(list, [near, ...txns])[0].match).toMatchObject({ transactionId: 't3' });
  });
});
