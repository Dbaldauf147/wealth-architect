/* This month's spending against the income it's expected to bring in.

   Projected income = what has already come in this month (counted as Cash
   Flow counts it, so the same figure as the bar on Overshot) plus the
   paychecks still due on the Commissions tab's pay schedule (base salary and
   the month-end commission at its take-home rate). Paychecks that have
   already landed are in the first part, so nothing is counted twice.

   Used by the Overshot chart (the projected bar on the month in progress)
   and by api/over-income-alert, which emails once a month the day spending
   first passes that line — the same numbers in both places.

   Pure: no React, no DOM. */

import { computeOvershot, monthsSpanned, monthKeyFor, expectedIncomeMonths } from './overshot.js';
import { computeIncome, commissionTakeHome, monthKeysEnding } from './income.js';
import { baseSalary, paySchedule } from './commissionSchedule.js';
import { payouts, expectedPayouts } from './commissions.js';

const round2 = n => Math.round(n * 100) / 100;

/**
 * @param month     the month in progress, from computeOvershot().months (partial)
 * @param expected  expectedIncomeMonths() rows; the one with month.key is used
 * @returns null without a month, else
 *   { key, income, stillDue, projected, spending, over, gap, paychecksDue }
 */
export function projectedMonth({ month, expected }) {
  if (!month) return null;
  const row = (expected || []).find(e => e.key === month.key) || null;
  const stillDue = row ? row.expected : 0;
  const projected = round2(month.income + stillDue);
  const spending = month.spending;
  return {
    key: month.key,
    income: month.income,
    stillDue: round2(stillDue),
    projected,
    hasSchedule: !!row,
    spending,
    over: spending > projected,
    gap: round2(Math.max(0, spending - projected)),
  };
}

/** The Commissions tab's pay schedule, built as that tab and Overshot build it. */
export function expectedIncomeSchedule({ transactions, incomeCategories, commissions, today = new Date() }) {
  const { paychecks } = computeIncome({ transactions, incomeCategories, monthKeys: monthKeysEnding(monthKeyFor(today), 13), today });
  const base = baseSalary(paychecks, today);
  if (!base) return null;
  const takeHome = commissionTakeHome(paychecks, payouts(commissions || []), today);
  const schedule = paySchedule({ base, paychecks, expected: expectedPayouts(commissions || [], today), takeHome, today });
  return { base, takeHome, schedule };
}

/**
 * Everything the alert needs, from the ledger and the commissions table.
 * @returns null when there's no ledger or no pay schedule to project from,
 *   else projectedMonth() plus { paychecksDue: [{ date, total, kind }] }
 */
export function currentMonthProjection({ transactions, incomeCategories, commissions, today = new Date() }) {
  if (!transactions?.length) return null;
  const keys = monthsSpanned(transactions, today).slice(-13);
  const { months } = computeOvershot({ transactions, monthKeys: keys, today });
  const month = months.find(m => m.partial);
  if (!month) return null;
  const sched = expectedIncomeSchedule({ transactions, incomeCategories, commissions, today });
  if (!sched) return null;
  const p = projectedMonth({ month, expected: expectedIncomeMonths({ schedule: sched.schedule, months: 1 }) });
  if (!p) return null;
  const paychecksDue = sched.schedule
    .filter(s => s.status === 'expected' && monthKeyFor(s.date) === month.key)
    .map(s => ({ date: s.date, total: s.total, kind: s.kind }));
  return { ...p, paychecksDue };
}

const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longMonth = key => { const [y, m] = key.split('-').map(Number); return `${MONTH_LONG[m - 1]} ${y}`; };
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The email sent the first day spending passes projected income. */
export function renderOverIncomeEmail(p, { siteUrl = '', today = new Date() } = {}) {
  const month = longMonth(p.key);
  const [y, m] = p.key.split('-').map(Number);
  const daysLeft = Math.max(0, new Date(y, m, 0).getDate() - today.getDate());
  const subject = `Spending passed ${month}'s expected income — over by ${money(p.gap)}`;
  const row = (label, value, strong = false) => `
    <tr>
      <td style="padding:4px 16px 4px 0;color:#475569">${esc(label)}</td>
      <td style="padding:4px 0;text-align:right;white-space:nowrap;color:#0f172a;${strong ? 'font-weight:700' : ''}">${esc(value)}</td>
    </tr>`;
  const due = (p.paychecksDue || []).map(d =>
    `${d.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${money(d.total)}`).join(', ');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:Inter,Arial,sans-serif;background:#f9f9f8">
    <div style="max-width:560px;margin:0 auto">
      <div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#94a3b8;margin-bottom:12px">Wealth Architect · Overshot</div>
      <div style="padding:16px 18px;border:1px solid #fecaca;border-radius:8px;background:#fef2f2">
        <div style="font-size:16px;font-weight:700;color:#991b1b">Spending is past ${esc(month)}'s expected income</div>
        <div style="font-size:13px;color:#7f1d1d;margin-top:4px">${money(p.spending)} spent so far against ${money(p.projected)} expected in — ${money(p.gap)} over, with ${daysLeft} day${daysLeft === 1 ? '' : 's'} of the month left.</div>
        <table style="border-collapse:collapse;font-size:13px;margin-top:12px">
          ${row('Spent so far', money(p.spending), true)}
          ${row('Income in so far', money(p.income))}
          ${row('Paychecks still due', money(p.stillDue))}
          ${row('Expected income', money(p.projected), true)}
        </table>
        ${due ? `<div style="font-size:12px;color:#64748b;margin-top:8px">Still due: ${esc(due)}</div>` : ''}
      </div>
      <div style="font-size:12px;color:#94a3b8;margin-top:12px">Income and spending counted as on Cash Flow; expected paychecks from the Commissions tab's pay schedule. Sent once a month.${siteUrl ? ` See <a href="${esc(siteUrl)}/#overshot" style="color:#0058be">Overshot</a>.` : ''}</div>
    </div></body></html>`;
  return { subject, html };
}
