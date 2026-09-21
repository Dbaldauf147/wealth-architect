import { describe, it, expect } from 'vitest';
import { buildCardSchedule } from './cardSchedule.js';

const CARD = 'CHASE SAPPHIRE RESERVE (1947)';
const cards = [{ name: CARD }];

const pay = (date, amount) => ({ date, amount, category: 'Credit Card Payment', description: 'Payment Thank You', account: CARD });
const buy = (date, amount, description = 'Merchant') => ({ date, amount, category: 'Shopping', description, account: CARD });

const only = (transactions, asOf) => buildCardSchedule({ cards, transactions, asOf })[0];

describe('buildCardSchedule — which statement the next payment settles', () => {
  /* A card on a one-month lag. Statements close on the 14th; each is paid
     around the 12th of the month after. On Sep 21 the payment coming up in
     October settles the statement that closed Sep 14 — NOT the spending done
     since the September payment, which belongs to the October statement and
     won't be paid until November. */
  const laggedCard = [
    buy('2026-07-20', -1386, 'In the Aug 14 statement'),
    buy('2026-08-01', -2000, 'In the Aug 14 statement'),
    // Aug 14 statement closes at 3386, paid Sep 11.
    pay('2026-09-11', 3386),
    buy('2026-08-22', -410, 'In the Sep 14 statement'),
    buy('2026-09-05', -90, 'In the Sep 14 statement'),
    buy('2026-09-18', -5000, 'October statement — not due yet'),
  ];
  const asOf = new Date(2026, 8, 21); // Sep 21

  it('bills the closed statement, not the spending since the last payment', () => {
    const s = only(laggedCard, asOf);
    // The wrong answer here is 5000 — everything since the Sep 11 payment.
    expect(s.estimatedNextAmount).toBe(500);
    expect(s.nextPaymentCharges.map(t => t.amount).sort((a, b) => a - b)).toEqual([-410, -90]);
  });

  it('recovers the window from the reconciled close date', () => {
    const s = only(laggedCard, asOf);
    expect(s.windowSource).toBe('reconciled');
    // The run that summed to 3386 ended Aug 1 and the next charge is Aug 22,
    // so the statement closed between them — the window opens at the midpoint
    // and runs a cycle on. No charge is dated inside that gap, so nothing can
    // fall out of both statements.
    expect(s.statementOpen.getTime()).toBeGreaterThan(new Date(2026, 7, 1).getTime());
    expect(s.statementOpen.getTime()).toBeLessThan(new Date(2026, 7, 22).getTime());
    expect(s.statementClose).not.toBeNull();
  });

  it('excludes charges after the window from the next payment', () => {
    const s = only(laggedCard, asOf);
    expect(s.nextPaymentCharges.some(t => t.description.includes('October'))).toBe(false);
  });
});

describe('buildCardSchedule — a full year of a lagged card', () => {
  /* A whole ledger rather than a handful of rows: statements close on the 14th,
     each is paid on the 12th of the month after, and spending lands every five
     days through the month. Amounts carry cents, which is what makes the window
     recoverable — two different runs of real charges summing to the same cent
     essentially doesn't happen. */
  const iso = (m, d) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const closeOf = (m) => new Date(2026, m - 1, 14);
  const txns = [];
  const charges = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const m of [4, 5, 6, 7, 8, 9]) {
    for (const d of [3, 8, 13, 18, 23, 28]) {
      if (m === 9 && d > 18) continue;   // today is Sep 21
      const amount = -Math.round((10 + rnd() * 400) * 100) / 100;
      charges.push({ m, d, amount });
      txns.push(buy(iso(m, d), amount, `charge ${iso(m, d)}`));
    }
  }
  const inWindow = (lo, hi) => charges.filter(c => {
    const d = new Date(2026, c.m - 1, c.d);
    return d > lo && d <= hi;
  });
  for (const m of [5, 6, 7, 8]) {
    const total = Math.round(inWindow(closeOf(m - 1), closeOf(m)).reduce((s, c) => s + -c.amount, 0) * 100) / 100;
    txns.push(pay(iso(m + 1, 12), total));
  }

  const asOf = new Date(2026, 8, 21);
  const truth = inWindow(closeOf(8), closeOf(9));
  const truthTotal = Math.round(truth.reduce((s, c) => s + -c.amount, 0) * 100) / 100;

  it('bills exactly the statement that closed, to the cent', () => {
    const s = only(txns, asOf);
    expect(Math.round(s.estimatedNextAmount * 100) / 100).toBe(truthTotal);
  });

  it('picks exactly the charges on that statement', () => {
    const s = only(txns, asOf);
    expect(s.nextPaymentCharges.map(t => t.date).sort())
      .toEqual(truth.map(c => iso(c.m, c.d)).sort());
  });

  it('recovers a window that lands on the real close date', () => {
    const s = only(txns, asOf);
    expect(s.windowSource).toBe('reconciled');
    // True close is Sep 14; the estimate is allowed a couple of days either way.
    expect(Math.abs(s.statementClose - closeOf(9)) / 86400000).toBeLessThanOrEqual(2);
  });

  it('is nowhere near the old "since the last payment" answer', () => {
    const s = only(txns, asOf);
    const sinceLastPayment = Math.round(charges
      .filter(c => new Date(2026, c.m - 1, c.d) > new Date(2026, 8, 12))
      .reduce((acc, c) => acc + -c.amount, 0) * 100) / 100;
    // That's the bug: it reported a fraction of the bill, from the wrong month.
    expect(sinceLastPayment).not.toBe(truthTotal);
    expect(Math.round(s.estimatedNextAmount * 100) / 100).not.toBe(sinceLastPayment);
  });
});

describe('buildCardSchedule — falling back a cycle when nothing reconciles', () => {
  // No run of charges sums to either payment, so the close dates can't be
  // recovered. The gap between the two most recent payments stands in — still
  // a cycle back, which is the part that matters.
  const messy = [
    buy('2026-06-10', -700, 'Before the July payment'),
    pay('2026-07-15', 999),
    buy('2026-07-20', -300, 'Between the payments'),
    buy('2026-08-02', -200, 'Between the payments'),
    pay('2026-08-15', 1234),
    buy('2026-08-20', -8888, 'After the last payment'),
  ];
  const asOf = new Date(2026, 8, 1);

  it('uses the gap between the last two payments', () => {
    const s = only(messy, asOf);
    expect(s.windowSource).toBe('payment-gap');
    expect(s.estimatedNextAmount).toBe(500);
  });

  it('leaves out spending after the last payment', () => {
    const s = only(messy, asOf);
    expect(s.nextPaymentCharges.some(t => t.amount === -8888)).toBe(false);
  });

  it('treats a window that has already ended as closed', () => {
    expect(only(messy, asOf).statementClosed).toBe(true);
  });
});

describe('buildCardSchedule — a card with too little history', () => {
  // One payment and nothing reconciled: there is no previous cycle to shift
  // back to, so the old "everything since" behaviour stands.
  const thin = [pay('2026-08-15', 1234), buy('2026-08-20', -60)];

  it('keeps counting from the last payment', () => {
    const s = only(thin, new Date(2026, 8, 1));
    expect(s.windowSource).toBe('since-last-payment');
    expect(s.estimatedNextAmount).toBe(60);
    expect(s.statementClosed).toBe(false);
  });

  it('reports nothing for a card that was never paid', () => {
    const s = only([buy('2026-08-20', -60)], new Date(2026, 8, 1));
    expect(s.lastPayment).toBeNull();
    expect(s.nextPaymentDate).toBeNull();
  });
});

describe('buildCardSchedule — dates are local calendar days', () => {
  it('reports a payment on the day it is dated', () => {
    // `new Date('2026-09-12')` is UTC midnight, i.e. Sep 11 in any US zone —
    // the schedule used to show every payment a day early. It also has to agree
    // with paymentReconcile, which supplies the statement window the charges
    // here are filtered against.
    const s = only([buy('2026-08-05', -100), pay('2026-09-12', 100)], new Date(2026, 8, 20));
    expect(s.lastPayment.date.getDate()).toBe(12);
    expect(s.lastPayment.date.getMonth()).toBe(8);
  });
});

describe('buildCardSchedule — unchanged behaviour', () => {
  const regular = [
    buy('2026-05-20', -100),
    pay('2026-06-15', 100),
    buy('2026-06-20', -200),
    pay('2026-07-15', 200),
    buy('2026-07-20', -300),
    pay('2026-08-15', 300),
  ];

  it('still projects the next payment date from the recurrence', () => {
    const s = only(regular, new Date(2026, 7, 20));
    expect(s.nextPaymentDate).not.toBeNull();
    expect(s.nextPaymentDate.getMonth()).toBe(8); // September
    expect(s.recurrence).toBeTruthy();
  });

  it('still reports the last payment and the cadence', () => {
    const s = only(regular, new Date(2026, 7, 20));
    expect(s.lastPayment.amount).toBe(300);
    expect(s.cadenceDays).toBe(31);
  });
});
