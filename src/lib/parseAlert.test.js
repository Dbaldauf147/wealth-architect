import { describe, it, expect } from 'vitest';
import { parseAlert } from './parseAlert.js';

/* The wordings below are the shapes the major US card issuers send. They are
   here so a change to the parser has to stay honest about all of them at once
   — every one of these was a separate guess about where the merchant ends. */
const REAL_WORLD = [
  {
    bank: 'Bank of America',
    text: 'BofA: Your Acct 4321 had a $24.31 purchase at DUNKIN DONUTS on 08/26/26.',
    expect: { amount: 24.31, merchant: 'DUNKIN DONUTS', card: '4321', date: '2026-08-26' },
  },
  {
    bank: 'Chase',
    text: 'Chase: You made a $132.19 transaction with WHOLE FOODS #10233 on Aug 26, 2026 at 8:14 AM ET.',
    expect: { amount: 132.19, merchant: 'WHOLE FOODS #10233', date: '2026-08-26' },
  },
  {
    bank: 'Capital One',
    text: 'Capital One: A $9.99 transaction at SPOTIFY USA was charged to your card ending in 7788 on Aug 26.',
    expect: { amount: 9.99, merchant: 'SPOTIFY USA', card: '7788' },
  },
  {
    bank: 'Citi',
    text: 'Citi Alert: A $54.00 transaction was made on your Citi card ending in 1122 at SHELL OIL 5732 on 08/26/2026.',
    expect: { amount: 54, merchant: 'SHELL OIL 5732', card: '1122', date: '2026-08-26' },
  },
  {
    bank: 'Wells Fargo',
    text: 'Wells Fargo Alert: A $18.75 purchase was made on your card ending in 9090 at TRADER JOES.',
    expect: { amount: 18.75, merchant: 'TRADER JOES', card: '9090' },
  },
  {
    bank: 'Amex',
    text: 'Amex: Large Purchase Approved on your acct ending 1-23456 for $412.00 at APPLE STORE. 08/26/2026',
    expect: { amount: 412, merchant: 'APPLE STORE', card: '23456', date: '2026-08-26' },
  },
];

describe('parseAlert — real issuer wordings', () => {
  for (const c of REAL_WORLD) {
    it(`reads a ${c.bank} alert`, () => {
      const got = parseAlert(c.text);
      expect(got.ok).toBe(true);
      for (const [k, v] of Object.entries(c.expect)) expect({ [k]: got[k] }).toEqual({ [k]: v });
    });
  }
});

describe('parseAlert — the amount', () => {
  it('takes the transaction, not the balance quoted after it', () => {
    const got = parseAlert('Chase: A $24.31 purchase at DUNKIN. Available credit: $1,204.55');
    expect(got.amount).toBe(24.31);
  });

  it('reads thousands separators', () => {
    expect(parseAlert('Citi: A $1,299.00 transaction at APPLE STORE').amount).toBe(1299);
  });

  it('reads a whole-dollar amount', () => {
    expect(parseAlert('BofA: a $50 purchase at SHELL').amount).toBe(50);
  });

  it('refuses an alert with no amount at all', () => {
    const got = parseAlert('Chase: Your card was used today.');
    expect(got.ok).toBe(false);
    expect(got.reason).toBe('no-amount');
  });
});

describe('parseAlert — what is not a purchase', () => {
  const skipped = [
    'Chase: Your $24.31 transaction at DUNKIN was declined.',
    'BofA: Payment received, thank you. $500.00',
    'Citi: Your statement balance is $1,204.55.',
    'Chase: Your verification code is 448213. Do not share it.',
    'Wells Fargo: Low balance alert. Your balance is $18.02.',
  ];
  for (const text of skipped) {
    it(`ignores: ${text.slice(0, 42)}…`, () => {
      const got = parseAlert(text);
      expect(got.ok).toBe(false);
      expect(got.reason).toBe('not-a-purchase');
    });
  }
});

describe('parseAlert — refunds', () => {
  it('flags money coming back', () => {
    const got = parseAlert('Amex: A refund of $32.10 from TARGET was credited to your acct ending 1234.');
    expect(got.ok).toBe(true);
    expect(got.refund).toBe(true);
    expect(got.amount).toBe(32.10);
  });

  it('leaves an ordinary purchase unflagged', () => {
    expect(parseAlert('BofA: a $12.00 purchase at TARGET').refund).toBe(false);
  });
});

describe('parseAlert — the merchant', () => {
  it('does not mistake a clock time for a merchant', () => {
    const got = parseAlert('Chase: $8.00 charged at 8:14 AM with BLUE BOTTLE COFFEE on Aug 26, 2026');
    expect(got.merchant).toBe('BLUE BOTTLE COFFEE');
  });

  it('does not swallow the card clause', () => {
    const got = parseAlert('Citi: A $54.00 transaction at SHELL on card ending in 1122');
    expect(got.merchant).toBe('SHELL');
  });

  it('keeps a store number, which is what makes the row match', () => {
    expect(parseAlert('Chase: $5.00 with STARBUCKS #0871 on Aug 1, 2026').merchant).toBe('STARBUCKS #0871');
  });

  it('returns null rather than guessing when there is no merchant', () => {
    expect(parseAlert('Chase: A $24.31 transaction was posted.').merchant).toBeNull();
  });
});

describe('parseAlert — the date', () => {
  it('reads a two-digit year as this century', () => {
    expect(parseAlert('BofA: $1.00 at X on 01/02/26').date).toBe('2026-01-02');
  });

  it('leaves a year-less date to the caller rather than guessing', () => {
    // "on Aug 26" with no year: the arrival time is a better answer than a
    // coin flip between this year and last.
    expect(parseAlert('Capital One: A $9.99 transaction at SPOTIFY on Aug 26.').date).toBeNull();
  });
});

describe('parseAlert — robustness', () => {
  it('survives empty and junk input', () => {
    expect(parseAlert('').ok).toBe(false);
    expect(parseAlert(null).ok).toBe(false);
    expect(parseAlert('....').ok).toBe(false);
  });

  it('keeps the raw text so a person can always read what arrived', () => {
    const got = parseAlert('  Chase:   A $5.00   purchase at X  ');
    expect(got.raw).toBe('Chase: A $5.00 purchase at X');
  });
});

/* The two wordings actually arriving on this phone, kept verbatim.
 *
 * The published formats above are what issuers document; these are what Chase
 * really sends, and they differ in a way that mattered — the sender is the
 * card, not the bank, and there is no last four anywhere in the message. */
describe('parseAlert — the alerts this account really gets', () => {
  it('reads a Prime Visa alert', () => {
    const got = parseAlert(
      'Prime Visa: You made a $108.82 transaction with AMAZON MKTPLACE PMTS on Aug 27, 2026 at 2:10 PM ET.',
    );
    expect(got).toMatchObject({
      ok: true,
      amount: 108.82,
      merchant: 'AMAZON MKTPLACE PMTS',
      date: '2026-08-27',
      bank: 'Prime Visa',
      refund: false,
    });
  });

  it('keeps a card name too long for a bank name', () => {
    // "Chase Sapphire Reserve Visa" is 27 characters and used to fall off the
    // end of the sender pattern, taking the only clue about which card it was.
    const got = parseAlert(
      'Chase Sapphire Reserve Visa: You made a $108.88 transaction with Hubspot Inc. on Aug 24, 2026 at 7:13 PM ET.',
    );
    expect(got).toMatchObject({
      ok: true,
      amount: 108.88,
      merchant: 'Hubspot Inc',
      date: '2026-08-24',
      bank: 'Chase Sapphire Reserve Visa',
    });
  });

  it('is not fooled by the trailing "at 2:10 PM" into calling that the merchant', () => {
    const got = parseAlert(
      'Prime Visa: You made a $9.99 transaction with SPOTIFY on Aug 27, 2026 at 2:10 PM ET.',
    );
    expect(got.merchant).toBe('SPOTIFY');
  });
});
