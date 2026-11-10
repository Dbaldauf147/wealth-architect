import { describe, it, expect } from 'vitest';
import { baseSalary, paySchedule, commissionRows, chartPoints, rawSheetRows, chartSheetRows, addMonths, expectedVsActual, expectedVsActualTotals, expectedVsActualSheetRows, payByMonth, payByMonthSheetRows, payByMonthPaycheckRows, dealHistory, dealHistorySheetRows, paymentsText, gapReasonSheetRows } from './commissionSchedule.js';

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

describe('expectedVsActual', () => {
  const rows = commissionRows(commissions, today);
  // splitPaychecks-shaped: month-end deposit = base 3000 + commission carried.
  const split = [
    { date: new Date(2026, 9, 15), amount: 3000, base: 3000, commission: 0 },
    { date: new Date(2026, 9, 30), amount: 3480, base: 3000, commission: 480 },   // Oct: Sep's 1000 expected → 500
    { date: new Date(2026, 8, 30), amount: 3240, base: 3000, commission: 240 },   // Sep: Aug's 500 expected → 250
  ];
  const pts = expectedVsActual({ rows, paychecks: split, takeHome: 0.5, range: 'around', today });
  const at = k => pts.find(p => p.payMonth === k);

  it('pairs each month-end paycheck with what the tracker expected', () => {
    expect(at('2026-10')).toMatchObject({ expectedPreTax: 1000, expectedTakeHome: 500, diff: -20, actual: { deposit: 3480, base: 3000, commission: 480 } });
    expect(at('2026-09')).toMatchObject({ expectedTakeHome: 250, diff: -10 });
  });
  it('has no actual for paychecks still to come', () => {
    expect(at('2026-11')).toMatchObject({ expectedPreTax: 1200, actual: null, diff: null });
  });
  it('totals only the months with both sides', () => {
    expect(expectedVsActualTotals(pts)).toEqual({ months: 2, expected: 750, actual: 720, diff: -30 });
  });
  it('exports one row per month', () => {
    const sheet = expectedVsActualSheetRows(pts);
    expect(sheet).toHaveLength(pts.length + 1);
    const oct = sheet.find(r => r[1] === '2026-10');
    expect([oct[4].v, oct[5].v, oct[7].v, oct[8].v]).toEqual([500, 3480, 480, -20]);
    expect(sheet.find(r => r[1] === '2026-12')[5]).toBe('not paid yet');
  });
});

describe('payByMonth', () => {
  const rows = commissionRows(commissions, today);
  const base = { amount: 3000, day: 15 };
  const split = [
    { date: new Date(2026, 9, 15), amount: 3000, base: 3000, commission: 0 },
    { date: new Date(2026, 9, 30), amount: 3480, base: 3000, commission: 480 },
  ];
  const pts = payByMonth({ rows, paychecks: split, base, takeHome: 0.5, range: 'around', today });
  const at = k => pts.find(p => p.payMonth === k);

  it('uses what landed for a past month', () => {
    expect(at('2026-10')).toMatchObject({ base: { actual: 6000, expected: 0 }, commission: { actual: 480, expected: 0 }, total: 6480 });
  });
  it('expects two paychecks and the tracker commission for a future month', () => {
    // November: the 13th and the 30th are both still ahead of Nov 8; October's 1200 at 50%.
    expect(at('2026-11')).toMatchObject({ base: { actual: 0, expected: 6000 }, commission: { actual: 0, expected: 600 }, total: 6600, expectedSlots: 2 });
    expect(at('2026-11').commissionShare).toBeCloseTo(0.09, 2);
  });
  it('mixes received and expected inside the current month', () => {
    const mid = [...split, { date: new Date(2026, 10, 13), amount: 3000, base: 3000, commission: 0 }];
    const nov = payByMonth({ rows, paychecks: mid, base, takeHome: 0.5, range: 'ahead', today: new Date(2026, 10, 16) }).find(p => p.payMonth === '2026-11');
    expect(nov).toMatchObject({ base: { actual: 3000, expected: 3000 }, commission: { expected: 600 }, expectedSlots: 1 });
  });
  it('exports a month row and each paycheck', () => {
    expect(payByMonthSheetRows(pts)).toHaveLength(pts.length + 1);
    const pay = payByMonthPaycheckRows([at('2026-10'), at('2026-11')]);
    expect(pay.slice(1).map(r => `${r[0]} ${r[2]} ${r[3]}`)).toEqual([
      '2026-10 Mid-month Received', '2026-10 Month-end Received', '2026-11 Mid-month Expected', '2026-11 Month-end Expected',
    ]);
    expect(pay[4][5].v).toBe(600);
    expect(pay[4][7]).toBe('');
    // October's month-end: expected 3000 + 1000 × 50%, landed 3480.
    expect(pay[2][6].v).toBe(3500);
    expect(pay[2][10].v).toBe(-20);
  });
  it('splits each month into its two paychecks, expected beside actual', () => {
    const oct = at('2026-10');
    expect(oct.slots.map(s => s.id)).toEqual(['2026-10-mid', '2026-10-end']);
    expect(oct.slots[0]).toMatchObject({ kind: 'mid', status: 'received', expected: { base: 3000, commission: 0 }, actual: { base: 3000, commission: 0 }, diff: 0 });
    // Earned September (1000 pre-tax) at 50%.
    expect(oct.slots[1]).toMatchObject({ kind: 'end', status: 'received', expected: { base: 3000, commission: 500 }, actual: { deposit: 3480, commission: 480 }, diff: -20 });
    expect(oct.planned).toEqual({ base: 6000, commission: 500 });
    const nov = at('2026-11');
    expect(nov.slots.map(s => s.status)).toEqual(['expected', 'expected']);
    expect(nov.slots[1]).toMatchObject({ expected: { base: 3000, commission: 600 }, actual: null, diff: null });
  });
  it('leaves paydays before the paycheck history without an expected side', () => {
    const jul = at('2026-07');
    expect(jul.slots.map(s => s.status)).toEqual(['no-data', 'no-data']);
    expect(jul.planned).toBeNull();
  });
});

describe('dealHistory', () => {
  const rows = commissionRows(commissions, today);
  const h = dealHistory({ rows, deals: [{ account: 'Acme', project: 'HVAC' }, { account: 'Acme', project: 'HVAC' }], takeHome: 0.5, from: '2026-07', months: 12, today });
  const at = k => h.points.find(p => p.payMonth === k);

  it('covers the asked months for just the deals given', () => {
    expect(h.points).toHaveLength(12);
    expect(h.points[0].payMonth).toBe('2026-07');
    expect(h.deals).toHaveLength(1);
    // Beta's August money isn't one of these deals.
    expect(at('2026-09').amount).toBe(0);
  });
  it('splits past from projected and keeps the status', () => {
    expect(at('2026-10')).toMatchObject({ amount: 1000, takeHome: 500, status: 'paid' });
    expect(h.taxRate).toBe(0.5);
    expect(at('2026-12').status).toBe('projected');
    const d = h.deals[0];
    expect(d.past).toBe(1000 + (at('2026-11').status === 'projected' ? 0 : at('2026-11').amount));
    expect(round(d.past + d.ahead)).toBe(d.total);
    expect(d.total).toBe(h.total);
  });
  it('exports a row per month with a column per deal', () => {
    const sheet = dealHistorySheetRows(h);
    // Header, 12 months, a total row and a payments row.
    expect(sheet).toHaveLength(15);
    expect(sheet[0].map(c => c.v)).toEqual(['Pay month', 'Acme · HVAC', 'Total (pre-tax)', 'Est. take-home', 'Status', 'Expected tax rate']);
    // The tax rate is the last column: on months with a payment, and the total.
    const oct = sheet.find(r => r[0] === '2026-10');
    expect(oct.at(-1)).toEqual({ v: 0.5, s: 'pct' });
    expect(sheet.find(r => r[0] === '2026-09').at(-1)).toBe('');
    expect(sheet[13].at(-1)).toEqual({ v: 0.5, s: 'pct' });
    expect(sheet[14][0]).toBe('Payments');
    expect(sheet[14][1]).toBe(paymentsText(h.deals[0]));
  });
  it('counts the payments from each deal', () => {
    const d = h.deals[0];
    expect(d.payments.total).toBe(h.points.filter(p => p.byDeal[d.key]).length);
    expect(d.payments.paid + d.payments.recorded + d.payments.projected).toBe(d.payments.total);
    expect(d.payments.paid).toBe(1); // October's, for September
    expect(h.payments).toBe(d.payments.total);
    expect(paymentsText({ payments: { total: 5, paid: 2, recorded: 1, projected: 2 } })).toBe('5 (2 paid, 1 recorded, 2 projected)');
  });
});
const round = n => Math.round(n * 100) / 100;

describe('why a paycheck missed its expected amount', () => {
  const base = { amount: 3000, day: 15 };
  const row = (payMonth, account, amount) => ({ payMonth, earnedMonth: addMonths(payMonth, -1), account, project: 'P', amount, status: 'paid' });
  const mid = (m) => ({ date: new Date(2026, m - 1, 15), amount: 3000, base: 3000, commission: 0 });
  const end = (m, d, commission, b = 3000) => ({ date: new Date(2026, m - 1, d), amount: b + commission, base: b, commission });
  const run = (rows, paychecks) => payByMonth({ rows, paychecks, base, takeHome: 0.5, range: 'all', today: new Date(2026, 10, 20) });

  it('points at the deal whose payment matches a shortfall', () => {
    const [oct] = run([row('2026-10', 'Alpha', 1000), row('2026-10', 'Beta', 400)], [mid(10), end(10, 30, 500)]);
    // Expected 700 take-home, got 500: Beta's 400 at 50%.
    expect(oct.slots[1].why[0]).toMatch(/Beta · P's \$400\.00 pre-tax/);
    expect(oct.slots[0].why).toEqual(['Matches the usual base salary.']);
  });
  it('calls a gap that reverses next month timing', () => {
    const [sep, oct] = run([row('2026-09', 'Alpha', 1000), row('2026-10', 'Alpha', 1000)],
      [mid(9), end(9, 30, 300), mid(10), end(10, 30, 700)]);
    expect(sep.slots[1].why[0]).toMatch(/next month-end paycheck came in \+\$200\.00/);
    expect(oct.slots[1].why[0]).toMatch(/previous month-end paycheck was −\$200\.00.*a month late/);
  });
  it('falls back to the take-home rate the paycheck implies', () => {
    const [oct] = run([row('2026-10', 'Alpha', 1000)], [mid(10), end(10, 30, 400)]);
    expect(oct.slots[1].why).toHaveLength(1);
    expect(oct.slots[1].why[0]).toMatch(/took home 40% of \$1,000\.00 pre-tax against the 50% assumed/);
  });
  it('finds two payments that together make up the shortfall', () => {
    const [oct] = run([row('2026-10', 'Alpha', 1000), row('2026-10', 'Beta', 600), row('2026-10', 'Gamma', 300)], [mid(10), end(10, 30, 500)]);
    // Expected 950, got 500: Beta + Gamma = 900 pre-tax = 450 take-home.
    expect(oct.slots[1].why[0]).toMatch(/close to Beta · P \(\$600\.00\) \+ Gamma · P \(\$300\.00\)/);
  });
  it('says a rate far from normal is not just withholding', () => {
    const [oct] = run([row('2026-10', 'Alpha', 1000), row('2026-10', 'Beta', 700)], [mid(10), end(10, 30, 200)]);
    expect(oct.slots[1].why.at(-1)).toMatch(/too far below normal for tax withholding alone/);
  });
  it('notes a changed base, a missing deposit and a near-match', () => {
    const [sep, oct] = run([row('2026-09', 'Alpha', 1000), row('2026-10', 'Alpha', 1000)],
      [mid(9), mid(10), end(10, 30, 490, 2900)]);
    expect(sep.slots[1].status).toBe('missed');
    expect(sep.slots[1].why[0]).toMatch(/No month-end deposit was found for September 2026/);
    expect(oct.slots[1].why[0]).toMatch(/base portion was \$2,900\.00 against the usual \$3,000\.00/);
    expect(oct.slots[1].why[1]).toMatch(/within \$10\.00 of expected/);
    const sheet = gapReasonSheetRows([sep, oct]);
    expect(sheet[0].map(c => c.v)).toEqual(['Pay month', 'Date', 'Paycheck', 'Expected', 'Actual', 'Gap', 'Why']);
    expect(sheet.find(r => r[0] === '2026-10' && r[2] === 'Month-end')[6].v).toMatch(/base portion/);
  });
});
