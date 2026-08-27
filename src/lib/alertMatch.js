/* Joining a purchase alert to the transaction that later arrives for it.
 *
 * The alert reaches the phone seconds after the card is tapped; the row it
 * belongs to reaches the sheet days later, worded by the card network rather
 * than the bank's alert system. "DUNKIN #12345" becomes "DUNKIN 12345
 * BROOKLYN NY", "SHELL OIL 5732" becomes "SHELL SERVICE STATION". So the
 * merchant is corroborating evidence, never the key.
 *
 * The amount is the key. It is exact to the cent, the user rarely spends the
 * same amount twice in a week, and it is the one field neither side rewrites.
 * Date narrows the field — a card can take days to post, so the window is
 * generous in the direction the delay actually runs.
 *
 * A wrong match writes a category onto someone else's transaction, which is
 * worse than no match at all: it is silent, and it looks like the user did it.
 * So a candidate has to be unambiguous — one contender, or one clearly ahead —
 * and anything less is left for the review deck to ask about.
 *
 * Pure: no React, no DOM, no storage.
 */

import { normalizeDesc } from './categorize.js';

// How long a card takes to post. Two days early covers a bank stamping the
// authorization date; ten days late covers a slow merchant and a weekend.
const DAYS_EARLY = 2;
const DAYS_LATE = 10;

// A second candidate this close to the leader means we cannot tell them apart.
const AMBIGUOUS_MARGIN = 2;

/** A date as a day number, from either ISO or the sheet's M/D/YYYY. */
export function dayNumber(input) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(input || ''));
  const d = iso
    ? new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
    : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(
    (iso ? d.getTime() : Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000,
  );
}

/** Words worth comparing — the noise a card network adds is not. */
const NOISE = new Set([
  'the', 'inc', 'llc', 'co', 'corp', 'ltd', 'store', 'purchase', 'pos', 'debit',
  'credit', 'card', 'payment', 'us', 'usa', 'ny', 'nyc', 'com', 'www', 'http', 'https',
]);

function words(text) {
  return normalizeDesc(text || '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !NOISE.has(w) && !/^\d{1,2}$/.test(w));
}

/**
 * How much two merchant strings agree, 0 to 1.
 *
 * Shared words over the shorter side, so "DUNKIN" scores a full match against
 * "DUNKIN 12345 BROOKLYN NY" — the sheet's extra location words are not
 * disagreement, they are just the network being verbose.
 */
export function merchantSimilarity(a, b) {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const setB = new Set(wb);
  let shared = 0;
  for (const w of new Set(wa)) if (setB.has(w)) shared += 1;
  return shared / Math.min(new Set(wa).size, setB.size);
}

/** Is this transaction a plausible home for the alert at all? */
function eligible(alert, t) {
  if (!t || !t.transactionId || !t.date) return false;
  const amount = Number(t.amount);
  if (!Number.isFinite(amount) || amount === 0) return false;
  // A purchase lands negative and a refund positive. Matching across the sign
  // would put a coffee's category on the refund of a coffee machine.
  if (alert.refund ? amount < 0 : amount > 0) return false;
  return Math.abs(Math.abs(amount) - Number(alert.amount)) < 0.005;
}

/**
 * Score a candidate. Higher is better; the amount is already known to match,
 * so this is entirely about how believable the rest of it is.
 */
function score(alert, t, alertDay) {
  let points = 0;

  const day = dayNumber(t.date);
  if (alertDay != null && day != null) {
    const drift = day - alertDay;
    if (drift < -DAYS_EARLY || drift > DAYS_LATE) return null;
    // Same day is the common case and should win outright.
    points += Math.max(0, 6 - Math.abs(drift));
  }

  const sim = merchantSimilarity(
    alert.merchant,
    `${t.description || ''} ${t.fullDescription || ''}`,
  );
  points += sim * 10;

  // A card's last four, when both sides carry one, is near-proof.
  if (alert.card && t.account && String(t.account).includes(alert.card)) points += 4;

  return points;
}

/**
 * The transaction this alert belongs to, or null if it can't be told.
 *
 * @param {{amount:number, merchant?:string, card?:string, date?:string, receivedAt?:string, refund?:boolean}} alert
 * @param {Array} transactions
 * @returns {{transaction, score, runnerUp}|null}
 */
export function matchAlert(alert, transactions) {
  if (!alert || !Number.isFinite(Number(alert.amount))) return null;
  const alertDay = dayNumber(alert.date || alert.receivedAt);

  const scored = [];
  for (const t of transactions || []) {
    if (!eligible(alert, t)) continue;
    const s = score(alert, t, alertDay);
    if (s == null) continue;
    scored.push({ transaction: t, score: s });
  }
  if (!scored.length) return null;

  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;

  // Two transactions for the same amount in the same week — a pair of $4.50
  // coffees — and there is no honest way to say which is which. Better to ask.
  if (second && best.score - second.score < AMBIGUOUS_MARGIN) return null;

  return { transaction: best.transaction, score: best.score, runnerUp: second || null };
}

/**
 * Alerts whose transaction has now arrived, paired with it.
 *
 * Only alerts the user has actually decided a category for, and only where
 * the transaction is still uncategorized — a category set by hand on the row
 * itself is a later, better-informed decision than the one made at the till,
 * and must not be overwritten.
 */
export function pendingApplications(alerts, transactions) {
  const out = [];
  for (const alert of alerts || []) {
    if (!alert || !alert.category || alert.appliedTo || alert.dismissed) continue;
    const hit = matchAlert(alert, transactions);
    if (!hit) continue;
    const current = (hit.transaction.category || '').trim();
    if (current && current !== 'Uncategorized') continue;
    out.push({ alert, transaction: hit.transaction, category: alert.category });
  }
  return out;
}
