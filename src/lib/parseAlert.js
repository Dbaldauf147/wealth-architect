/* Reading a bank's purchase alert.
 *
 * The text is the bank's, not ours, and every bank words it differently — so
 * this parses by shape rather than by template. Nearly all of them are the
 * same four facts in some order:
 *
 *     <bank>: A $24.31 purchase at DUNKIN #12345 on card ending in 4321 on 08/26/26
 *              ^amount      ^merchant              ^card                  ^date
 *
 * Anything it can't read comes back null rather than guessed. A half-read
 * alert is still useful — the amount alone is enough to match a transaction,
 * and the raw text is kept so a person can always see what actually arrived.
 *
 * Pure: no React, no DOM, no network. Runs in the browser and in the Vercel
 * function that receives the alert.
 */

// Alerts that aren't a purchase to categorize. A decline never becomes a
// transaction, and a balance or payment notice isn't spending — surfacing
// either as "what was this?" is noise the user has to dismiss forever.
const NOT_A_PURCHASE = [
  /\bdeclin(?:ed|e)\b/i,
  /\bwas not approved\b/i,
  /\bfraud\b/i,
  /\bpayment (?:received|posted|due|thank)/i,
  /\bminimum payment\b/i,
  /\bstatement (?:is|balance)\b/i,
  /\byour balance is\b/i,
  /\bavailable balance is\b/i,
  /\bdirect deposit\b/i,
  /\blow balance\b/i,
  /\bpassword\b|\bverification code\b|\bsecurity code\b|\bone.?time code\b/i,
];

// Money out vs money back. A refund still deserves a category — it lands in
// the ledger as a positive row against the same merchant — but the sign has
// to be right or it will never match.
const REFUND = /\brefund(?:ed)?\b|\bcredit(?:ed)? to your\b|\breturn(?:ed)?\b|\breversal\b/i;

/** The first dollar figure in the text. Later ones are usually the balance. */
function readAmount(text) {
  const m = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Last four of the card. Amex quotes five, so accept four or five. */
function readCard(text) {
  const patterns = [
    // Amex quotes a 15-digit card as "ending 1-23456" — a leading group, a
    // dash, then the part worth keeping.
    /ending\s*(?:in\s*)?[-–#]?\s*(?:\d+[-–])?(\d{4,5})\b/i,
    /\b(?:acct|account|card)\s*(?:#|no\.?|number)?\s*[-–]?\s*(\d{4,5})\b/i,
    /\bx{2,}\s*(\d{4})\b/i,
    /\*{2,}\s*(\d{4})\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

// Where the merchant stops. "at DUNKIN on 08/26" ends at " on "; "at DUNKIN."
// ends at the full stop. Ordered longest-first so " on card" doesn't get cut
// by " on " leaving a dangling word.
const MERCHANT_END = /\s+(?:on\s+card|on|for|using|with\s+card|from\s+your|was|has|is|at\s+\d)\b|[.;]|,\s*(?:and|on)\b|$/i;

/**
 * The merchant, as the bank wrote it.
 *
 * Introduced by "at", "with", or "to" in every format seen. Kept verbatim
 * rather than tidied: the store number in "DUNKIN #12345" is exactly what
 * makes it match the row the sheet will eventually carry.
 */
function readMerchant(text) {
  const intro = /\b(?:at|with|to)\s+/gi;
  let m;
  while ((m = intro.exec(text)) !== null) {
    const rest = text.slice(m.index + m[0].length);
    // "at 8:14 AM" and "to your card" are the preposition doing other work.
    if (/^(?:\d{1,2}[:.]\d{2}|your\b|the\b|a\b|an\b)/i.test(rest)) continue;
    const end = MERCHANT_END.exec(rest);
    const raw = (end ? rest.slice(0, end.index) : rest).trim();
    const cleaned = raw.replace(/[\s.,;:-]+$/, '').trim();
    if (cleaned.length >= 2) return cleaned;
  }
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The date the bank quotes, as YYYY-MM-DD.
 *
 * Two-digit years are read as 2000+, which is the only reading that makes
 * sense for a purchase alert. A year is often absent altogether ("on Aug 26"),
 * and rather than guess, that case returns null and the caller falls back to
 * the moment the alert arrived — which for a real-time alert is the same day.
 */
function readDate(text) {
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/.exec(text);
  if (slash) {
    const mo = Number(slash[1]);
    const day = Number(slash[2]);
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31 && slash[3]) {
      const y = slash[3].length === 2 ? 2000 + Number(slash[3]) : Number(slash[3]);
      return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  const named = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/.exec(text);
  if (named) {
    const mo = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase());
    const day = Number(named[2]);
    if (mo >= 0 && day >= 1 && day <= 31 && named[3]) {
      return `${Number(named[3])}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return null;
}

/** Whoever sent it, from the "Chase:" / "BofA:" opener. */
function readBank(text) {
  const m = /^\s*([A-Za-z][A-Za-z0-9 &.'-]{1,24}?)\s*:/.exec(text);
  if (!m) return null;
  return m[1].replace(/\b(alert|alerts|free msg|freemsg)\b/gi, '').replace(/\s{2,}/g, ' ').trim() || null;
}

/**
 * Read a purchase alert.
 *
 * @param {string} text The message exactly as it arrived.
 * @returns {{ok: boolean, reason?: string, amount, merchant, card, date, bank, refund, raw}}
 */
export function parseAlert(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { ok: false, reason: 'empty', raw: '' };

  for (const re of NOT_A_PURCHASE) {
    if (re.test(raw)) return { ok: false, reason: 'not-a-purchase', raw };
  }

  const amount = readAmount(raw);
  if (amount == null) return { ok: false, reason: 'no-amount', raw };

  return {
    ok: true,
    amount,
    merchant: readMerchant(raw),
    card: readCard(raw),
    date: readDate(raw),
    bank: readBank(raw),
    refund: REFUND.test(raw),
    raw,
  };
}
