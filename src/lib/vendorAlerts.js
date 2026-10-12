/* Vendor spend alerts: "tell me when I've spent more than $X at Y".
 *
 * A rule names a vendor by a piece of text, a dollar threshold, and a period:
 *
 *   · month    — total spent at the vendor this calendar month
 *   · week     — total spent this Monday–Sunday week
 *   · purchase — any single purchase at the vendor this month
 *
 * The page shows how close each rule is; the daily api/vendor-alerts cron
 * emails once per rule per period the first time it is crossed. Both read the
 * same evaluation from here, so the email never disagrees with the page.
 *
 * A vendor is matched as text, not as an id: the same merchant arrives as
 * "AMAZON MKTPL*2K4", "Amazon.com*RT5" and "AMZN Mktp US". The user types the
 * part they all share ("amazon", "amzn") and the description, full description
 * and merchant name are all searched, ignoring case and punctuation.
 *
 * Pure: no React, no DOM, no storage.
 */

import { dayNumber } from './alertMatch.js';

export const PERIODS = [
  { id: 'month', label: 'per month' },
  { id: 'week', label: 'per week' },
  { id: 'purchase', label: 'per purchase' },
];

const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Whether a transaction is at the rule's vendor. */
export function matchesVendor(vendor, t) {
  const needle = squash(vendor);
  if (!needle || !t) return false;
  return [t.description, t.fullDescription, t.merchant]
    .some(field => ` ${squash(field)} `.includes(` ${needle}`));
}

const DAY_MS = 86400000;
const isoDay = n => new Date(n * DAY_MS).toISOString().slice(0, 10);

/**
 * The period a rule is measured over, as inclusive day numbers.
 *
 * @param {'month'|'week'|'purchase'} period
 * @param {string} today  'YYYY-MM-DD' — the caller's calendar day, so the page
 *                        and the cron (which runs in UTC) agree on "this month".
 */
export function periodRange(period, today) {
  const end = dayNumber(today);
  if (end == null) return null;
  const d = new Date(end * DAY_MS);
  let start;
  if (period === 'week') {
    // getUTCDay: 0 = Sunday. Weeks start Monday, like the weekly email.
    start = end - ((d.getUTCDay() + 6) % 7);
  } else {
    start = dayNumber(`${today.slice(0, 7)}-01`);
  }
  // Monthly and per-purchase rules both key on the month; weekly on its Monday.
  const key = period === 'week' ? isoDay(start) : today.slice(0, 7);
  return { start, end, key };
}

/** A stable key for one transaction — what a per-purchase email dedupes on. */
export function txnKey(t) {
  return t.transactionId || `${t.date}|${t.description}|${t.amount}`;
}

/**
 * Evaluate one rule against the ledger.
 *
 * Spend is net of refunds at the same vendor for the totals — a returned order
 * shouldn't keep you over a monthly limit. A per-purchase rule looks only at
 * charges, since a refund is never "a purchase over $X".
 *
 * @returns {{
 *   rule: object, spent: number, threshold: number, pct: number, crossed: boolean,
 *   periodKey: string, matches: object[], over: object[], crossedOn: string|null,
 * } | null}
 *   `over` is the purchases that broke a per-purchase rule. `crossedOn` is the
 *   date of the charge that took a total over its threshold. `periodKey` is
 *   what a total's email is deduplicated on; a per-purchase rule dedupes on
 *   each purchase in `over` instead (see txnKey), so a second big purchase in
 *   the same month still emails.
 */
export function evaluateVendorAlert(rule, transactions, today) {
  const threshold = Number(rule && rule.threshold);
  if (!rule || !rule.vendor || !(threshold > 0)) return null;
  const range = periodRange(rule.period, today);
  if (!range) return null;

  const matches = [];
  for (const t of transactions || []) {
    const n = dayNumber(t.date);
    if (n == null || n < range.start || n > range.end) continue;
    if (!matchesVendor(rule.vendor, t)) continue;
    matches.push({ ...t, _day: n });
  }
  matches.sort((a, b) => a._day - b._day);

  if (rule.period === 'purchase') {
    const charges = matches.filter(t => Number(t.amount) < 0);
    const over = charges.filter(t => -Number(t.amount) >= threshold);
    const biggest = charges.reduce((m, t) => Math.max(m, -Number(t.amount)), 0);
    return {
      rule, threshold, spent: biggest, pct: biggest / threshold,
      crossed: over.length > 0,
      periodKey: range.key,
      matches: charges, over,
      crossedOn: over.length ? over[0].date : null,
    };
  }

  let running = 0;
  let crossedOn = null;
  for (const t of matches) {
    running -= Number(t.amount) || 0;
    if (crossedOn == null && running >= threshold) crossedOn = t.date;
  }
  const spent = Math.max(0, running);
  return {
    rule, threshold, spent, pct: spent / threshold,
    crossed: spent >= threshold,
    // A refund can pull a total back under after it crossed; it still crossed.
    crossedOn: spent >= threshold ? crossedOn : null,
    periodKey: range.key,
    matches, over: [],
  };
}

/** Every rule, evaluated, in the order the user created them. */
export function evaluateVendorAlerts(rules, transactions, today) {
  return (Array.isArray(rules) ? rules : [])
    .map(r => evaluateVendorAlert(r, transactions, today))
    .filter(Boolean);
}

/** Today's calendar day in a time zone, as 'YYYY-MM-DD'. */
export function todayIn(zone = 'America/New_York', now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** A new rule with a fresh id. */
export function newVendorAlert({ vendor, threshold, period = 'month', email = true }) {
  return {
    id: `va_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    vendor: String(vendor || '').trim(),
    threshold: Math.round(Number(threshold) * 100) / 100,
    period: PERIODS.some(p => p.id === period) ? period : 'month',
    email: email !== false,
    createdAt: new Date().toISOString(),
  };
}
