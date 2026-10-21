import { describe, it, expect } from 'vitest';
import {
  parseMoney, parseRate, yearForMonth, payMonthOf, parseCommissionRows, earnedByMonth, payouts, payoutFor, paychecksIn,
} from './commissions.js';

const d = s => { const [y, m, day] = s.split('-').map(Number); return new Date(y, m - 1, day); };
const today = d('2026-10-21');

describe('parsing cells', () => {
  it('reads the money the sheet pastes', () => {
    expect(parseMoney('$2,266.00 ')).toBe(2266);
    expect(parseMoney('-')).toBe(null);
    expect(parseMoney('')).toBe(null);
    expect(parseMoney('(12.50)')).toBe(-12.5);
    expect(parseRate('13.60%')).toBeCloseTo(0.136);
  });
});

describe('yearForMonth', () => {
  it('puts a month inside the row’s window', () => {
    // July 2025 → June 2026: July–Dec are 2025, Jan–June 2026.
    expect(yearForMonth(6, d('2025-07-01'), d('2026-06-30'), today)).toBe(2025);
    expect(yearForMonth(2, d('2025-07-01'), d('2026-06-30'), today)).toBe(2026);
  });

  it('takes the later year when the window covers a month twice', () => {
    expect(yearForMonth(3, d('2023-03-01'), d('2024-06-30'), today)).toBe(2024);
  });

  it('puts a month the window only covers once in that year', () => {
    expect(yearForMonth(8, d('2023-03-01'), d('2024-06-30'), today)).toBe(2023);
  });

  it('puts a month outside the window in the year nearest it', () => {
    // Window Jan–Apr 2026, an August value: August 2026 is 4 months past it,
    // August 2025 is 5 before it.
    expect(yearForMonth(7, d('2026-01-01'), d('2026-04-30'), today)).toBe(2026);
  });

  it('with no dates, uses the latest month that is not in the future', () => {
    expect(yearForMonth(8, null, null, today)).toBe(2026);
    expect(yearForMonth(11, null, null, today)).toBe(2025);
  });
});

describe('payouts', () => {
  const rows = [
    { id: 'a', 'Account Name': 'Griffis', 'Project Name': 'Benchmarking', '%': '13.60%', 'Comm Start Date': '7/1/2025', 'Comm End Date': '6/30/2026', August: '$100.00', September: '-', March: '$50.00' },
    { id: 'b', 'Account Name': 'Acme', 'Project Name': 'Audit', 'Comm Start Date': '1/1/2026', 'Comm End Date': '12/31/2026', September: '$1,000.00 ' },
  ];
  const parsed = parseCommissionRows(rows, today);

  it('dates each month and totals the row', () => {
    expect(parsed[0].months).toEqual({ '2025-08': 100, '2026-03': 50 });
    expect(parsed[0].total).toBe(150);
    expect(parsed[0].lastPaid).toBe('2026-03');
    expect(parsed[0].active).toBe(false);
    expect(parsed[1].active).toBe(true);
  });

  it('is paid in the next month-end paycheck', () => {
    expect(payMonthOf('2026-09')).toBe('2026-10');
    expect(payMonthOf('2026-12')).toBe('2027-01');
    const list = payouts(parsed);
    expect(list.map(p => [p.earnedMonth, p.payDate, p.amount])).toEqual([
      ['2025-08', '2025-09-30', 100],
      ['2026-03', '2026-04-30', 50],
      ['2026-09', '2026-10-31', 1000],
    ]);
    expect(payoutFor(list, '2026-10').rows[0]).toMatchObject({ account: 'Acme', amount: 1000 });
    expect(earnedByMonth(parsed)['2026-09']).toBe(1000);
  });
});

describe('paychecksIn', () => {
  it('finds the mid-month and month-end payroll deposits', () => {
    const txns = [
      { date: '10/15/2026', description: 'Summit Energy Se Des:payroll, ID:1', amount: 2663.83 },
      { date: '10/30/2026', description: 'Summit Energy Se Des:payroll, ID:2', amount: 3922.07 },
      { date: '10/25/2026', description: 'Zelle payment from Joo', amount: 2200 },
      { date: '09/30/2026', description: 'Summit Energy Se Des:payroll, ID:3', amount: 4000 },
    ];
    const p = paychecksIn(txns, '2026-10');
    expect(p.midMonth.amount).toBe(2663.83);
    expect(p.monthEnd.amount).toBe(3922.07);
    expect(paychecksIn(txns, '2026-11')).toEqual({ midMonth: null, monthEnd: null });
  });
});
