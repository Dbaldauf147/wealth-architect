import { describe, it, expect } from 'vitest';
import { statementLookup, statementLabel, closeOnOrAfter, closePaidBy, ordinal } from './statementWindows.js';

const t = (id, date, amount, over = {}) => ({
  transactionId: id, date, amount, description: id, account: 'Sapphire', category: 'Dining', ...over,
});
const pay = (id, date, amount, over = {}) => t(id, date, amount, { category: 'Credit Card Payment', ...over });
const NOW = new Date('2026-10-06T12:00:00');

// A card that closes on the 15th and autopays on the 11th of the next month.
// Each payment is exactly the cycle before it, except the August one, which is
// 33¢ off — the kind of fee that never reaches the sheet.
const ledger = [
  t('m1', '2026-05-20', -40),                                // Jun 15 stmt: 40
  pay('p0', '2026-07-11', 40),
  t('j1', '2026-06-20', -100), t('j2', '2026-07-15', -50),   // Jul 15 stmt: 150
  pay('p1', '2026-08-11', 150),
  t('a1', '2026-07-16', -200), t('a2', '2026-08-15', -10),   // Aug 15 stmt: 210
  pay('p2', '2026-09-11', 210.33),
  t('s1', '2026-08-16', -70),                                // Sep 15 stmt: 70, not paid yet
  t('o1', '2026-09-16', -30), t('o2', '2026-10-05', -5),     // open, closes Oct 15
  t('chk', '2026-09-10', -20, { account: 'Checking' }),
  pay('stray', '2026-09-01', 99, { account: 'Checking' }),
];

describe('close-date arithmetic', () => {
  it('puts a charge on the first close on or after it, clamping short months', () => {
    expect(closeOnOrAfter(new Date(2026, 6, 15), 15)).toEqual(new Date(2026, 6, 15));
    expect(closeOnOrAfter(new Date(2026, 6, 16), 15)).toEqual(new Date(2026, 7, 15));
    expect(closeOnOrAfter(new Date(2026, 3, 30), 31)).toEqual(new Date(2026, 3, 30));
  });
  it('reads a payment as paying the close at least 20 days before it', () => {
    expect(closePaidBy(new Date(2026, 8, 11), 15)).toEqual(new Date(2026, 7, 15));
    expect(closePaidBy(new Date(2026, 8, 25), 2)).toEqual(new Date(2026, 8, 2));
  });
  it('writes ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 31].map(ordinal).join(' ')).toBe('1st 2nd 3rd 4th 11th 12th 13th 21st 22nd 31st');
  });
});

describe('statementLookup', () => {
  const { byTxn, cards } = statementLookup(ledger, {}, NOW);

  it('estimates the closing day from payments, tolerating a few cents of drift', () => {
    expect(cards.get('Sapphire')).toMatchObject({ day: 15, source: 'estimated' });
  });

  it('places each charge on its statement, with when it was paid', () => {
    expect(statementLabel(byTxn.get('j1'))).toMatchObject({ main: 'Jul 15 stmt', sub: 'paid Aug 11' });
    expect(statementLabel(byTxn.get('a1'))).toMatchObject({ main: 'Aug 15 stmt', sub: 'paid Sep 11' });
    expect(statementLabel(byTxn.get('s1'))).toMatchObject({ main: 'Sep 15 stmt', sub: 'not paid yet' });
  });

  it('calls charges after the last close current', () => {
    expect(statementLabel(byTxn.get('o2'))).toMatchObject({ main: 'Current', sub: 'closes Oct 15' });
  });

  it('tells a payment which statement it paid', () => {
    expect(statementLabel(byTxn.get('p2'))).toMatchObject({ main: 'Payment', sub: 'for Aug 15 stmt' });
  });

  it("doesn't treat one stray payment into checking as a card", () => {
    expect(cards.has('Checking')).toBe(false);
    expect(byTxn.has('chk')).toBe(false);
  });

  it('uses a closing day the user set over the estimate', () => {
    const { byTxn: b, cards: c } = statementLookup(ledger, { Sapphire: 20 }, NOW);
    expect(c.get('Sapphire')).toEqual({ day: 20, source: 'set' });
    expect(statementLabel(b.get('a2')).main).toBe('Aug 20 stmt');
    expect(statementLabel(b.get('a2')).title).toMatch(/20th \(set by you\)/);
  });

  it('lists a card it cannot estimate, with no placements', () => {
    const { byTxn: b, cards: c } = statementLookup([
      t('x1', '2026-08-01', -40), pay('x2', '2026-08-20', 999), pay('x3', '2026-09-20', 888),
    ], {}, NOW);
    expect(c.get('Sapphire')).toEqual({ day: null, source: null });
    expect(b.size).toBe(0);
  });
});
