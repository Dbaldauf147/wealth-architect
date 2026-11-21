import { describe, it, expect } from 'vitest';
import {
  parseHsaPaste, parseHsaDate, parseHsaMoney, classifyHsa, mergeHsaRows, summarizeHsa, hsaLimit, hsaYears, hsaAlerts, pastFullMonths,
} from './hsa';

describe('parseHsaDate / parseHsaMoney', () => {
  it('reads the usual date shapes', () => {
    expect(parseHsaDate('03/05/2026')).toBe('2026-03-05');
    expect(parseHsaDate('3/5/26')).toBe('2026-03-05');
    expect(parseHsaDate('2026-3-5')).toBe('2026-03-05');
    expect(parseHsaDate('Mar 5, 2026')).toBe('2026-03-05');
    expect(parseHsaDate('Pending')).toBe(null);
  });
  it('reads signed money', () => {
    expect(parseHsaMoney('$1,234.56')).toBe(1234.56);
    expect(parseHsaMoney('-$20.00')).toBe(-20);
    expect(parseHsaMoney('($20.00)')).toBe(-20);
    expect(parseHsaMoney('')).toBe(null);
  });
});

describe('classifyHsa', () => {
  it('sorts by words before sign', () => {
    expect(classifyHsa('Employer Contribution', 50)).toBe('contribution');
    expect(classifyHsa('Payroll Contribution', 150)).toBe('contribution');
    expect(classifyHsa('Card Purchase - CVS PHARMACY', -12.5)).toBe('spending');
    expect(classifyHsa('Interest', 0.42)).toBe('other');
    expect(classifyHsa('Transfer to investment account', -1000)).toBe('other');
    expect(classifyHsa('Monthly fee', -2.5)).toBe('other');
    expect(classifyHsa('Some merchant', -40)).toBe('spending');
    expect(classifyHsa('Something in', 40)).toBe('contribution');
  });
});

describe('parseHsaPaste', () => {
  it('reads a signed Amount column with a header (tab-separated)', () => {
    const text = [
      'Date\tTransaction\tAmount\tCash Balance',
      '01/15/2026\tPayroll Contribution\t$150.00\t$1,150.00',
      '01/20/2026\tCard Purchase - CVS\t($32.10)\t$1,117.90',
      '01/31/2026\tInterest\t$0.42\t$1,118.32',
    ].join('\n');
    const { rows, skipped } = parseHsaPaste(text);
    expect(skipped).toBe(0);
    expect(rows.map(r => [r.date, r.amount, r.kind])).toEqual([
      ['2026-01-15', 150, 'contribution'],
      ['2026-01-20', -32.1, 'spending'],
      ['2026-01-31', 0.42, 'other'],
    ]);
  });

  it('reads separate Withdrawal/Deposit columns (CSV with quotes)', () => {
    const text = [
      'Date,Description,Type,Withdrawals,Deposits,Balance',
      '"02/01/2026","Dr Smith, DDS",Payment,"$200.00",,"$800.00"',
      '"02/15/2026","Employer",Contribution,,"$75.00","$875.00"',
    ].join('\n');
    const { rows } = parseHsaPaste(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: '2026-02-01', amount: -200, kind: 'spending', description: 'Payment — Dr Smith, DDS' });
    expect(rows[1]).toMatchObject({ amount: 75, kind: 'contribution' });
  });

  it('falls back to free text rows without a header', () => {
    const text = '03/01/2026  Walgreens  -$15.00  $500.00\n03/02/2026 Contribution $100.00 $600.00';
    const { rows } = parseHsaPaste(text.replace(/ {2}/g, '\t'));
    expect(rows.map(r => [r.amount, r.kind])).toEqual([[-15, 'spending'], [100, 'contribution']]);
  });

  it('gives identical rows on one day distinct ids, stable across pastes', () => {
    const text = 'Date\tDescription\tAmount\n04/01/2026\tCopay\t-$20.00\n04/01/2026\tCopay\t-$20.00';
    const a = parseHsaPaste(text).rows;
    const b = parseHsaPaste(text).rows;
    expect(new Set(a.map(r => r.id)).size).toBe(2);
    expect(a.map(r => r.id)).toEqual(b.map(r => r.id));
  });
});

describe('mergeHsaRows', () => {
  it('skips rows already stored and keeps their kind', () => {
    const first = parseHsaPaste('Date\tDescription\tAmount\n01/01/2026\tX\t$10.00').rows;
    const relabelled = [{ ...first[0], kind: 'other' }];
    const again = parseHsaPaste('Date\tDescription\tAmount\n01/01/2026\tX\t$10.00\n01/02/2026\tY\t-$5.00').rows;
    const { rows, added, duplicates } = mergeHsaRows(relabelled, again);
    expect(added).toBe(1);
    expect(duplicates).toBe(1);
    expect(rows[0].date).toBe('2026-01-02');
    expect(rows.find(r => r.date === '2026-01-01').kind).toBe('other');
  });
});

describe('summarizeHsa', () => {
  it('totals one year by kind and month', () => {
    const rows = [
      { id: 'a', date: '2026-01-15', amount: 150, kind: 'contribution' },
      { id: 'b', date: '2026-01-20', amount: -30, kind: 'spending' },
      { id: 'c', date: '2026-02-01', amount: 1, kind: 'other' },
      { id: 'd', date: '2025-12-31', amount: 999, kind: 'contribution' },
    ];
    const s = summarizeHsa(rows, 2026);
    expect(s).toMatchObject({ contributions: 150, spending: 30, other: 1, net: 121 });
    expect(s.months[0]).toMatchObject({ contributions: 150, spending: 30 });
    expect(hsaYears(rows)).toEqual([2026, 2025]);
  });
});

describe('hsaLimit', () => {
  it('uses the year, coverage and catch-up', () => {
    expect(hsaLimit(2026, 'self')).toBe(4400);
    expect(hsaLimit(2026, 'family', true)).toBe(9750);
    expect(hsaLimit(2030, 'self')).toBe(4400); // latest known
  });
});

describe('hsaAlerts', () => {
  const today = new Date(2026, 10, 21); // Nov 21 2026
  const row = (date) => ({ id: date, date, amount: 10, kind: 'contribution' });

  it('looks at the two full months before this one', () => {
    expect(pastFullMonths(today).map(m => m.key)).toEqual(['2026-09', '2026-10']);
    expect(pastFullMonths(new Date(2026, 0, 5)).map(m => m.key)).toEqual(['2025-11', '2025-12']);
  });
  it('is quiet when both months have rows', () => {
    expect(hsaAlerts([row('2026-09-15'), row('2026-10-15')], today)).toEqual([]);
  });
  it('alerts when either month is empty, naming it', () => {
    const [a] = hsaAlerts([row('2026-09-15'), row('2026-11-02')], today);
    expect(a.title).toBe('HSA data missing for October 2026');
    expect(a.missing).toEqual(['2026-10']);
    expect(a.detail).toContain('2026-11-02');
  });
  it('alerts with both months when there is no data at all', () => {
    const [a] = hsaAlerts([], today);
    expect(a.title).toBe('HSA data missing for September 2026 and October 2026');
    expect(a.detail).toMatch(/No HSA activity/);
  });
});
