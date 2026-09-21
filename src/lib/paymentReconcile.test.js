import { describe, it, expect } from 'vitest';
import {
  paymentsOf,
  chargesOf,
  owedFor,
  reconcilePayments,
  reconstructExpected,
  comparePaymentForCard,
  buildChargeSheets,
} from './paymentReconcile.js';

const pay = (date, amount) => ({ date, amount, category: 'Credit Card Payment', description: 'Payment Thank You', account: 'CHASE CARD (1234)' });
const buy = (date, amount, description = 'Merchant') => ({ date, amount, category: 'Shopping', description, account: 'CHASE CARD (1234)' });

describe('paymentsOf / chargesOf', () => {
  const txns = [
    buy('2026-08-02', -50),
    pay('2026-08-15', 500),
    buy('2026-08-20', -25),
    // A refund is not a payment, however positive it is.
    { date: '2026-08-21', amount: 300, category: 'Shopping', description: 'Return' },
    { date: '2026-08-22', amount: 0, category: 'Shopping', description: 'Zero' },
  ];

  it('takes only the categorised payment leg', () => {
    const p = paymentsOf(txns);
    expect(p).toHaveLength(1);
    expect(p[0].amount).toBe(500);
  });

  it('keeps refunds among the charges and drops zero rows', () => {
    const c = chargesOf(txns);
    expect(c.map(t => t.amount)).toEqual([-50, -25, 300]);
  });

  it('owes the sign-flipped sum, netting refunds', () => {
    expect(owedFor([buy('2026-08-01', -100), buy('2026-08-02', -25), { date: '2026-08-03', amount: 30, _date: new Date(2026, 7, 3) }]))
      .toBe(95);
  });
});

describe('date handling', () => {
  it('reads a bare date as a local calendar day, not a UTC instant', () => {
    // `new Date('2026-08-15')` is UTC midnight, which prints and exports as the
    // 14th anywhere west of Greenwich. These dates get reconciled against a
    // paper statement, so the day has to survive the round trip.
    const [c] = chargesOf([buy('2026-08-15', -10)]);
    expect(c._date.getDate()).toBe(15);
    expect(c._date.getMonth()).toBe(7);
  });
});

describe('reconcilePayments', () => {
  it('recovers the statement window when the charges sum to the payment', () => {
    const charges = chargesOf([
      buy('2026-07-05', -100),
      buy('2026-07-10', -200),
      // Statement closed here: 100 + 200 = 300.
      buy('2026-08-02', -75),
    ]);
    const payments = paymentsOf([pay('2026-08-15', 300)]);
    const [r] = reconcilePayments({ payments, charges });
    expect(r.matched).toBe(true);
    expect(r.total).toBe(300);
    expect(r.charges.map(c => c.amount)).toEqual([-100, -200]);
    expect(r.closeDate).toEqual(new Date(2026, 6, 10));
  });

  it('chains windows so the second payment starts where the first stopped', () => {
    const charges = chargesOf([
      buy('2026-06-05', -100),
      buy('2026-06-10', -200),
      buy('2026-07-05', -50),
      buy('2026-07-09', -25),
    ]);
    const payments = paymentsOf([pay('2026-07-15', 300), pay('2026-08-15', 75)]);
    const [first, second] = reconcilePayments({ payments, charges });
    expect(first.matched).toBe(true);
    expect(second.matched).toBe(true);
    expect(second.charges.map(c => c.amount)).toEqual([-50, -25]);
    // No charge is claimed by two payments.
    const ids = [...first.charges, ...second.charges].map(c => c.date);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only closes on a day boundary, never mid-day', () => {
    // 100 + 200 = 300 would match, but both fall on the same day as a third
    // charge, so the statement could not have closed between them.
    const charges = chargesOf([
      buy('2026-07-10', -100, 'A'),
      buy('2026-07-10', -200, 'B'),
      buy('2026-07-10', -40, 'C'),
    ]);
    const payments = paymentsOf([pay('2026-08-15', 300)]);
    const [r] = reconcilePayments({ payments, charges });
    expect(r.matched).toBe(false);
  });

  it('reports an unreconciled payment rather than inventing a window', () => {
    const charges = chargesOf([buy('2026-07-05', -100), buy('2026-07-10', -200)]);
    const payments = paymentsOf([pay('2026-08-15', 999)]);
    const [r] = reconcilePayments({ payments, charges });
    expect(r.matched).toBe(false);
    expect(r.closeDate).toBeNull();
    // It still hands back what it looked at, so the export isn't empty.
    expect(r.charges).toHaveLength(2);
    expect(r.total).toBe(300);
  });

  it('excludes a charge dated the same day as the payment', () => {
    const charges = chargesOf([buy('2026-07-10', -300), buy('2026-08-15', -40)]);
    const payments = paymentsOf([pay('2026-08-15', 300)]);
    const [r] = reconcilePayments({ payments, charges });
    expect(r.matched).toBe(true);
    expect(r.charges).toHaveLength(1);
  });

  it('reconciles a window containing a refund', () => {
    const charges = chargesOf([
      buy('2026-07-05', -100),
      { date: '2026-07-06', amount: 30, category: 'Shopping', description: 'Return' },
      buy('2026-07-10', -230),
    ]);
    const payments = paymentsOf([pay('2026-08-15', 300)]);
    const [r] = reconcilePayments({ payments, charges });
    expect(r.matched).toBe(true);
    expect(r.total).toBe(300);
  });

  it('tolerates a cent of float drift', () => {
    const charges = chargesOf([buy('2026-07-05', -33.33), buy('2026-07-06', -33.33), buy('2026-07-07', -33.34)]);
    const payments = paymentsOf([pay('2026-08-15', 100)]);
    expect(reconcilePayments({ payments, charges })[0].matched).toBe(true);
  });
});

describe('reconstructExpected', () => {
  it('counts charges since the previous payment, up to the day before', () => {
    const charges = chargesOf([
      buy('2026-07-01', -500),   // before the previous payment — not counted
      buy('2026-07-20', -100),
      buy('2026-08-10', -200),
      buy('2026-08-15', -900),   // the payment's own day — not counted
    ]);
    const payments = paymentsOf([pay('2026-07-15', 500), pay('2026-08-15', 6915)]);
    const e = reconstructExpected({ payment: payments[1], prevPayment: payments[0], charges });
    expect(e.amount).toBe(300);
    expect(e.source).toBe('reconstructed');
  });

  it('counts everything before the payment when there is no previous one', () => {
    const charges = chargesOf([buy('2026-07-01', -500), buy('2026-07-20', -100)]);
    const payments = paymentsOf([pay('2026-08-15', 600)]);
    expect(reconstructExpected({ payment: payments[0], prevPayment: null, charges }).amount).toBe(600);
  });
});

describe('comparePaymentForCard', () => {
  // The shape of the user's case: the estimate looked only at charges since the
  // last payment, while the statement that was actually billed reached further
  // back, so the real payment came in far higher.
  const txns = [
    buy('2026-06-20', -3529, 'Charges the estimate never saw'),
    pay('2026-07-15', 1000),
    buy('2026-07-20', -1386, 'A'),
    buy('2026-08-01', -2000, 'B'),
    pay('2026-08-15', 6915),
  ];

  it('reports actual and expected, and the gap between them', () => {
    const r = comparePaymentForCard({ transactions: txns });
    expect(r.actual.amount).toBe(6915);
    expect(r.expected.amount).toBe(3386);
    expect(r.expected.source).toBe('reconstructed');
    expect(r.variance).toBe(3529);
  });

  it('prefers the recorded email figure and says so', () => {
    const r = comparePaymentForCard({
      transactions: txns,
      recorded: { amount: 3386, sentAt: '2026-08-14T12:00:00Z', charges: [buy('2026-07-20', -1386, 'A'), buy('2026-08-01', -2000, 'B')] },
    });
    expect(r.expected.source).toBe('emailed');
    expect(r.expected.amount).toBe(3386);
    expect(r.expected.charges).toHaveLength(2);
  });

  it('gives back no lines for a recorded amount that arrived without them', () => {
    // Better an empty export than one whose rows don't add up to the figure.
    const r = comparePaymentForCard({ transactions: txns, recorded: { amount: 3386 } });
    expect(r.expected.source).toBe('emailed');
    expect(r.expected.charges).toEqual([]);
  });

  it('has nothing to compare on a card that was never paid', () => {
    const r = comparePaymentForCard({ transactions: [buy('2026-08-01', -20)] });
    expect(r.actual).toBeNull();
    expect(r.expected).toBeNull();
  });
});

describe('buildChargeSheets', () => {
  const charges = chargesOf([buy('2026-07-20', -1386, 'A'), buy('2026-08-01', -2000, 'B')]);

  it('lists the charges with a running total and a total row that ties out', () => {
    const [summary, detail] = buildChargeSheets({
      cardName: 'Chase Sapphire Reserve', kind: 'expected', figure: 3386, charges,
    });
    expect(summary.rows).toContainEqual(['Ties out', 'Yes']);
    expect(detail.rows[0]).toEqual(['Date', 'Description', 'Category', 'Account', 'Amount', 'Running total']);
    expect(detail.rows[1][1]).toBe('A');
    expect(detail.rows[2][5]).toBe(3386);
    expect(detail.rows[detail.rows.length - 1]).toEqual(['', '', '', 'Total', 3386, '']);
  });

  it('says so when the lines do not add up to the figure', () => {
    const [summary] = buildChargeSheets({ cardName: 'X', kind: 'actual', figure: 6915, charges });
    expect(summary.rows).toContainEqual(['Ties out', 'No']);
  });
});
