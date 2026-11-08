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

