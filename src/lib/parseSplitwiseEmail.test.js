import { describe, it, expect } from 'vitest';
import { parseSplitwiseEmail, isSplitwiseSummaryEmail, monthLabel } from './parseSplitwiseEmail.js';

// The October 2026 summary as copied out of Gmail, header lines included.
const PASTED = `Your balance for October
Inbox

Splitwise <hello@splitwise.com> Unsubscribe
4:53 PM (3 minutes ago)
to me

Splitwise
October is over. Here’s what’s up in your account on Splitwise:

Review your spending


Total balance
you are owed $54.00
    Kyle Smith
you owe $32.80
    Harry Poulos
owes you $26.02
    Kate Soskil
owes you $26.01
    Sunnie Martensen
owes you $26.01
Plus 5 more friends »


Largest expenses
Oct.
27
Settle all balances
you lent $2,686.92
Oct.
27
Settle all balances
you borrowed $2,686.92
Oct.
23
Winter Storage
you borrowed $448.00
Oct.
27
Test
you lent $0.50
See all transactions »


Visit Splitwise now

P.S. Already paid back your friend outside the app? In Splitwise, choose “Settle up” -> “Record a cash payment” to clear your balance
`;

// Roughly what Gmail's getPlainBody() gives: links inline, pieces run together.
const PLAIN = `Splitwise <https://www.splitwise.com>
October is over. Here's what's up in your account on Splitwise:
Review your spending <https://secure.splitwise.com/#/all>
Total balance you are owed $54.00
Kyle Smith you owe $32.80
Harry Poulos owes you $26.02
Plus 5 more friends » <https://secure.splitwise.com/#/friends>
Largest expenses
Oct. 23 Winter Storage you borrowed $448.00
Oct. 27 Test you lent $0.50
See all transactions » <https://secure.splitwise.com/#/all>
`;

describe('parseSplitwiseEmail', () => {
  it('reads the pasted October email', () => {
    const r = parseSplitwiseEmail({ subject: '', date: '2026-11-01T21:53:00Z', body: PASTED });
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({
      month: '2026-10',
      totalBalance: 54,
      friends: [
        { name: 'Kyle Smith', amount: -32.8 },
        { name: 'Harry Poulos', amount: 26.02 },
        { name: 'Kate Soskil', amount: 26.01 },
        { name: 'Sunnie Martensen', amount: 26.01 },
      ],
      moreFriends: 5,
      expenses: [
        { date: '2026-10-27', description: 'Settle all balances', direction: 'lent', amount: 2686.92, settlement: true },
        { date: '2026-10-27', description: 'Settle all balances', direction: 'borrowed', amount: 2686.92, settlement: true },
        { date: '2026-10-23', description: 'Winter Storage', direction: 'borrowed', amount: 448, settlement: false },
        { date: '2026-10-27', description: 'Test', direction: 'lent', amount: 0.5, settlement: false },
      ],
    });
  });

  it('reads the run-together plain-text layout, with links stripped', () => {
    const r = parseSplitwiseEmail({ subject: 'Your balance for October', date: '2026-11-01T21:53:00Z', body: PLAIN });
    expect(r.summary.totalBalance).toBe(54);
    expect(r.summary.friends).toEqual([{ name: 'Kyle Smith', amount: -32.8 }, { name: 'Harry Poulos', amount: 26.02 }]);
    expect(r.summary.moreFriends).toBe(5);
    expect(r.summary.expenses.map(e => [e.date, e.description, e.direction, e.amount]))
      .toEqual([['2026-10-23', 'Winter Storage', 'borrowed', 448], ['2026-10-27', 'Test', 'lent', 0.5]]);
  });

  it('puts the December summary sent in January in the previous year', () => {
    const r = parseSplitwiseEmail({ subject: 'Your balance for December', date: '2027-01-01T12:00:00Z', body: 'Total balance\nyou owe $10.00\nLargest expenses\nDec.\n30\nDinner\nyou borrowed $10.00' });
    expect(r.summary.month).toBe('2026-12');
    expect(r.summary.totalBalance).toBe(-10);
    expect(r.summary.expenses[0].date).toBe('2026-12-30');
  });

  it('turns down mail that is not the monthly summary', () => {
    expect(parseSplitwiseEmail({ subject: 'Kyle added "Pizza"', body: 'You owe $5.00' }).ok).toBe(false);
  });
});

describe('isSplitwiseSummaryEmail', () => {
  it('spots the summary by sender and heading', () => {
    expect(isSplitwiseSummaryEmail({ from: 'Splitwise <hello@splitwise.com>', subject: 'Your balance for October', body: '' })).toBe(true);
    expect(isSplitwiseSummaryEmail({ from: 'Splitwise <hello@splitwise.com>', subject: 'Kyle added "Pizza"', body: '' })).toBe(false);
    expect(isSplitwiseSummaryEmail({ from: 'auto-confirm@amazon.com', subject: 'Your balance for October', body: '' })).toBe(false);
  });

  it('labels a month', () => {
    expect(monthLabel('2026-10')).toBe('October 2026');
  });
});
