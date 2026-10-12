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

/**
 * What still needs emailing: crossed alerts with email on that haven't been
 * sent for this period (or, per-purchase, for this purchase) before.
 *
 * @param {object[]} results   from evaluateVendorAlerts
 * @param {Set<string>} sent   send keys already recorded
 * @returns {{ result: object, sendKeys: string[], newOver: object[] }[]}
 */
export function pendingSends(results, sent) {
  const out = [];
  for (const r of results) {
    if (!r.crossed || r.rule.email === false) continue;
    if (r.rule.period === 'purchase') {
      const fresh = r.over.filter(t => !sent.has(sendKey(r.rule, txnKey(t))));
      if (fresh.length) out.push({ result: r, sendKeys: fresh.map(t => sendKey(r.rule, txnKey(t))), newOver: fresh });
    } else {
      const key = sendKey(r.rule, r.periodKey);
      if (!sent.has(key)) out.push({ result: r, sendKeys: [key], newOver: [] });
    }
  }
  return out;
}

/** A Firestore-safe document id for one email about one rule. */
export function sendKey(rule, part) {
  const raw = `${rule.id}__${part}`;
  // Doc ids can't contain "/"; transaction ids and fallback keys can.
  return raw.replace(/[/\s]+/g, '_').slice(0, 1400);
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

/** Subject and HTML body for one email covering every pending alert. */
export function renderVendorAlertEmail(pending, { siteUrl = '' } = {}) {
  const lines = pending.map(({ result: r, newOver }) => {
    const label = PERIODS.find(p => p.id === r.rule.period)?.label || '';
    const headline = r.rule.period === 'purchase'
      ? `${newOver.length === 1 ? 'A purchase' : `${newOver.length} purchases`} of ${money(r.threshold)} or more`
      : `${money(r.spent)} spent ${r.rule.period === 'week' ? 'this week' : 'this month'} — ${money(r.spent - r.threshold)} over`;
    const rows = (r.rule.period === 'purchase' ? newOver : r.matches).slice(-12).reverse().map(t => `
        <tr>
          <td style="padding:2px 12px 2px 0;color:#64748b;white-space:nowrap">${esc(t.date)}</td>
          <td style="padding:2px 12px 2px 0;color:#334155">${esc(t.description)}</td>
          <td style="padding:2px 0;text-align:right;white-space:nowrap;color:${Number(t.amount) < 0 ? '#0f172a' : '#009668'}">${Number(t.amount) < 0 ? money(-Number(t.amount)) : `−${money(Number(t.amount))}`}</td>
        </tr>`).join('');
    return `
      <div style="margin:0 0 20px;padding:14px 16px;border:1px solid #f1c4c4;border-radius:8px;background:#fdf6f6">
        <div style="font-size:15px;font-weight:700;color:#0f172a">${esc(r.rule.vendor)}
          <span style="font-weight:400;color:#64748b;font-size:13px">· alert at ${money(r.threshold)} ${esc(label)}</span></div>
        <div style="margin:4px 0 10px;font-size:14px;font-weight:600;color:#ba1a1a">${esc(headline)}</div>
        <table style="border-collapse:collapse;font-size:13px">${rows}</table>
      </div>`;
  }).join('');
  const names = pending.map(p => p.result.rule.vendor);
  const subject = pending.length === 1
    ? `Spending alert: ${names[0]} passed ${money(pending[0].result.threshold)}`
    : `Spending alerts: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:Inter,Arial,sans-serif;background:#f9f9f8">
    <div style="max-width:560px;margin:0 auto">
      <div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#94a3b8;margin-bottom:12px">Wealth Architect · Vendor alerts</div>
      ${lines}
      <div style="font-size:12px;color:#94a3b8">You'll get this once per alert per period.${siteUrl ? ` Change or remove alerts on <a href="${esc(siteUrl)}/#trends" style="color:#0058be">Spending Trends</a>.` : ''}</div>
    </div></body></html>`;
  return { subject, html };
}
