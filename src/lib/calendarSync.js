/* Build the Google Calendar event specs for each card's next projected
   payment, from the same data the website's Cards Schedule view and the
   day-before email reminder use. Pure functions so the Vercel cron can run
   them unchanged and they stay unit-testable.

   Model: one all-day event per card, for that card's *next* projected
   payment. buildCardSchedule only knows the immediate next payment per card,
   so we keep a single event per card and let it roll forward — each daily
   run re-projects and updates the same (deterministic) event id, so a payment
   posting just moves the event to the next cycle instead of piling up
   duplicates. Cards that are hidden or have no projected payment produce a
   removal so their stale event is deleted. */

import { buildCardSchedule } from './cardSchedule.js';
import { findPayingAccount } from './paymentReminder.js';

// Tolerant card-name parser — mirrors CardsPage / paymentReminder.js /
// api/payment-reminder.js so the stable per-card key matches everywhere.
function parseAccountName(s) {
  const lower = (s || '').toLowerCase();
  const digitMatch = lower.match(/\d{4,}(?!.*\d)/);
  const digits = digitMatch ? digitMatch[0].slice(-4) : '';
  const core = lower
    .replace(/[(){}\[\],./\\_*×-]+/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\bx+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const full = digits ? `${core}#${digits}` : core;
  return { full, core, digits };
}

/** Deterministic Google Calendar event id for a card.
 *
 *  Calendar event ids must be base32hex — characters [a-v0-9], length 5–1024,
 *  lowercase. We hex-encode the (URI-escaped, therefore ASCII) card key: hex
 *  digits 0-9a-f are all valid base32hex characters, so the result is always a
 *  legal id, is stable across runs for the same card, and never collides
 *  between two different cards. The `ccp` prefix uses only legal characters. */
export function eventIdForCard(cardKey) {
  const s = encodeURIComponent(cardKey || '');
  let hex = '';
  for (let i = 0; i < s.length; i++) {
    hex += s.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return `ccp${hex}`;
}

function money(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n || 0);
}

// YYYY-MM-DD from a Date's own calendar components. buildCardSchedule produces
// date-only values built at local midnight (`new Date(y, m, d)` and
// occurrenceInMonth) — "the 26th" means the 26th. We must read those same local
// components rather than reformat through a fixed tz, which would shift the day
// by one whenever the server tz (UTC on Vercel) differs from that tz.
function dateOnlyKey(date) {
  if (!date) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// All-day events use an exclusive end date, so a single-day event ends on the
// following calendar day.
function addOneDay(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function buildDescription({ amount, chargesCount, payingAccountName }) {
  const lines = ['Projected credit-card payment.'];
  const chargeNote = chargesCount
    ? ` (from ${chargesCount} charge${chargesCount === 1 ? '' : 's'} since your last payment)`
    : '';
  lines.push(`Estimated amount: ${money(amount)}${chargeNote}.`);
  if (payingAccountName) lines.push(`Pay from: ${payingAccountName}.`);
  lines.push('');
  lines.push("Date and amount are estimates from your payment cadence — confirm in your card issuer's app before paying.");
  lines.push('— Wealth Architect');
  return lines.join('\n');
}

/**
 * Build the Calendar event specs (to upsert) and removals (to delete) for a
 * set of cards.
 *
 * @param {object} opts
 * @param {Array<{name:string, color?:string}>} opts.cards
 * @param {Array} opts.transactions Canonicalized transactions (t.account maps to a card name).
 * @param {object} [opts.balances] Latest balances, for the paying-account note.
 * @param {Date} [opts.asOf=new Date()]
 * @param {Iterable<string>} [opts.hiddenCards]
 * @param {object} [opts.nicknames] accountName -> nickname map, for display.
 * @param {string} [opts.payingAccountLast4='1118']
 * @returns {{ events: Array, removals: Array }}
 */
export function buildCalendarEvents(opts) {
  const {
    cards,
    transactions,
    balances,
    asOf = new Date(),
    hiddenCards,
    nicknames = {},
    payingAccountLast4 = '1118',
  } = opts || {};

  const events = [];
  const removals = [];
  if (!Array.isArray(cards) || cards.length === 0) return { events, removals };

  const hiddenSet = new Set(hiddenCards || []);
  const schedule = buildCardSchedule({ cards, transactions, asOf });
  const payingAccount = findPayingAccount(balances, payingAccountLast4);
  const payingName = payingAccount
    ? (nicknames[payingAccount.name] || payingAccount.name)
    : null;

  for (const entry of schedule) {
    const cardKey = parseAccountName(entry.card).full;
    const eventId = eventIdForCard(cardKey);

    if (hiddenSet.has(entry.card) || !entry.nextPaymentDate) {
      removals.push({ cardKey, eventId, card: entry.card });
      continue;
    }

    const dateKey = dateOnlyKey(entry.nextPaymentDate);
    const displayName = nicknames[entry.card] || entry.card;
    const amount = entry.estimatedNextAmount || 0;
    const chargesCount = entry.chargesSinceLast ? entry.chargesSinceLast.length : 0;

    events.push({
      cardKey,
      eventId,
      card: entry.card,
      displayName,
      amount,
      chargesCount,
      date: entry.nextPaymentDate,
      dateKey,
      endDateKey: addOneDay(dateKey),
      summary: `💳 ${displayName} — ~${money(amount)}`,
      description: buildDescription({ amount, chargesCount, payingAccountName: payingName }),
    });
  }

  return { events, removals };
}

/** Convert an event spec from buildCalendarEvents into the Google Calendar
 *  event resource body. Separated so the API layer stays declarative. */
export function toCalendarEventBody(spec, { siteUrl } = {}) {
  const body = {
    id: spec.eventId,
    summary: spec.summary,
    description: spec.description,
    start: { date: spec.dateKey },
    end: { date: spec.endDateKey },
    transparency: 'transparent', // doesn't block time / show as busy
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 12 * 60 }], // ~noon the day before
    },
    extendedProperties: {
      private: {
        wealthArchitect: '1',
        card: spec.cardKey,
        amount: String(Math.round((spec.amount || 0) * 100) / 100),
      },
    },
  };
  if (siteUrl) body.source = { title: 'Wealth Architect', url: siteUrl };
  return body;
}
