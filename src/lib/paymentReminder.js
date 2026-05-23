/* Build the "day-before credit card payment" reminder payload from the
   same data the website's Cards Schedule view uses. Pure function so it
   can run unchanged in the Vercel cron and (eventually) be previewed in
   the browser.

   Returns null if nothing is due tomorrow, otherwise an object with the
   cards due and the user's paying-account balance. */

import { buildCardSchedule } from './cardSchedule.js';

// Return YYYY-MM-DD for the given Date as seen in `tz`. We use this for
// equality comparisons so a payment projected for 11:30pm Eastern on day X
// doesn't get treated as day X+1 by a server running in UTC.
function localDateKey(date, tz) {
  if (!date) return null;
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA formats as YYYY-MM-DD natively.
  return f.format(date);
}

// Pull the paying account (e.g. BoA Checking ending in 1118) from the
// asset list. Matches by trailing 4-digit suffix so a nickname change
// or institution rename in Tiller doesn't break the lookup.
export function findPayingAccount(balances, last4) {
  if (!balances || !Array.isArray(balances.assets)) return null;
  const pattern = new RegExp(`${last4}\\b`);
  return balances.assets.find(a => pattern.test(a.name || '')) || null;
}

/**
 * Compute the payment-reminder payload for a given moment.
 *
 * @param {object} opts
 * @param {Array<{name:string, color?:string}>} opts.cards
 * @param {Array} opts.transactions
 * @param {object} opts.balances
 * @param {Date} [opts.asOf=new Date()] Reference instant for "today" / "tomorrow".
 * @param {string} [opts.tz='America/New_York'] IANA timezone for the date comparison.
 * @param {string} [opts.payingAccountLast4='1118'] Last-4 digits of the paying account.
 * @param {Iterable<string>} [opts.hiddenCards] Card names to skip.
 * @param {object} [opts.nicknames] accountName -> nickname map, for display.
 * @returns {null | {
 *   cardsDueTomorrow: Array<{ name:string, displayName:string, amount:number, date:Date }>,
 *   totalDue: number,
 *   payingAccount: { name:string, balance:number, updated?:string } | null,
 *   asOf: Date,
 *   tomorrowDateKey: string,
 * }}
 */
export function buildPaymentReminder(opts) {
  const {
    cards,
    transactions,
    balances,
    asOf = new Date(),
    tz = 'America/New_York',
    payingAccountLast4 = '1118',
    hiddenCards,
    nicknames = {},
  } = opts || {};

  if (!Array.isArray(cards) || cards.length === 0) return null;

  // Compute tomorrow's date key in the target tz by adding 24h to asOf.
  // 24h is good enough for a daily cron; DST edges shift the wall clock
  // but the date arithmetic still rolls forward by one calendar day.
  const tomorrow = new Date(asOf.getTime() + 86400000);
  const tomorrowKey = localDateKey(tomorrow, tz);

  const hiddenSet = new Set(hiddenCards || []);

  const schedule = buildCardSchedule({ cards, transactions, asOf });

  const cardsDueTomorrow = [];
  for (const entry of schedule) {
    if (!entry.nextPaymentDate) continue;
    if (hiddenSet.has(entry.card)) continue;
    if (localDateKey(entry.nextPaymentDate, tz) !== tomorrowKey) continue;
    cardsDueTomorrow.push({
      name: entry.card,
      displayName: nicknames[entry.card] || entry.card,
      amount: entry.estimatedNextAmount || 0,
      date: entry.nextPaymentDate,
    });
  }

  if (cardsDueTomorrow.length === 0) return null;

  const totalDue = cardsDueTomorrow.reduce((s, c) => s + c.amount, 0);
  const payingAccount = findPayingAccount(balances, payingAccountLast4);

  return {
    cardsDueTomorrow,
    totalDue,
    payingAccount: payingAccount
      ? { name: payingAccount.name, balance: payingAccount.balance, updated: payingAccount.updated }
      : null,
    asOf,
    tomorrowDateKey: tomorrowKey,
  };
}

// Minimal HTML rendering for the email. Inline styles only, no external
// fonts — most mail clients strip <style> blocks.
export function renderPaymentReminderHtml(payload) {
  const { cardsDueTomorrow, totalDue, payingAccount, tomorrowDateKey } = payload;

  const fmt = (n) => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n || 0);

  const dueDateLabel = new Date(`${tomorrowDateKey}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const balance = payingAccount ? payingAccount.balance : null;
  const runway = balance != null ? balance - totalDue : null;
  const runwayColor = runway != null && runway < 0 ? '#ba1a1a' : '#0f172a';

  const cardRows = cardsDueTomorrow.map(c => `
    <tr>
      <td style="padding:10px 12px;border-top:1px solid #e2e8f0;font-family:Arial,sans-serif;font-size:14px;color:#0f172a;">${escapeHtml(c.displayName)}</td>
      <td style="padding:10px 12px;border-top:1px solid #e2e8f0;font-family:Arial,sans-serif;font-size:14px;color:#0f172a;text-align:right;font-weight:600;">${fmt(c.amount)}</td>
    </tr>
  `).join('');

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,sans-serif;color:#0f172a;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);overflow:hidden;">
    <div style="padding:20px 24px;background:#0058be;color:#ffffff;">
      <div style="font-size:12px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;opacity:0.85;">Payment Reminder</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px;">Card ${cardsDueTomorrow.length === 1 ? 'payment' : 'payments'} due ${dueDateLabel}</div>
    </div>
    <div style="padding:24px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#64748b;">Card</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#64748b;">Projected</th>
          </tr>
        </thead>
        <tbody>${cardRows}</tbody>
        <tfoot>
          <tr>
            <td style="padding:12px;border-top:2px solid #0f172a;font-family:Arial,sans-serif;font-size:14px;font-weight:700;">Total projected</td>
            <td style="padding:12px;border-top:2px solid #0f172a;font-family:Arial,sans-serif;font-size:14px;font-weight:700;text-align:right;">${fmt(totalDue)}</td>
          </tr>
        </tfoot>
      </table>

      ${payingAccount ? `
        <div style="margin-top:20px;padding:14px 16px;background:#f1f5f9;border-radius:8px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#64748b;margin-bottom:4px;">Paying from</div>
          <div style="font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(payingAccount.name)}</div>
          <table style="width:100%;margin-top:10px;border-collapse:collapse;">
            <tr>
              <td style="font-size:12px;color:#64748b;">Current balance</td>
              <td style="font-size:14px;font-weight:600;text-align:right;color:#0f172a;">${fmt(balance)}</td>
            </tr>
            <tr>
              <td style="font-size:12px;color:#64748b;padding-top:4px;">After projected payment${cardsDueTomorrow.length > 1 ? 's' : ''}</td>
              <td style="font-size:14px;font-weight:700;text-align:right;padding-top:4px;color:${runwayColor};">${fmt(runway)}</td>
            </tr>
          </table>
        </div>
      ` : `
        <div style="margin-top:20px;padding:14px 16px;background:#fef3c7;border-radius:8px;font-size:13px;color:#92400e;">
          Couldn't find the paying account ending in 1118 in your latest balances.
        </div>
      `}

      <div style="margin-top:20px;font-size:11px;color:#94a3b8;line-height:1.5;">
        Projected dates and amounts come from your historical payment cadence and charges since your last payment. Real statement due dates and balances may differ — confirm in your card issuer's app before relying on these numbers.
      </div>
    </div>
  </div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
