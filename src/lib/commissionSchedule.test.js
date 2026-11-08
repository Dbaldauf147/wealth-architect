import { describe, it, expect } from 'vitest';
import { baseSalary, paySchedule, commissionRows, chartPoints, rawSheetRows, chartSheetRows, addMonths } from './commissionSchedule.js';

const today = new Date(2026, 10, 8); // Sun Nov 8, 2026
const pc = (y, m, d, amount) => ({ date: new Date(y, m - 1, d), amount });
// Mid-month base 3000; month-end base + commission.
const paychecks = [
  pc(2026, 8, 15, 3000), pc(2026, 8, 31, 4200),
  pc(2026, 9, 15, 3000), pc(2026, 9, 30, 4000),
  pc(2026, 10, 15, 3010), pc(2026, 10, 30, 4500),
];

const commissions = [
  // Recurring: recorded through Oct, runs to Mar 2027 → projected Nov..Mar.
  { account: 'Acme', project: 'HVAC', end: '2027-03-31', lastPaid: '2026-10', months: { '2026-09': 1000, '2026-10': 1200 } },
  // Ended.
  { account: 'Beta', project: 'Solar', end: '2026-08-31', lastPaid: '2026-08', months: { '2026-08': 500 } },
];

describe('baseSalary', () => {
  it('is the median of the last three mid-month paychecks', () => {
    const b = baseSalary(paychecks, today);
    expect(b.amount).toBe(3000);
    expect(b.day).toBe(15);
    expect(b.perYear).toBe(72000);
    expect(b.history[0].amount).toBe(3010);
    expect(b.stale).toBe(false);
  });
  it('is null without mid-month pay', () => {
    expect(baseSalary([pc(2026, 10, 30, 4000)], today)).toBeNull();
  });
});

describe('paySchedule', () => {
  const base = baseSalary(paychecks, today);
  const expected = [{ payMonth: '2026-11', payDate: '2026-11-30', earnedMonth: '2026-10', amount: 1200, projected: false, rows: [] },
    { payMonth: '2026-12', payDate: '2026-12-31', earnedMonth: '2026-11', amount: 1200, projected: true, rows: [] }];
  const s = paySchedule({ base, paychecks, expected, takeHome: 0.5, today, months: 2 });

  it('lists every payday twice a month, mid-month first', () => {
    // Nov 15 is a Sunday, so the mid-month paycheck moves to Fri the 13th.
    expect(s.map(p => `${p.dateKey} ${p.kind}`)).toEqual(['2026-11-13 mid', '2026-11-30 end', '2026-12-15 mid', '2026-12-31 end']);
  });
  it('adds the month-end commission after tax', () => {
    expect(s[1]).toMatchObject({ base: 3000, commissionPreTax: 1200, commissionTakeHome: 600, total: 3600, projected: false, earnedMonth: '2026-10' });
    expect(s[3]).toMatchObject({ projected: true, total: 3600 });
    expect(s[0]).toMatchObject({ kind: 'mid', total: 3000, commissionPreTax: 0 });
  });
  it('shows what actually landed this month', () => {
    const withLanded = paySchedule({ base, paychecks: [...paychecks, pc(2026, 11, 13, 3000)], expected, takeHome: 0.5, today, months: 1 });
    expect(withLanded[0]).toMatchObject({ kind: 'mid', status: 'received', received: 3000 });
  });
  it('rolls a weekend payday back to Friday', () => {
    const jan = paySchedule({ base, paychecks, expected: [], takeHome: 0.5, today, months: 4 }).find(p => p.dateKey.startsWith('2027-01') && p.kind === 'end');
    expect(jan.dateKey).toBe('2027-01-29'); // Jan 31 2027 is a Sunday
  });
});

describe('commission chart', () => {
  const rows = commissionRows(commissions, today);

  it('labels each row paid, recorded or projected', () => {
    const by = s => rows.filter(r => r.status === s).map(r => `${r.account} ${r.earnedMonth}`).sort();
    expect(by('paid')).toEqual(['Acme 2026-09', 'Beta 2026-08']);
    expect(by('recorded')).toEqual(['Acme 2026-10']);
    expect(by('projected')).toEqual(['Acme 2026-11', 'Acme 2026-12', 'Acme 2027-01', 'Acme 2027-02', 'Acme 2027-03']);
  });

  it('builds one point per pay month across the range, zero-filled', () => {
    const pts = chartPoints({ rows, statuses: new Set(['paid', 'recorded', 'projected']), range: 'around', today });
    expect(pts).toHaveLength(25);
    expect(pts[0].payMonth).toBe(addMonths('2026-11', -12));
    const nov = pts.find(p => p.payMonth === '2026-11');
    expect(nov).toMatchObject({ amount: 1200, byStatus: { paid: 0, recorded: 1200, projected: 0 }, earnedMonth: '2026-10' });
    expect(pts.find(p => p.payMonth === '2026-12').byStatus.projected).toBe(1200);
  });

  it('filters by account and status', () => {
    const pts = chartPoints({ rows, accounts: new Set(['Beta']), statuses: new Set(['paid']), range: 'all', today });
    expect(pts.map(p => [p.payMonth, p.amount])).toEqual([['2026-09', 500]]);
  });

  it('exports raw rows and one row per point', () => {
    const pts = chartPoints({ rows, statuses: new Set(['recorded']), range: 'ahead', today });
    const raw = rawSheetRows(pts, 0.5);
    expect(raw).toHaveLength(2);
    expect(raw[1].slice(0, 6)).toEqual(['2026-11-30', '2026-11', '2026-10', 'Acme', 'HVAC', 'Recorded, not paid yet']);
    expect(raw[1][6].v).toBe(1200);
    expect(raw[1][7].v).toBe(600);
    expect(chartSheetRows(pts, 0.5)).toHaveLength(13);
  });
});

describe('paySchedule past paydays', () => {
  it('drops a payday that went by with no deposit', () => {
    const base = baseSalary(paychecks, today);
    const later = new Date(2026, 10, 20);
    const s = paySchedule({ base, paychecks, expected: [], takeHome: 0.5, today: later, months: 1 });
    expect(s.map(p => p.kind)).toEqual(['end']);
  });
});
