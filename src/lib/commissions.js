/* Commissions from the Prospect Tracker's Commissions table, read through
   api/commissions.

   The tracker keeps the table as pasted sheet rows: account, project, rate,
   Comm Start / Comm End dates, and twelve month columns ("January" …
   "December") holding the commission earned that month, pre-tax. The month
   columns carry no year, so each is placed in the year that puts it inside the
   row's Comm Start–End window; one that falls outside it goes to the year
   nearest the window, and with no dates at all, to its latest occurrence that
   isn't in the future.

   A month's commission is paid in the NEXT month's month-end paycheck —
   September's arrives in the October 31 deposit — and it lands taxed, inside
   the paycheck, so it is never added to income on top of the deposit; it
   explains part of it.

   Pure: no React, no fetch. */

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// A commission paid this recently is still active even past its end date —
// the tracker's rule for its Payment Status column.
const RECENT_PAYMENT_DAYS = 62;
const DAY = 86400000;

const pad = n => String(n).padStart(2, '0');
export const ymKey = (y, m) => `${y}-${pad(m + 1)}`;
const ymIndex = (y, m) => y * 12 + m;

/** "$1,234.50 ", "(12.00)", "-", "" → number or null. */
export function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value ?? '').trim();
  if (!s || /^[-–—]+$/.test(s)) return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** "13.60%" → 0.136; "0.136" → 0.136. */
export function parseRate(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return s.includes('%') || n > 1 ? n / 100 : n;
}

/** "3/1/2023" or "2023-03-01" → local Date, else null. */
export function parseDate(value) {
  const s = String(value ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return new Date(y, +m[1] - 1, +m[2]);
}

/** The year a month column (0 = January) belongs to for this window. */
export function yearForMonth(monthIdx, start, end, today = new Date()) {
  const nowIdx = ymIndex(today.getFullYear(), today.getMonth());
  if (!start && !end) {
    // Latest occurrence that isn't in the future.
    return monthIdx <= today.getMonth() ? today.getFullYear() : today.getFullYear() - 1;
  }
  const lo = start ? ymIndex(start.getFullYear(), start.getMonth()) : -Infinity;
  const hi = end ? ymIndex(end.getFullYear(), end.getMonth()) : Math.max(nowIdx, lo);
  const from = (start || end).getFullYear() - 1;
  const to = (end || today).getFullYear() + 1;
  let best = null;
  for (let y = from; y <= to; y++) {
    const i = ymIndex(y, monthIdx);
    const distance = i < lo ? lo - i : i > hi ? i - hi : 0;
    // Nearest the window; inside it, or on a tie, the later year.
    if (!best || distance < best.distance || (distance === best.distance && y > best.y)) best = { y, distance };
  }
  return best.y;
}

/** The month a commission earned in `ym` is paid in. */
export function payMonthOf(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

/** Last calendar day of a "YYYY-MM" month. */
export function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0);
}

/**
 * Tracker rows → one record per commission.
 * @returns [{ id, account, project, rate, start, end, months: { 'YYYY-MM': amount }, total, lastPaid, active }]
 */
export function parseCommissionRows(rows, today = new Date()) {
  const out = [];
  for (const [i, row] of (Array.isArray(rows) ? rows : []).entries()) {
    if (!row || typeof row !== 'object') continue;
    const start = parseDate(row['Comm Start Date']);
    const end = parseDate(row['Comm End Date']);
    const months = {};
    MONTH_NAMES.forEach((name, m) => {
      const amount = parseMoney(row[name]);
      if (amount == null || amount === 0) return;
      const key = ymKey(yearForMonth(m, start, end, today), m);
      months[key] = Math.round(((months[key] || 0) + amount) * 100) / 100;
    });
    const keys = Object.keys(months).sort();
    const lastPaid = keys.length ? keys[keys.length - 1] : null;
    const recent = lastPaid && (today - monthEnd(lastPaid)) / DAY <= RECENT_PAYMENT_DAYS;
    out.push({
      id: String(row.id ?? i),
      account: String(row['Account Name'] || '').trim(),
      project: String(row['Project Name'] || '').trim(),
      rate: parseRate(row['%']),
      start: start ? ymdOf(start) : null,
      end: end ? ymdOf(end) : null,
      months,
      total: Math.round(keys.reduce((s, k) => s + months[k], 0) * 100) / 100,
      lastPaid,
      active: (!!end && end >= startOfDay(today)) || !!recent,
    });
  }
  return out;
}

/** Commission earned per month, across every row: { 'YYYY-MM': amount }. */
export function earnedByMonth(commissions) {
  const out = {};
  for (const c of commissions || []) {
    for (const [k, v] of Object.entries(c.months)) out[k] = Math.round(((out[k] || 0) + v) * 100) / 100;
  }
  return out;
}

/**
 * Commission by the paycheck it arrives in, oldest first:
 * [{ payMonth, payDate, earnedMonth, amount, rows: [{ account, project, amount }] }]
 */
export function payouts(commissions) {
  const byMonth = new Map();
  for (const c of commissions || []) {
    for (const [earned, amount] of Object.entries(c.months)) {
      if (!byMonth.has(earned)) byMonth.set(earned, []);
      byMonth.get(earned).push({ account: c.account, project: c.project, amount });
    }
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([earnedMonth, rows]) => {
      const payMonth = payMonthOf(earnedMonth);
      return {
        payMonth,
        payDate: ymdOf(monthEnd(payMonth)),
        earnedMonth,
        amount: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100,
        rows: rows.sort((a, b) => b.amount - a.amount),
      };
    });
}

/** The payout due in a given pay month ("YYYY-MM"), or null. */
export function payoutFor(list, payMonth) {
  return (list || []).find(p => p.payMonth === payMonth) || null;
}

const PAYROLL = /payroll|direct dep|salary/i;

/**
 * The payroll deposits of a pay month: { midMonth, monthEnd } (each
 * { date, amount } or null) — the deposit the commission arrives in, and the
 * one without it to compare against. Payroll is told by its bank description.
 */
export function paychecksIn(transactions, payMonth) {
  const [y, m] = payMonth.split('-').map(Number);
  let midMonth = null;
  let end = null;
  for (const t of transactions || []) {
    const amount = Number(t.amount);
    if (!(amount >= 100) || !PAYROLL.test(`${t.description || ''} ${t.fullDescription || ''}`)) continue;
    const date = new Date(t.date);
    if (isNaN(date) || date.getFullYear() !== y || date.getMonth() !== m - 1) continue;
    if (date.getDate() > 20) { if (!end || amount > end.amount) end = { date, amount }; }
    else if (!midMonth || amount > midMonth.amount) midMonth = { date, amount };
  }
  return { midMonth, monthEnd: end };
}

export function monthLabel(ym, opts = { month: 'long', year: 'numeric' }) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', opts);
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function ymdOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
