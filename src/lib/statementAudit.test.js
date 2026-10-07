import { describe, it, expect } from 'vitest';
import {
  parseMoney, parseDate, splitCsv, parseStatementCsv, parseStatementText,
  checkAgainstSummary, similarity, auditStatement, periodOfLines, accountForLast4,
} from './statementAudit.js';

const d = (y, m, day) => new Date(y, m - 1, day);

describe('parseMoney', () => {
  it('reads every way an issuer prints a sign', () => {
    expect(parseMoney('$1,234.56')).toBe(1234.56);
    expect(parseMoney('-1,234.56')).toBe(-1234.56);
    expect(parseMoney('(12.00)')).toBe(-12);
    expect(parseMoney('12.00-')).toBe(-12);
    expect(parseMoney('12.00 CR')).toBe(-12);
    expect(parseMoney('+$5.00')).toBe(5);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('n/a')).toBeNull();
  });
});

describe('parseDate', () => {
  it('reads slashed and ISO dates as local calendar days', () => {
    expect(parseDate('09/03/2026')).toEqual(d(2026, 9, 3));
    expect(parseDate('9/3/26')).toEqual(d(2026, 9, 3));
    expect(parseDate('2026-09-03')).toEqual(d(2026, 9, 3));
  });
  it('needs a year from somewhere', () => {
    expect(parseDate('09/03')).toBeNull();
    expect(parseDate('09/03', () => 2025)).toEqual(d(2025, 9, 3));
  });
});

describe('splitCsv', () => {
  it('handles quotes, embedded commas and CRLF', () => {
    expect(splitCsv('a,"b, c","d ""e"""\r\n1,2,3\r\n')).toEqual([['a', 'b, c', 'd "e"'], ['1', '2', '3']]);
  });
  it('drops a byte-order mark so the first header still matches', () => {
    expect(splitCsv('﻿Date,Amount')[0][0]).toBe('Date');
  });
});

describe('parseStatementCsv', () => {
  it('reads a Chase export, which already signs charges negative', () => {
    const csv = [
      'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
      '09/03/2026,09/04/2026,AMAZON MKTPL*AB12,Shopping,Sale,-45.67,',
      '09/15/2026,09/15/2026,Payment Thank You-Mobile,,Payment,1234.56,',
      '09/20/2026,09/21/2026,"STARBUCKS, INC",Food & Drink,Sale,-6.25,',
    ].join('\n');
    const { lines, warnings } = parseStatementCsv(csv);
    expect(warnings).toEqual([]);
    expect(lines).toEqual([
      { date: d(2026, 9, 3), description: 'AMAZON MKTPL*AB12', amount: -45.67 },
      { date: d(2026, 9, 15), description: 'Payment Thank You-Mobile', amount: 1234.56 },
      { date: d(2026, 9, 20), description: 'STARBUCKS, INC', amount: -6.25 },
    ]);
  });

  it('flips an export that prints charges positive', () => {
    const csv = 'Date,Description,Amount\n09/03/2026,UBER,12.00\n09/04/2026,LYFT,8.50\n09/10/2026,PAYMENT,-20.50\n';
    expect(parseStatementCsv(csv).lines.map(l => l.amount)).toEqual([-12, -8.5, 20.5]);
  });

  it('reads Debit/Credit columns and skips preamble rows', () => {
    const csv = 'Account ending 1947\n\nStatus,Date,Description,Debit,Credit\nCleared,09/03/2026,UBER,12.00,\nCleared,09/10/2026,PAYMENT,,20.00\n';
    expect(parseStatementCsv(csv).lines.map(l => l.amount)).toEqual([-12, 20]);
  });

  it('says so when it cannot find a header', () => {
    expect(parseStatementCsv('hello,world\n1,2').warnings).toHaveLength(1);
  });
});

// The shape pdf.js gives back for a Chase statement, one printed line per line.
const CHASE_TEXT = `
Manage your account online at: www.chase.com/cardhelp
Opening/Closing Date 08/27/26 - 09/26/26
Account Number: XXXX XXXX XXXX 1947
ACCOUNT SUMMARY
Previous Balance $1,234.56
Payment, Credits -$1,250.56
Purchases +$84.67
Cash Advances $0.00
Fees Charged +$0.00
Interest Charged +$0.00
New Balance $68.67
ACCOUNT ACTIVITY
Date of Transaction Merchant Name or Transaction Description $ Amount
PAYMENTS AND OTHER CREDITS
09/15 Payment Thank You-Mobile -1,234.56
09/18 AMAZON RETURN -16.00
PURCHASE
08/29 TRADER JOE S #123 NEW YORK NY 32.42
09/03 AMAZON MKTPL*AB12CD3 Amzn.com/bill WA 45.67
09/20 STARBUCKS STORE 1234 NEW YORK NY 6.58
Totals Year-to-Date
`;

describe('parseStatementText', () => {
  const parsed = parseStatementText(CHASE_TEXT);

  it('reads the period and the card', () => {
    expect(parsed.period).toEqual({ start: d(2026, 8, 27), end: d(2026, 9, 26) });
    expect(parsed.last4).toBe('1947');
  });

  it('reads the activity table in ledger sign', () => {
    expect(parsed.lines).toEqual([
      { date: d(2026, 9, 15), description: 'Payment Thank You-Mobile', amount: 1234.56 },
      { date: d(2026, 9, 18), description: 'AMAZON RETURN', amount: 16 },
      { date: d(2026, 8, 29), description: 'TRADER JOE S #123 NEW YORK NY', amount: -32.42 },
      { date: d(2026, 9, 3), description: 'AMAZON MKTPL*AB12CD3 Amzn.com/bill WA', amount: -45.67 },
      { date: d(2026, 9, 20), description: 'STARBUCKS STORE 1234 NEW YORK NY', amount: -6.58 },
    ]);
  });

  it('checks the lines against the totals the issuer printed', () => {
    expect(parsed.summary).toEqual({ purchases: 84.67, credits: 1250.56, fees: 0, interest: 0 });
    expect(checkAgainstSummary(parsed.lines, parsed.summary).ok).toBe(true);
    expect(checkAgainstSummary(parsed.lines.slice(1), parsed.summary).ok).toBe(false);
  });

  it('puts December lines on the previous year when the period closes in January', () => {
    const p = parseStatementText('Opening/Closing Date 12/20/26 - 01/19/27\n12/28 DINNER 40.00\n01/05 LUNCH 10.00');
    expect(p.lines.map(l => l.date)).toEqual([d(2026, 12, 28), d(2027, 1, 5)]);
  });

  it('reads a trailing CR as a credit and drops a reference number', () => {
    const p = parseStatementText('Billing period 09/01/2026 to 09/30/2026\n09/04 09/05 REFUND SHOP 74839201 25.00 CR');
    expect(p.lines).toEqual([{ date: d(2026, 9, 4), description: 'REFUND SHOP', amount: 25 }]);
  });

  it('warns on a PDF with no readable activity', () => {
    expect(parseStatementText('').warnings).toHaveLength(1);
  });
});

describe('similarity', () => {
  it('scores shared merchant words', () => {
    expect(similarity('STARBUCKS STORE 1234 NEW YORK NY', 'Starbucks')).toBe(1);
    expect(similarity('TRADER JOE S #123', 'Uber')).toBe(0);
  });
});

describe('auditStatement', () => {
  const period = { start: d(2026, 8, 27), end: d(2026, 9, 26) };
  const ledger = [
    { transactionId: 'a', date: '9/3/2026', description: 'Amazon', amount: -45.67 },
    { transactionId: 'b', date: '8/28/2026', description: "Trader Joe's", amount: -32.42 }, // a day off
    { transactionId: 'c', date: '9/20/2026', description: 'Starbucks', amount: -5.98 },      // tip added later
    { transactionId: 'd', date: '9/15/2026', description: 'Payment Thank You', amount: 1234.56, category: 'Credit Card Payment' },
    { transactionId: 'e', date: '9/22/2026', description: 'Netflix', amount: -15.49 },       // never billed
    { transactionId: 'f', date: '8/10/2026', description: 'Old', amount: -99 },              // previous cycle
    { transactionId: 'g', date: '9/28/2026', description: 'Next', amount: -7 },              // next cycle
  ];
  const r = auditStatement({ statementLines: parseStatementText(CHASE_TEXT).lines, transactions: ledger, period });

  it('matches by cents within the posting lag', () => {
    expect(r.matched.map(m => m.ledger.transactionId)).toEqual(['b', 'a', 'd']);
    expect(r.matched[0].dayGap).toBe(1);
  });

  it('reports a same-merchant charge for a different amount once, as a difference', () => {
    expect(r.differs).toHaveLength(1);
    expect(r.differs[0].ledger.transactionId).toBe('c');
    expect(r.differs[0].delta).toBe(-0.6);
  });

  it('splits the rest into billed-not-tracked and tracked-not-billed', () => {
    expect(r.missing.map(s => s.description)).toEqual(['AMAZON RETURN']);
    expect(r.unexpected.map(t => t.transactionId)).toEqual(['e']);
  });

  it('totals both sides over the period', () => {
    expect(r.totals.statement).toBe(1165.89);
    expect(r.totals.expected).toBe(1135.0);
    expect(r.totals.difference).toBe(30.89);
  });

  it('pairs duplicate amounts by nearest date', () => {
    const lines = [
      { date: d(2026, 9, 1), description: 'SPOTIFY', amount: -10 },
      { date: d(2026, 9, 8), description: 'SPOTIFY', amount: -10 },
    ];
    const txns = [
      { transactionId: 'late', date: '9/9/2026', description: 'Spotify', amount: -10 },
      { transactionId: 'early', date: '9/2/2026', description: 'Spotify', amount: -10 },
    ];
    const out = auditStatement({ statementLines: lines, transactions: txns, period });
    expect(out.matched.map(m => m.ledger.transactionId)).toEqual(['early', 'late']);
  });
});

describe('helpers', () => {
  it('derives a period from the lines', () => {
    expect(periodOfLines([{ date: d(2026, 9, 5) }, { date: d(2026, 9, 1) }])).toEqual({ start: d(2026, 9, 1), end: d(2026, 9, 5) });
    expect(periodOfLines([])).toBeNull();
  });
  it('finds the account by last four', () => {
    const accts = ['CREDIT CARD (-0664)', 'CREDIT CARD (-1947)', 'Cash Rewards'];
    expect(accountForLast4('1947', accts)).toBe('CREDIT CARD (-1947)');
    expect(accountForLast4('1551', accts, { 'Cash Rewards': 'xxxx1551' })).toBe('Cash Rewards');
    expect(accountForLast4('9999', accts)).toBeNull();
  });
});
