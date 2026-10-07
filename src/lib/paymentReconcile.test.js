import { describe, it, expect } from 'vitest';
import {
  paymentsOf,
  chargesOf,
  owedFor,
  reconcilePayments,
  reconstructExpected,
  comparePaymentForCard,
  buildChargeSheets,
  buildPaymentHistory,
  auditPrediction,
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

describe('reconcilePayments — windows that do not start at the chain', () => {
  it('finds a statement whose window opens partway through the ledger', () => {
    // The card was already open when the sheet begins, so the first charges
    // belong to a statement that was paid before any of this history. An
    // anchored-only matcher gives up here; the payment is still explainable.
    const charges = chargesOf([
      buy('2026-06-01', -812, 'Belongs to an earlier statement'),
      buy('2026-07-05', -100),
      buy('2026-07-10', -200),
    ]);
    const payments = paymentsOf([pay('2026-08-15', 300)]);
    const [r] = reconcilePayments({ payments, charges });
    expect(r.matched).toBe(true);
    expect(r.anchored).toBe(false);
    expect(r.total).toBe(300);
    expect(r.charges.map(c => c.description)).toEqual(['Merchant', 'Merchant']);
    // What it stepped over is reported, not quietly dropped.
    expect(r.skipped.map(c => c.amount)).toEqual([-812]);
  });

  it('prefers the anchored window when both would sum', () => {
    // 100 + 200 anchored, and 300 alone later. The anchored one is the
    // statement that actually picks up where the last left off.
    const charges = chargesOf([buy('2026-07-05', -100), buy('2026-07-10', -200), buy('2026-07-20', -300)]);
    const payments = paymentsOf([pay('2026-08-15', 300)]);
    const [r] = reconcilePayments({ payments, charges });
    expect(r.anchored).toBe(true);
    expect(r.charges).toHaveLength(2);
  });

  it('prefers the latest-ending window when no anchored one sums', () => {
    const charges = chargesOf([buy('2026-06-01', -55), buy('2026-07-05', -300), buy('2026-07-20', -300)]);
    const payments = paymentsOf([pay('2026-08-15', 300)]);
    const [r] = reconcilePayments({ payments, charges });
    expect(r.matched).toBe(true);
    expect(r.anchored).toBe(false);
    expect(r.closeDate).toEqual(new Date(2026, 6, 20));
  });
});

describe('buildPaymentHistory', () => {
  const txns = [
    buy('2026-06-01', -500, 'June'),
    buy('2026-06-20', -3529, 'Before the July payment'),
    pay('2026-07-15', 500),
    buy('2026-07-20', -1386, 'A'),
    buy('2026-08-01', -2000, 'B'),
    pay('2026-08-15', 6915),
  ];

  it('returns one row per payment, newest first', () => {
    const rows = buildPaymentHistory({ transactions: txns });
    expect(rows).toHaveLength(2);
    expect(rows[0].dateKey).toBe('2026-08-15');
    expect(rows[1].dateKey).toBe('2026-07-15');
  });

  it('carries expected, actual and the gap for each row', () => {
    const [latest] = buildPaymentHistory({ transactions: txns });
    expect(latest.actual.amount).toBe(6915);
    expect(latest.actual.matched).toBe(true);
    expect(latest.expected.amount).toBe(3386);
    expect(latest.variance).toBe(3529);
  });

  it('uses a recorded figure only on the payment it belongs to', () => {
    const rows = buildPaymentHistory({
      transactions: txns,
      recorded: [{ dateKey: '2026-08-15', amount: 3386, sentAt: '2026-08-14T12:00:00Z', charges: [buy('2026-07-20', -1386, 'A')] }],
    });
    expect(rows[0].expected.source).toBe('emailed');
    expect(rows[1].expected.source).toBe('reconstructed');
  });

  it('carries the payment date on the actual side, for the export to stamp', () => {
    const [latest] = buildPaymentHistory({ transactions: txns });
    expect(latest.actual.date).toEqual(new Date(2026, 7, 15));
  });

  it('is empty for a card that was never paid', () => {
    expect(buildPaymentHistory({ transactions: [buy('2026-08-01', -20)] })).toEqual([]);
  });
});

describe('with a known statement closing day', () => {
  // Closes the 15th, autopays the 11th. The August statement is 33¢ short of
  // its payment — interest the sheet never saw — and a stray double payment in
  // between would have broken run-matching's chain for everything after it.
  const txns = [
    buy('2026-06-16', -100, 'Jul A'), buy('2026-07-15', -50, 'Jul B'),
    pay('2026-08-11', 150),
    buy('2026-07-16', -200, 'Aug A'), buy('2026-08-15', -10, 'Aug B'),
    pay('2026-09-11', 210.33),
    buy('2026-08-16', -70, 'Sep A'), buy('2026-09-10', -500, 'Sep big'),
    pay('2026-10-11', 400),
  ];
  const rows = buildPaymentHistory({ transactions: txns, closeDay: 15 });
  const byDate = Object.fromEntries(rows.map(r => [r.dateKey, r.actual]));

  it('takes each payment\'s charges from its statement cycle', () => {
    const jul = byDate['2026-08-11'];
    expect(jul.basis).toBe('closeDay');
    expect(jul.openDate).toEqual(new Date(2026, 5, 16));
    expect(jul.closeDate).toEqual(new Date(2026, 6, 15));
    expect(jul.charges.map(c => c.description)).toEqual(['Jul A', 'Jul B']);
    expect(jul.matched).toBe(true);
  });

  it('calls a few cents of drift near, not matched', () => {
    const aug = byDate['2026-09-11'];
    expect(aug.total).toBe(210);
    expect(aug.drift).toBe(0.33);
    expect(aug.matched).toBe(false);
    expect(aug.near).toBe(true);
  });

  it('reports a payment that is not the statement balance as far off', () => {
    const sep = byDate['2026-10-11'];
    expect(sep.total).toBe(570);
    expect(sep.near).toBe(false);
    expect(sep.drift).toBe(-170);
  });

  it('gives the schedule row the same answer as the history', () => {
    const r = comparePaymentForCard({ transactions: txns, closeDay: 15 });
    expect(r.actual.closeDate).toEqual(new Date(2026, 8, 15));
    expect(r.actual.total).toBe(570);
  });

  it('falls back to run-matching without a closing day', () => {
    const [latest] = buildPaymentHistory({ transactions: txns });
    expect(latest.actual.basis).toBe('runMatch');
  });
});

describe('auditPrediction', () => {
  // Closes the 15th. The 2026-09-11 payment pays Jul 16 – Aug 15; the estimate
  // counted Aug 12 – Sep 10 (after the previous payment, before this one).
  const id = (t, transactionId) => ({ ...t, transactionId });
  const txns = [
    buy('2026-07-01', -150, 'Prev statement'),
    pay('2026-08-11', 150),
    id(buy('2026-07-20', -200, 'Old dinner'), 'old'),
    id(buy('2026-08-13', -40, 'Gas'), 'gas'),
    id(buy('2026-08-20', -60, 'After close'), 'late'),
    pay('2026-09-11', 245),
  ];
  const latest = () => buildPaymentHistory({ transactions: txns, closeDay: 15 })[0];

  it('names the charges each side got wrong and why', () => {
    const row = latest();
    expect(row.expected.amount).toBe(100);
    expect(row.variance).toBe(145);
    const a = auditPrediction(row);
    expect(a.status).toBe('miss');
    expect(a.items.map(i => [i.kind, i.charge.description, i.impact])).toEqual([
      ['missed', 'Old dinner', 200],
      ['extra', 'After close', -60],
    ]);
    expect(a.items[0].reason).toMatch(/on or before the previous payment/);
    expect(a.items[1].reason).toMatch(/after the statement closed/);
  });

  it('puts what no charge explains in the residual, so it all adds up to the variance', () => {
    const row = latest();
    const a = auditPrediction(row);
    expect(a.residual).toBe(5);
    expect(a.residualReason).toMatch(/interest, a fee/);
    expect(round(a.explained + a.residual)).toBe(row.variance);
  });

  it('reports a charge counted at one amount and posted at another as changed', () => {
    const rows = buildPaymentHistory({
      transactions: txns,
      closeDay: 15,
      recorded: [{
        dateKey: '2026-09-11', amount: 90, sentAt: '2026-09-10T12:00:00Z',
        charges: [id(buy('2026-08-13', -30, 'Gas'), 'gas'), id(buy('2026-08-20', -60, 'After close'), 'late')],
      }],
    });
    const a = auditPrediction(rows[0]);
    const changed = a.items.find(i => i.kind === 'changed');
    expect(changed.charge.description).toBe('Gas');
    expect(changed.impact).toBe(10);
    expect(a.items.filter(i => i.charge.description === 'Gas')).toHaveLength(1);
  });

  it('falls back to the rebuilt lines when the emailed record kept none', () => {
    const rows = buildPaymentHistory({
      transactions: txns,
      closeDay: 15,
      recorded: [{ dateKey: '2026-09-11', amount: 100, sentAt: '2026-09-10T12:00:00Z' }],
    });
    const a = auditPrediction(rows[0]);
    expect(a.note).toMatch(/rebuilt from the ledger/);
    expect(a.items.map(i => i.charge.description)).toEqual(['Old dinner', 'After close']);
  });

  it('is clean when the estimate and the statement agree', () => {
    const clean = [
      buy('2026-07-01', -150), pay('2026-08-11', 150),
      buy('2026-08-12', -80, 'Only'), pay('2026-09-11', 80),
    ];
    // Close on the 15th puts Aug 12 in neither window cleanly; use the 12th.
    const [row] = buildPaymentHistory({ transactions: clean, closeDay: 12 });
    expect(auditPrediction(row)).toMatchObject({ status: 'ok', items: [], residual: 0 });
  });

  it("can't audit a payment whose statement wasn't found", () => {
    const [row] = buildPaymentHistory({ transactions: [buy('2026-08-01', -20), pay('2026-08-15', 999)] });
    expect(auditPrediction(row).status).toBe('unknown');
  });
});

function round(n) { return Math.round(n * 100) / 100; }
