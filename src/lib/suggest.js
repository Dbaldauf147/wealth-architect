/* Category suggestions from the user's own history.

   The mobile categorizer lives or dies on this: if the top chip is right most
   of the time, clearing a backlog is a few dozen taps; if it isn't, the phone
   is a worse table than the table. So the ranking is deliberately conservative
   — it only proposes what the user has actually already decided themselves,
   never a hard-coded merchant list, and it says *why* so a wrong suggestion is
   obvious before it's tapped.

   Pure: no React, no DOM, no storage. */

import { normalizeDesc } from './categorize.js';

/* Tokens that appear in bank descriptions regardless of who the merchant is.
   Left in, they make every card-network transaction look similar to every
   other one. */
const NOISE_TOKENS = new Set([
  'pos', 'purchase', 'debit', 'credit', 'card', 'visa', 'mastercard', 'amex',
  'ach', 'ppd', 'des', 'id', 'indn', 'co', 'ref', 'trn', 'web', 'tel', 'recur',
  'recurring', 'payment', 'pmt', 'transaction', 'withdrawal', 'deposit', 'xfer',
  'transfer', 'from', 'to', 'the', 'and', 'of', 'llc', 'inc', 'ltd', 'corp',
  'com', 'www', 'http', 'https', 'usa', 'us', 'store', 'sq', 'tst', 'pp',
  'checkcard', 'ckcd', 'x', 'xx', 'xxx', 'xxxx',
]);

const isNoise = (tok) => (
  !tok
  || tok.length < 2
  || NOISE_TOKENS.has(tok)
  || /^\d+$/.test(tok)        // store numbers, terminal ids
  || /^\d/.test(tok)          // 4th-of-July style leading-digit junk
);

/* Split a description into the words that actually identify a merchant. */
export function merchantTokens(description) {
  const norm = normalizeDesc(description);
  if (!norm) return [];
  return norm
    .split(/[^a-z0-9]+/)
    .filter(tok => !isNoise(tok));
}

/* A stable-ish identity for "the same merchant". Two charges from the same
   place usually share their leading meaningful words even when the tail
   carries a store number or a city.

   Three words is precise but brittle — "SHELL OIL 5711" and "SHELL OIL 9987
   BROOKLYN NY" are plainly the same gas station and yet key differently, so
   every merchant is also indexed under a two-word key that survives a city or
   state getting appended. Lookups try the precise key first. */
export function merchantKey(description, depth = 3) {
  const toks = merchantTokens(description);
  if (!toks.length) return normalizeDesc(description);
  return toks.slice(0, depth).join(' ');
}

export const looseMerchantKey = (description) => merchantKey(description, 2);

/* The text to save as a rule for "always file this merchant here".

   A rule matches by plain substring (see ruleMatches), so unlike merchantKey —
   which reorders and drops words freely — this has to be a run of words that
   appears *verbatim* in descriptions of this merchant. It takes the first two
   consecutive clean, meaningful words: two is short enough to survive the store
   number, city, and card-network prefix that get bolted onto the same merchant
   from one charge to the next, and long enough not to match half the file.
   Punctuated words like "*eats" are skipped rather than included, since a
   sibling charge may not carry the punctuation. */
export function ruleDescriptionFor(description, maxWords = 2) {
  const norm = normalizeDesc(description);
  const words = norm.split(' ').filter(Boolean);
  let best = [];
  let run = [];
  for (const w of words) {
    if (/^[a-z][a-z0-9&']*$/.test(w) && !isNoise(w)) {
      run.push(w);
      if (run.length > best.length) best = [...run];
      if (best.length >= maxWords) break;
    } else {
      run = [];
    }
  }
  const out = best.slice(0, maxWords).join(' ');
  // Too short to be a safe filter — a two-letter rule would match everything.
  return out.length >= 3 ? out : '';
}

/* A short human label for the merchant, for "always categorize X as Y" copy. */
export function merchantLabel(t) {
  const desc = (t?.description || '').trim();
  if (desc) return desc.length > 34 ? `${desc.slice(0, 33)}…` : desc;
  return merchantKey(t?.fullDescription || '') || 'this transaction';
}

const isCategorized = (t) => !!t.category && t.category !== 'Uncategorized';

function daysBetween(aMs, bMs) {
  return Math.abs(aMs - bMs) / 86_400_000;
}

function timeOf(t) {
  const ms = new Date(t.date).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/* Weight a past decision by how long ago it was made. A category the user
   moved away from six months ago shouldn't outvote what they've been doing
   since; the half-life is generous (a year) so old-but-consistent history
   still counts for most of its worth. */
function recencyWeight(txnMs, nowMs) {
  if (!txnMs) return 0.5;
  const days = daysBetween(nowMs, txnMs);
  return 0.35 + 0.65 * Math.pow(0.5, days / 365);
}

/* An index over everything the user has already categorized. Built once per
   transaction list and reused for every card in the review deck — rebuilding
   it per card turned a 2,000-transaction history into a visible stutter. */
export function buildHistoryIndex(transactions, options) {
  const now = options?.now instanceof Date ? options.now.getTime() : Date.now();
  const byMerchant = new Map();   // merchantKey      -> Map(category -> weight)
  const byLoose = new Map();      // looseMerchantKey -> Map(category -> weight)
  const byToken = new Map();      // token            -> Map(category -> weight)
  const tokenDocs = new Map();    // token      -> how many merchants use it
  const categoryTotals = new Map();

  for (const t of transactions || []) {
    if (!isCategorized(t)) continue;
    const cat = t.category;
    const w = recencyWeight(timeOf(t), now);

    const desc = t.description || t.fullDescription || '';
    const key = merchantKey(desc);
    if (key) {
      let m = byMerchant.get(key);
      if (!m) byMerchant.set(key, (m = new Map()));
      m.set(cat, (m.get(cat) || 0) + w);
    }
    const loose = looseMerchantKey(desc);
    if (loose) {
      let m = byLoose.get(loose);
      if (!m) byLoose.set(loose, (m = new Map()));
      m.set(cat, (m.get(cat) || 0) + w);
    }

    for (const tok of new Set(merchantTokens(desc))) {
      let m = byToken.get(tok);
      if (!m) byToken.set(tok, (m = new Map()));
      m.set(cat, (m.get(cat) || 0) + w);
      tokenDocs.set(tok, (tokenDocs.get(tok) || 0) + 1);
    }

    categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + w);
  }

  return { byMerchant, byLoose, byToken, tokenDocs, categoryTotals, now, size: byMerchant.size };
}

const topEntry = (map) => {
  let bestKey = null;
  let bestVal = 0;
  let total = 0;
  for (const [k, v] of map) {
    total += v;
    if (v > bestVal) { bestVal = v; bestKey = k; }
  }
  return { key: bestKey, value: bestVal, total };
};

/* Rank the categories this transaction is most likely to belong to.

   Returns up to `limit` entries of
     { category, confidence: 0..1, reason: string, source: 'rule'|'merchant'|'similar'|'common' }
   ordered best-first. An empty array means we genuinely have nothing to go on,
   which the UI should show as "pick one" rather than a bad guess. */
export function suggestCategories(txn, index, options) {
  const limit = options?.limit ?? 3;
  const rules = options?.rules || null;
  const scores = new Map();       // category -> { score, reason, source }

  const bump = (cat, score, reason, source) => {
    if (!cat || cat === 'Uncategorized') return;
    const prev = scores.get(cat);
    if (!prev || score > prev.score) scores.set(cat, { score, reason, source });
  };

  const desc = txn?.description || txn?.fullDescription || '';

  // 1. An existing rule the user wrote is not a guess — it's an instruction.
  //    (The caller passes only rules that already match this transaction.)
  if (rules && rules.length) {
    bump(rules[0].category, 1, 'Matches a rule you saved', 'rule');
  }

  // 2. Same merchant, decided before. The strongest evidence we have. Fall
  //    back to the looser two-word key so an appended city still matches,
  //    at a discount since the looser key is likelier to over-group.
  const key = merchantKey(desc);
  let merchantHits = key ? index?.byMerchant?.get(key) : null;
  let precision = 1;
  if (!merchantHits || !merchantHits.size) {
    const loose = looseMerchantKey(desc);
    merchantHits = loose ? index?.byLoose?.get(loose) : null;
    precision = 0.85;
  }
  if (merchantHits && merchantHits.size) {
    const { key: cat, value, total } = topEntry(merchantHits);
    const share = total > 0 ? value / total : 0;
    // Confidence rises with agreement, and with having seen it more than once.
    const volume = Math.min(1, value / 2);
    bump(cat, precision * (0.55 + 0.4 * share * volume), share >= 0.999
      ? 'You always file this merchant here'
      : `You file this merchant here ${Math.round(share * 100)}% of the time`, 'merchant');
    // A genuine second opinion, when the user has split this merchant before.
    for (const [otherCat, v] of merchantHits) {
      if (otherCat === cat) continue;
      bump(otherCat, 0.3 * (v / (total || 1)), 'You have also used this for this merchant', 'merchant');
    }
  }

  // 3. Descriptions that merely share words. Rare tokens carry the signal —
  //    "starbucks" identifies a merchant, "market" is in half the file — so
  //    each token is discounted by how many merchants use it.
  const tokens = merchantTokens(desc);
  if (tokens.length && index?.byToken) {
    const tokenScores = new Map();
    const merchants = Math.max(1, index.size);
    for (const tok of new Set(tokens)) {
      const hits = index.byToken.get(tok);
      if (!hits) continue;
      const docs = index.tokenDocs.get(tok) || 1;
      const idf = Math.log(1 + merchants / docs);
      if (idf <= 0.05) continue; // token is everywhere; it identifies nothing
      const { total } = topEntry(hits);
      for (const [cat, v] of hits) {
        tokenScores.set(cat, (tokenScores.get(cat) || 0) + idf * (v / (total || 1)));
      }
    }
    if (tokenScores.size) {
      const { total } = topEntry(tokenScores);
      for (const [cat, v] of tokenScores) {
        const share = total > 0 ? v / total : 0;
        if (share < 0.15) continue;
        bump(cat, 0.2 + 0.35 * share, 'Similar descriptions go here', 'similar');
      }
    }
  }

  // 4. Nothing matched. Offer the categories this file mostly is — kept to
  //    two, and scored low on purpose, because the UI shows anything under
  //    LOW_CONFIDENCE as "most used" rather than as an answer. Three
  //    identical-looking chips that are really a shrug invite a wrong tap.
  if (!scores.size && index?.categoryTotals?.size) {
    const ranked = [...index.categoryTotals.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cat] of ranked.slice(0, 2)) {
      bump(cat, 0.1, 'One of your most-used categories', 'common');
    }
  }

  return [...scores.entries()]
    .map(([category, s]) => ({
      category,
      confidence: Math.max(0, Math.min(1, s.score)),
      reason: s.reason,
      source: s.source,
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

/* Every *other* transaction that looks like the same merchant. Drives the
   "also apply to the 7 others from here" affordance — the single biggest
   saving when clearing a backlog on a phone. */
export function findSameMerchant(txn, transactions, options) {
  const includeCategorized = options?.includeCategorized === true;
  const desc = txn?.description || txn?.fullDescription || '';
  const key = merchantKey(desc);
  const loose = looseMerchantKey(desc);
  if (!key) return [];
  const self = txn?.transactionId;
  return (transactions || []).filter(t => {
    if (t === txn) return false;
    if (self && t.transactionId === self) return false;
    if (!includeCategorized && isCategorized(t)) return false;
    const d = t.description || t.fullDescription || '';
    return merchantKey(d) === key || looseMerchantKey(d) === loose;
  });
}

/* Below this, a suggestion is a shrug rather than a finding, and the UI should
   present it as such. Exported so the threshold is stated once. */
export const LOW_CONFIDENCE = 0.2;
