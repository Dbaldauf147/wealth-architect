import { describe, it, expect } from 'vitest';
import { matchAlert, merchantSimilarity, pendingApplications } from './alertMatch.js';
import { parseAlert } from './parseAlert.js';

const txn = (id, date, amount, description, extra = {}) => ({
  transactionId: id, date, amount, description, ...extra,
});

const alert = (over = {}) => ({
  amount: 24.31, merchant: 'DUNKIN #12345', date: '2026-08-26', ...over,
});

describe('merchantSimilarity', () => {
  it('scores a full match when the sheet only adds location noise', () => {
    expect(merchantSimilarity('DUNKIN', 'DUNKIN 12345 BROOKLYN NY')).toBe(1);
  });

  it('scores nothing for unrelated merchants', () => {
    expect(merchantSimilarity('DUNKIN', 'SHELL SERVICE STATION')).toBe(0);
  });

  it('is unbothered by case and punctuation', () => {
    expect(merchantSimilarity("Trader Joe's #402", 'TRADER JOES 402 NEW YORK')).toBeGreaterThan(0.5);
  });

  it('returns 0 rather than dividing by nothing', () => {
    expect(merchantSimilarity('', 'DUNKIN')).toBe(0);
    expect(merchantSimilarity(null, null)).toBe(0);
  });
});

describe('matchAlert', () => {
  it('finds the row the card network reworded', () => {
    const txns = [
      txn('a', '2026-08-27', -24.31, 'DUNKIN 12345 BROOKLYN NY'),
      txn('b', '2026-08-27', -60.00, 'CON EDISON'),
    ];
    expect(matchAlert(alert(), txns).transaction.transactionId).toBe('a');
  });

  it('matches on the sheet’s M/D/YYYY dates as readily as ISO', () => {
    const txns = [txn('a', '8/27/2026', -24.31, 'DUNKIN 12345 BROOKLYN NY')];
    expect(matchAlert(alert(), txns).transaction.transactionId).toBe('a');
  });

  it('will not match a different amount', () => {
    expect(matchAlert(alert(), [txn('a', '2026-08-27', -24.32, 'DUNKIN BROOKLYN')])).toBeNull();
  });

  it('will not match across the sign', () => {
    // A $24.31 credit is not the coffee, whatever it is called.
    expect(matchAlert(alert(), [txn('a', '2026-08-27', 24.31, 'DUNKIN BROOKLYN')])).toBeNull();
  });

  it('pairs a refund with the positive row instead', () => {
    const txns = [txn('a', '2026-08-27', 32.10, 'TARGET REFUND')];
    const got = matchAlert(alert({ amount: 32.10, merchant: 'TARGET', refund: true }), txns);
    expect(got.transaction.transactionId).toBe('a');
  });

  it('allows the days a card takes to post', () => {
    const txns = [txn('a', '2026-09-03', -24.31, 'DUNKIN 12345 BROOKLYN NY')];
    expect(matchAlert(alert(), txns).transaction.transactionId).toBe('a');
  });

  it('refuses a row from a month away', () => {
    const txns = [txn('a', '2026-09-30', -24.31, 'DUNKIN 12345 BROOKLYN NY')];
    expect(matchAlert(alert(), txns)).toBeNull();
  });

  it('refuses to choose between two identical charges', () => {
    // Two $4.50 coffees the same day. Guessing writes a category onto the
    // wrong one silently, which is worse than asking.
    const txns = [
      txn('a', '2026-08-26', -4.50, 'BLUE BOTTLE COFFEE NY'),
      txn('b', '2026-08-26', -4.50, 'BLUE BOTTLE COFFEE NY'),
    ];
    expect(matchAlert(alert({ amount: 4.50, merchant: 'BLUE BOTTLE' }), txns)).toBeNull();
  });

  it('still decides when one candidate is clearly ahead', () => {
    const txns = [
      txn('a', '2026-08-26', -24.31, 'DUNKIN 12345 BROOKLYN NY'),
      txn('b', '2026-08-26', -24.31, 'CON EDISON UTILITY PAYMENT'),
    ];
    expect(matchAlert(alert(), txns).transaction.transactionId).toBe('a');
  });

  it('skips rows with no transaction id, which nothing can be written against', () => {
    expect(matchAlert(alert(), [{ date: '2026-08-27', amount: -24.31, description: 'DUNKIN' }])).toBeNull();
  });

  it('falls back to the arrival time when the bank quoted no date', () => {
    const txns = [txn('a', '2026-08-27', -24.31, 'DUNKIN 12345 BROOKLYN NY')];
    const got = matchAlert(alert({ date: null, receivedAt: '2026-08-26' }), txns);
    expect(got.transaction.transactionId).toBe('a');
  });
});

describe('pendingApplications', () => {
  const txns = [txn('a', '2026-08-27', -24.31, 'DUNKIN 12345 BROOKLYN NY', { category: '' })];

  it('pairs a decided alert with the row that arrived', () => {
    const got = pendingApplications([alert({ id: '1', category: 'Dining' })], txns);
    expect(got).toHaveLength(1);
    expect(got[0].transaction.transactionId).toBe('a');
    expect(got[0].category).toBe('Dining');
  });

  it('leaves an undecided alert alone', () => {
    expect(pendingApplications([alert({ id: '1' })], txns)).toEqual([]);
  });

  it('never overwrites a category already set on the row', () => {
    // Deciding on the row itself is later and better informed than the tap
    // made at the till.
    const filed = [txn('a', '2026-08-27', -24.31, 'DUNKIN BROOKLYN', { category: 'Groceries' })];
    expect(pendingApplications([alert({ id: '1', category: 'Dining' })], filed)).toEqual([]);
  });

  it('skips an alert already applied, so it cannot be applied twice', () => {
    expect(pendingApplications([alert({ id: '1', category: 'Dining', appliedTo: 'a' })], txns)).toEqual([]);
  });

  it('skips a dismissed alert', () => {
    expect(pendingApplications([alert({ id: '1', category: 'Dining', dismissed: true })], txns)).toEqual([]);
  });
});

/* The seam between the two halves.
 *
 * parseAlert names the fields; api/spend-alert copies them into the document;
 * matchAlert reads them back. Nothing type-checks that chain, and a rename on
 * one side would fail silently — alerts would simply never match anything, with
 * no error to notice. This walks a real message the whole way. */
describe('a bank text, end to end', () => {
  it('reaches the transaction the sheet delivers days later', () => {
    const sms = 'BofA: Your Acct 4321 had a $24.31 purchase at DUNKIN DONUTS on 08/26/26.';

    const parsed = parseAlert(sms);
    expect(parsed.ok).toBe(true);

    // Exactly the shape api/spend-alert writes to Firestore.
    const stored = {
      id: 'a1',
      source: 'sms',
      amount: parsed.amount,
      merchant: parsed.merchant,
      card: parsed.card,
      date: parsed.date || '2026-08-26',
      refund: parsed.refund,
      raw: parsed.raw,
      receivedAt: '2026-08-26T14:02:11.000Z',
      category: null,
      appliedTo: null,
      dismissed: false,
    };

    // The row as the sheet eventually carries it: reworded, days later,
    // negative, and in the sheet's own date format.
    const fromSheet = [{
      transactionId: 'T900',
      date: '8/28/2026',
      amount: -24.31,
      description: 'DUNKIN #12345 BROOKLYN NY',
      category: '',
    }];

    expect(matchAlert(stored, fromSheet).transaction.transactionId).toBe('T900');

    // And once a category is chosen, it is queued for that row.
    const ready = pendingApplications([{ ...stored, category: 'Dining' }], fromSheet);
    expect(ready).toEqual([
      expect.objectContaining({ category: 'Dining' }),
    ]);
    expect(ready[0].transaction.transactionId).toBe('T900');
  });
});

describe('telling two cards apart by the name the alert came from', () => {
  // Chase sends as the card — "Prime Visa" — and quotes no last four, so the
  // sender label is the only thing saying which card was used.
  const sameDayTwins = [
    txn('prime', '2026-08-27', -108.82, 'AMAZON MKTPLACE PMTS', { account: 'Amazon Prime Visa' }),
    txn('csr', '2026-08-27', -108.82, 'AMAZON MKTPLACE PMTS', { account: 'Chase Sapphire Reserve' }),
  ];

  it('picks the card the alert was sent from', () => {
    const got = matchAlert(
      { amount: 108.82, merchant: 'AMAZON MKTPLACE PMTS', date: '2026-08-27', bank: 'Prime Visa' },
      sameDayTwins,
    );
    expect(got.transaction.transactionId).toBe('prime');
  });

  it('picks the other one when the alert came from the other card', () => {
    const got = matchAlert(
      { amount: 108.82, merchant: 'AMAZON MKTPLACE PMTS', date: '2026-08-27', bank: 'Chase Sapphire Reserve Visa' },
      sameDayTwins,
    );
    expect(got.transaction.transactionId).toBe('csr');
  });

  it('still refuses when there is no card name to separate them', () => {
    const got = matchAlert(
      { amount: 108.82, merchant: 'AMAZON MKTPLACE PMTS', date: '2026-08-27' },
      sameDayTwins,
    );
    expect(got).toBeNull();
  });

  it('does not let "Visa" alone vouch for a card', () => {
    // Every Visa in the ledger would otherwise corroborate every Visa alert.
    expect(merchantSimilarity('Prime Visa', 'Chase Sapphire Reserve Visa')).toBe(0);
  });
});
