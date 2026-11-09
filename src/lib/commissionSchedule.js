/* The Commissions page's pay picture: base salary, the twice-a-month pay
   schedule, and the commission chart (with what it exports).

   Base salary is the mid-month paycheck: it never carries commission, so it is
   the plain take-home salary. The month-end paycheck is that same base plus
   the previous month's commission, after tax. The paychecks come from
   computeIncome().paychecks (lib/income splitPaychecks), so every page that
   talks about base vs commission splits a deposit the same way.

   Commission amounts are pre-tax, from the Prospect Tracker. Take-home is the
   pre-tax figure at the rate commissionTakeHome() measures from past
   paychecks (lib/income), as on the Income page.

   Pure: no React, no DOM. */

import { payouts, expectedPayouts, monthEnd } from './commissions.js';
import { businessDayOnOrBefore } from './upcomingCash.js';
import { DEFAULT_TAKE_HOME } from './income.js';

const DAY = 86400000;
const round2 = n => Math.round(n * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isMid = p => p.date.getDate() <= 20;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Shift a "YYYY-MM" key by whole months. */
export function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}

/**
 * The base salary: what the mid-month paycheck usually is.
 * @param paychecks  computeIncome().paychecks — [{ date, amount, ... }]
 * @returns null without any mid-month deposit, else
 *   { amount, day, last: { date, amount }, history: [{ date, amount }] (newest first, up to 12),
 *     perYear, stale }
 */
export function baseSalary(paychecks, today = new Date()) {
  const mids = (paychecks || []).filter(isMid).sort((a, b) => a.date - b.date);
  if (!mids.length) return null;
  const recent = mids.slice(-3);
  const amount = round2(median(recent.map(p => p.amount)));
  // The usual day; on a tie the later one (a weekend only ever moves pay earlier).
  const counts = new Map();
  for (const p of mids.slice(-6)) counts.set(p.date.getDate(), (counts.get(p.date.getDate()) || 0) + 1);
  const day = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const last = mids[mids.length - 1];
  return {
    amount,
    day,
    last: { date: last.date, amount: round2(last.amount) },
    history: mids.slice(-12).reverse().map(p => ({ date: p.date, amount: round2(p.amount) })),
    // Two paychecks a month, each this base.
    perYear: round2(amount * 24),
    // No mid-month deposit in ~2 months: the schedule below may be out of date.
    stale: (today - last.date) / DAY > 62,
  };
}

/**
 * Every payday from the start of this month through `months` months: the
 * mid-month paycheck (base) and the month-end one (base + commission).
 * Paydays already in this month show what actually landed.
 *
 * @param base       baseSalary() output
 * @param paychecks  computeIncome().paychecks
 * @param expected   expectedPayouts() — commission still to be paid
 * @param takeHome   share of pre-tax commission that lands (commissionTakeHome), or null
 * @returns [{ date, dateKey, kind: 'mid'|'end', base, commissionPreTax, commissionTakeHome,
 *             total, projected, status: 'received'|'expected', received, earnedMonth, rows }]
 */
export function paySchedule({ base, paychecks, expected, takeHome, today = new Date(), months = 12 }) {
  if (!base) return [];
  const rate = takeHome ?? DEFAULT_TAKE_HOME;
  const t0 = startOfDay(today);
  const nowKey = keyOf(t0);
  const out = [];
  for (let i = 0; i < months; i++) {
    const key = addMonths(nowKey, i);
    const [y, m] = key.split('-').map(Number);
    const inMonth = (paychecks || []).filter(p => keyOf(p.date) === key);
    for (const kind of ['mid', 'end']) {
      const date = kind === 'mid'
        ? businessDayOnOrBefore(new Date(y, m - 1, Math.min(base.day, new Date(y, m, 0).getDate())))
        : businessDayOnOrBefore(monthEnd(key));
      const landed = inMonth.filter(p => (kind === 'mid' ? isMid(p) : !isMid(p))).sort((a, b) => b.amount - a.amount)[0] || null;
      // A payday that has gone by without a deposit isn't expected any more.
      if (!landed && date < t0) continue;
      const payout = kind === 'end' ? (expected || []).find(p => p.payMonth === key) || null : null;
      const preTax = payout ? payout.amount : 0;
      const commissionTakeHome = round2(preTax * rate);
      const row = {
        date: landed ? startOfDay(landed.date) : date,
        dateKey: ymd(landed ? landed.date : date),
        kind,
        base: base.amount,
        commissionPreTax: preTax,
        commissionTakeHome,
        total: round2(base.amount + commissionTakeHome),
        projected: !!payout?.projected,
        earnedMonth: payout ? payout.earnedMonth : kind === 'end' ? addMonths(key, -1) : null,
        rows: payout ? payout.rows : [],
        status: landed ? 'received' : 'expected',
        received: landed ? round2(landed.amount) : null,
      };
      out.push(row);
    }
  }
  return out;
}

export const CHART_RANGES = [
  { id: 'around', label: '12M back + 12M ahead' },
  { id: 'ahead', label: 'Next 12M' },
  { id: 'back', label: 'Last 24M' },
  { id: 'all', label: 'All' },
];

export const STATUSES = [
  { id: 'paid', label: 'Paid' },
  { id: 'recorded', label: 'Recorded, not paid yet' },
  { id: 'projected', label: 'Projected' },
];

/**
 * Commission by the paycheck it lands in, every row behind each one.
 * Recorded months come from the tracker as entered; projected ones from
 * expectedPayouts (each live commission carried forward to its end date).
 * @returns [{ earnedMonth, payMonth, payDate, account, project, amount, status }]
 */
export function commissionRows(commissions, today = new Date()) {
  const t0 = startOfDay(today);
  const out = [];
  for (const p of payouts(commissions)) {
    const paid = new Date(`${p.payDate}T00:00:00`) < t0;
    for (const r of p.rows) {
      out.push({ earnedMonth: p.earnedMonth, payMonth: p.payMonth, payDate: p.payDate, account: r.account, project: r.project, amount: r.amount, status: paid ? 'paid' : 'recorded' });
    }
  }
  for (const p of expectedPayouts(commissions, today)) {
    for (const r of p.rows) {
      if (!r.projected) continue; // recorded rows came in above
      out.push({ earnedMonth: p.earnedMonth, payMonth: p.payMonth, payDate: p.payDate, account: r.account, project: r.project, amount: r.amount, status: 'projected' });
    }
  }
  return out;
}

/** The pay months a range covers, oldest first; null bounds mean "the data's own". */
function rangeBounds(range, nowKey) {
  switch (range) {
    case 'ahead': return [nowKey, addMonths(nowKey, 11)];
    case 'back': return [addMonths(nowKey, -23), nowKey];
    case 'all': return [null, null];
    default: return [addMonths(nowKey, -12), addMonths(nowKey, 12)];
  }
}

/**
 * The chart: one point per pay month, after the filters.
 * @param rows      commissionRows()
 * @param accounts  Set of account names to keep, or null for all
 * @param statuses  Set of status ids to keep
 * @param range     CHART_RANGES id
 * @returns [{ payMonth, payDate, earnedMonth, amount, byStatus: { paid, recorded, projected }, rows }]
 */
export function chartPoints({ rows, accounts = null, statuses, range = 'around', today = new Date() }) {
  const nowKey = keyOf(today);
  const keep = (rows || []).filter(r =>
    (!accounts || accounts.has(r.account)) && (!statuses || statuses.has(r.status)));
  let [from, to] = rangeBounds(range, nowKey);
  if (!from || !to) {
    const keys = keep.map(r => r.payMonth).sort();
    if (!keys.length) return [];
    from = from || keys[0];
    to = to || keys[keys.length - 1];
  }
  const points = [];
  for (let k = from; k <= to; k = addMonths(k, 1)) {
    const inMonth = keep.filter(r => r.payMonth === k).sort((a, b) => b.amount - a.amount);
    const byStatus = { paid: 0, recorded: 0, projected: 0 };
    for (const r of inMonth) byStatus[r.status] = round2(byStatus[r.status] + r.amount);
    const [y, m] = k.split('-').map(Number);
    points.push({
      payMonth: k,
      payDate: ymd(businessDayOnOrBefore(new Date(y, m, 0))),
      earnedMonth: addMonths(k, -1),
      amount: round2(inMonth.reduce((s, r) => s + r.amount, 0)),
      byStatus,
      rows: inMonth,
    });
  }
  return points;
}

const STATUS_LABEL = Object.fromEntries(STATUSES.map(s => [s.id, s.label]));
const HEADER = ['Pay date', 'Pay month', 'Earned month', 'Account', 'Project', 'Status', 'Commission (pre-tax)', 'Est. take-home'];

/** Raw rows as spreadsheet rows (header first), for downloadXlsx. */
export function rawSheetRows(points, takeHome) {
  const rate = takeHome ?? DEFAULT_TAKE_HOME;
  const out = [HEADER.map((h, i) => ({ v: h, s: i >= 6 ? 'headerRight' : 'header' }))];
  for (const p of points) {
    for (const r of p.rows) {
      out.push([p.payDate, p.payMonth, r.earnedMonth, r.account, r.project, STATUS_LABEL[r.status] || r.status,
        { v: r.amount, s: 'money' }, { v: round2(r.amount * rate), s: 'money' }]);
    }
  }
  return out;
}

/** One row per chart point (what the bars show), for downloadXlsx. */
export function chartSheetRows(points, takeHome) {
  const rate = takeHome ?? DEFAULT_TAKE_HOME;
  const out = [['Pay date', 'Pay month', 'Earned month', 'Paid', 'Recorded, not paid yet', 'Projected', 'Total (pre-tax)', 'Est. take-home', 'Deals']
    .map((h, i) => ({ v: h, s: i >= 3 ? 'headerRight' : 'header' }))];
  for (const p of points) {
    out.push([p.payDate, p.payMonth, p.earnedMonth,
      { v: p.byStatus.paid, s: 'money' }, { v: p.byStatus.recorded, s: 'money' }, { v: p.byStatus.projected, s: 'money' },
      { v: p.amount, s: 'moneyBold' }, { v: round2(p.amount * rate), s: 'money' }, p.rows.length]);
  }
  return out;
}


/**
 * Expected vs actual, one point per pay month. Expected is what the tracker
 * says the month-end paycheck carries (recorded or projected), pre-tax and at
 * the take-home rate. Actual is what that paycheck really carried above base
 * salary (computeIncome().paychecks: `commission` = deposit − usual base).
 * Actual is null for a paycheck that hasn't landed (or wasn't found).
 * Account filtering doesn't apply: a paycheck can't be split by account.
 *
 * @param rows       commissionRows()
 * @param paychecks  computeIncome().paychecks
 * @returns [{ payMonth, payDate, earnedMonth, expectedPreTax, expectedTakeHome,
 *             actual: { date, deposit, base, commission } | null, diff, rows }]
 */
export function expectedVsActual({ rows, paychecks, takeHome, range = 'around', today = new Date() }) {
  const rate = takeHome ?? DEFAULT_TAKE_HOME;
  const points = chartPoints({ rows, range, today });
  const ends = new Map();
  for (const p of paychecks || []) {
    if (isMid(p)) continue;
    const k = keyOf(p.date);
    const prev = ends.get(k);
    // Two month-end deposits in a month (a correction, a bonus run): add them up.
    ends.set(k, prev
      ? { date: p.date > prev.date ? p.date : prev.date, deposit: round2(prev.deposit + p.amount), base: prev.base, commission: round2(prev.commission + (p.commission || 0)) }
      : { date: p.date, deposit: round2(p.amount), base: round2(p.base ?? p.amount), commission: round2(p.commission || 0) });
  }
  return points.map(p => {
    const actual = ends.get(p.payMonth) || null;
    const expectedTakeHome = round2(p.amount * rate);
    return {
      payMonth: p.payMonth,
      payDate: actual ? ymd(actual.date) : p.payDate,
      earnedMonth: p.earnedMonth,
      expectedPreTax: p.amount,
      expectedTakeHome,
      actual,
      diff: actual ? round2(actual.commission - expectedTakeHome) : null,
      rows: p.rows,
    };
  });
}

/** Totals over the months that have both sides. */
export function expectedVsActualTotals(points) {
  const both = (points || []).filter(p => p.actual);
  const expected = round2(both.reduce((s, p) => s + p.expectedTakeHome, 0));
  const actual = round2(both.reduce((s, p) => s + p.actual.commission, 0));
  return { months: both.length, expected, actual, diff: round2(actual - expected) };
}

/** Expected vs actual as spreadsheet rows, one per pay month. */
export function expectedVsActualSheetRows(points) {
  const out = [['Pay date', 'Pay month', 'Earned month', 'Expected (pre-tax)', 'Expected take-home', 'Month-end deposit', 'Base salary', 'Actual commission (take-home)', 'Difference', 'Deals']
    .map((h, i) => ({ v: h, s: i >= 3 ? 'headerRight' : 'header' }))];
  for (const p of points) {
    out.push([p.payDate, p.payMonth, p.earnedMonth,
      { v: p.expectedPreTax, s: 'money' }, { v: p.expectedTakeHome, s: 'money' },
      p.actual ? { v: p.actual.deposit, s: 'money' } : 'not paid yet',
      p.actual ? { v: p.actual.base, s: 'money' } : '',
      p.actual ? { v: p.actual.commission, s: 'moneyBold' } : '',
      p.diff == null ? '' : { v: p.diff, s: 'money' },
      p.rows.length]);
  }
  return out;
}

/**
 * Total pay by month, take-home: base salary from both paychecks with the
 * commission on top. Paychecks that have landed count as actual (their base
 * and the commission they carried); the ones still to come are expected (the
 * usual base, and the tracker's commission at the take-home rate).
 *
 * @param rows       commissionRows()
 * @param paychecks  computeIncome().paychecks
 * @param base       baseSalary() output (for the expected base), or null
 * @returns [{ payMonth, payDate, base: { actual, expected }, commission: { actual, expected },
 *             total, commissionShare, landed: [{ date, kind, deposit, base, commission }],
 *             expectedSlots, expectedPreTax, trackerPreTax,
 *             planned: { base, commission } | null  (what both paychecks were expected to carry),
 *             slots: [{ id, payMonth, kind, date, status, expected: { base, commission } | null,
 *                       actual: { deposit, base, commission } | null, diff }],  (mid, then end)
 *             rows }]
 */
export function payByMonth({ rows, paychecks, base, takeHome, range = 'around', today = new Date() }) {
  const rate = takeHome ?? DEFAULT_TAKE_HOME;
  const t0 = startOfDay(today);
  const nowKey = keyOf(t0);
  const points = chartPoints({ rows, range, today });
  const firstPaycheck = (paychecks || []).reduce((min, p) => (!min || p.date < min ? startOfDay(p.date) : min), null);
  const byMonth = new Map();
  for (const p of paychecks || []) {
    const k = keyOf(p.date);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(p);
  }
  return points.map(pt => {
    const landed = (byMonth.get(pt.payMonth) || []).sort((a, b) => a.date - b.date).map(p => ({
      date: p.date, kind: isMid(p) ? 'mid' : 'end', deposit: round2(p.amount),
      base: round2(p.base ?? p.amount), commission: round2(p.commission || 0),
    }));
    const has = kind => landed.some(l => l.kind === kind);
    // Paydays still to come: the current month's that haven't landed, and every one after.
    let expectedSlots = 0;
    if (base && pt.payMonth >= nowKey) {
      const [y, m] = pt.payMonth.split('-').map(Number);
      const midDate = businessDayOnOrBefore(new Date(y, m - 1, Math.min(base.day, new Date(y, m, 0).getDate())));
      const endDate = businessDayOnOrBefore(new Date(y, m, 0));
      if (!has('mid') && midDate >= t0) expectedSlots++;
      if (!has('end') && endDate >= t0) expectedSlots++;
    }
    const endPending = pt.payMonth >= nowKey && !has('end');
    const baseActual = round2(landed.reduce((s, l) => s + l.base, 0));
    const baseExpected = round2(expectedSlots * (base ? base.amount : 0));
    const commActual = round2(landed.reduce((s, l) => s + l.commission, 0));
    const commExpected = endPending ? round2(pt.amount * rate) : 0;
    const total = round2(baseActual + baseExpected + commActual + commExpected);
    // Each paycheck on its own, with what it was expected to carry beside what
    // it did: the usual base, plus the tracker's commission (take-home) on the
    // month-end one. Paydays from before the paycheck history starts have no
    // expected side, so an old month doesn't read as two missed paychecks.
    const [y, m] = pt.payMonth.split('-').map(Number);
    const slots = ['mid', 'end'].map(kind => {
      const mine = landed.filter(l => l.kind === kind);
      const scheduled = kind === 'mid'
        ? businessDayOnOrBefore(new Date(y, m - 1, Math.min(base ? base.day : 15, new Date(y, m, 0).getDate())))
        : businessDayOnOrBefore(new Date(y, m, 0));
      const date = mine.length ? mine[mine.length - 1].date : scheduled;
      const actual = mine.length ? {
        deposit: round2(mine.reduce((s, l) => s + l.deposit, 0)),
        base: round2(mine.reduce((s, l) => s + l.base, 0)),
        commission: round2(mine.reduce((s, l) => s + l.commission, 0)),
      } : null;
      const known = actual || (firstPaycheck && date >= firstPaycheck) || pt.payMonth >= nowKey;
      const expected = known ? {
        base: base ? base.amount : 0,
        commission: kind === 'end' ? round2(pt.amount * rate) : 0,
      } : null;
      return {
        id: `${pt.payMonth}-${kind}`,
        payMonth: pt.payMonth,
        kind,
        date,
        status: actual ? 'received' : date >= t0 ? 'expected' : known ? 'missed' : 'no-data',
        expected,
        actual,
        diff: actual && expected ? round2((actual.base + actual.commission) - (expected.base + expected.commission)) : null,
      };
    });
    const sum = (part, key) => round2(slots.reduce((s, sl) => s + (sl[part] ? sl[part][key] : 0), 0));
    const planned = slots.some(sl => sl.expected) ? { base: sum('expected', 'base'), commission: sum('expected', 'commission') } : null;
    return {
      payMonth: pt.payMonth,
      payDate: pt.payDate,
      earnedMonth: pt.earnedMonth,
      base: { actual: baseActual, expected: baseExpected },
      commission: { actual: commActual, expected: commExpected },
      total,
      commissionShare: total > 0 ? round2((commActual + commExpected) / total) : 0,
      landed,
      expectedSlots,
      expectedPreTax: endPending ? pt.amount : 0,
      trackerPreTax: pt.amount,
      planned,
      slots,
      rows: pt.rows,
    };
  });
}

/** Total pay as spreadsheet rows, one per month. */
export function payByMonthSheetRows(points) {
  const out = [['Pay month', 'Base (received)', 'Base (expected)', 'Commission (received)', 'Commission (expected)', 'Total pay', 'Commission share', 'Paychecks received', 'Paychecks expected']
    .map((h, i) => ({ v: h, s: i >= 1 ? 'headerRight' : 'header' }))];
  for (const p of points) {
    out.push([p.payMonth,
      { v: p.base.actual, s: 'money' }, { v: p.base.expected, s: 'money' },
      { v: p.commission.actual, s: 'money' }, { v: p.commission.expected, s: 'money' },
      { v: p.total, s: 'moneyBold' }, { v: p.commissionShare, s: 'pct' },
      p.landed.length, p.expectedSlots]);
  }
  return out;
}

/** Every paycheck behind the bars, expected beside actual, for the raw export. */
export function payByMonthPaycheckRows(points) {
  const out = [['Pay month', 'Date', 'Paycheck', 'Status', 'Expected base', 'Expected commission', 'Expected total', 'Deposit', 'Base', 'Commission', 'Difference']
    .map((h, i) => ({ v: h, s: i >= 4 ? 'headerRight' : 'header' }))];
  const STATUS = { received: 'Received', expected: 'Expected', missed: 'Not found', 'no-data': 'Before history' };
  const money = v => (v == null ? '' : { v, s: 'money' });
  for (const p of points) {
    for (const sl of p.slots) {
      const e = sl.expected;
      const a = sl.actual;
      out.push([p.payMonth, ymd(sl.date), sl.kind === 'mid' ? 'Mid-month' : 'Month-end', STATUS[sl.status],
        money(e?.base), money(e?.commission), e ? { v: round2(e.base + e.commission), s: 'moneyBold' } : '',
        money(a?.deposit), money(a?.base), money(a?.commission), money(sl.diff)]);
    }
  }
  return out;
}

/**
 * The deals behind one paycheck, over a run of pay months: what each paid
 * (or is projected to pay) in every month, so a paycheck's commission can be
 * read against its own past and future. Deals are matched by account and
 * project; amounts are pre-tax, with the take-home at the given rate.
 *
 * @param rows      commissionRows()
 * @param deals     the paycheck's rows ([{ account, project }]) — duplicates are fine
 * @param from      first pay month ("YYYY-MM")
 * @param months    how many pay months (default 24)
 * @returns { deals: [{ key, account, project, total, past, ahead }],
 *            points: [{ payMonth, byDeal: { [key]: { amount, status } }, amount, takeHome,
 *                       status: 'paid' | 'recorded' | 'projected' | null }],
 *            total, takeHome }
 */
export function dealHistory({ rows, deals, takeHome, from, months = 24, today = new Date() }) {
  const rate = takeHome ?? DEFAULT_TAKE_HOME;
  const nowKey = keyOf(today);
  const keyFor = r => `${r.account || ''}\u0000${r.project || ''}`;
  const list = [];
  const seen = new Set();
  for (const d of deals || []) {
    const k = keyFor(d);
    if (seen.has(k)) continue;
    seen.add(k);
    list.push({ key: k, account: d.account || '', project: d.project || '', total: 0, past: 0, ahead: 0 });
  }
  const byKey = new Map(list.map(d => [d.key, d]));
  const to = addMonths(from, months - 1);
  const points = [];
  for (let k = from; k <= to; k = addMonths(k, 1)) points.push({ payMonth: k, byDeal: {}, amount: 0, takeHome: 0, status: null });
  const at = new Map(points.map(p => [p.payMonth, p]));
  // Status rank: a month is only as firm as its least-firm deal.
  const RANK = { paid: 0, recorded: 1, projected: 2 };
  for (const r of rows || []) {
    const d = byKey.get(keyFor(r));
    const p = at.get(r.payMonth);
    if (!d || !p) continue;
    const prev = p.byDeal[d.key];
    p.byDeal[d.key] = {
      amount: round2((prev ? prev.amount : 0) + r.amount),
      status: prev && RANK[prev.status] > RANK[r.status] ? prev.status : r.status,
    };
    p.amount = round2(p.amount + r.amount);
    if (!p.status || RANK[r.status] > RANK[p.status]) p.status = r.status;
    d.total = round2(d.total + r.amount);
    if (r.payMonth <= nowKey && r.status !== 'projected') d.past = round2(d.past + r.amount);
    else d.ahead = round2(d.ahead + r.amount);
  }
  for (const p of points) p.takeHome = round2(p.amount * rate);
  const total = round2(points.reduce((s, p) => s + p.amount, 0));
  return { deals: list, points, total, takeHome: round2(total * rate) };
}

/** dealHistory() as spreadsheet rows: one per pay month, a column per deal. */
export function dealHistorySheetRows(history) {
  const label = d => [d.account, d.project].filter(Boolean).join(' · ') || '—';
  const out = [['Pay month', ...history.deals.map(label), 'Total (pre-tax)', 'Est. take-home', 'Status']
    .map((h, i) => ({ v: h, s: i >= 1 ? 'headerRight' : 'header' }))];
  for (const p of history.points) {
    out.push([p.payMonth,
      ...history.deals.map(d => (p.byDeal[d.key] ? { v: p.byDeal[d.key].amount, s: 'money' } : '')),
      { v: p.amount, s: 'moneyBold' }, { v: p.takeHome, s: 'money' }, p.status ? STATUS_LABEL[p.status] : '']);
  }
  return out;
}
