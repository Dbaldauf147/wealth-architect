/* Matching eating-out charges to Prep Day spots.

   A card statement names the merchant the way the payment processor files
   it: "TST*FEED AND GRAIN", "SQ *COPPER MUG COFFEE", "DD *DOORDASH NARACHICK",
   "TST* RADEGAST HALL AND BI" — a processor prefix, then the name, often cut
   off mid-word. A Prep Day spot is "Radegast Hall & Biergarten".

   So a merchant is reduced to a key (prefix, store numbers and city tail
   stripped), and a spot matches when one name, squeezed of spaces and
   punctuation, starts with the other — that survives the truncation — or
   failing that, by how many words they share.

   Once you've matched a merchant by hand, that's remembered as a rule keyed
   by the same merchant key, so the next charge from it needs no guessing.

   Pure: no React, no network. */

// Processor and wallet prefixes, longest first so "DD *DOORDASH" beats "DD *".
const PREFIXES = [
  /^dd \*doordash\s*/, /^doordash\*?\s*/, /^dd \*\s*/,
  /^tst\*\s*/, /^sq \*\s*/, /^sq\*\s*/, /^fsp\*\s*/, /^sp \*?\s*/, /^pp\*\s*/,
  /^paypal \*\s*/, /^py \*\s*/, /^grubhub\*?\s*/, /^ubr\* ?eats\s*/, /^uber \*?eats\s*/,
  /^toast\*?\s*/, /^clover\*?\s*/, /^bt\*\s*/, /^ckt\*\s*/,
];

/** "TST* RADEGAST HALL AND BI" → "radegast hall and bi". */
export function merchantKey(description) {
  let s = String(description || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const p of PREFIXES) {
    if (p.test(s)) { s = s.replace(p, ''); break; }
  }
  return s
    .replace(/(^|\s)(x+\d+|#\s?\d+|\d{3,})\b.*$/, '') // store numbers and whatever follows
    .replace(/,.*$/, '')                          // "uber, *trip" / ", city st"
    .replace(/\s+-\s+.*$/, '')                    // "abe's pagoda bar - 1"
    .replace(/[^a-z0-9&' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const squeeze = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const STOP = new Set(['the', 'and', 'cafe', 'restaurant', 'bar', 'grill', 'kitchen', 'nyc', 'new', 'york']);
const words = s => new Set(String(s || '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)));

/** 0–1: how well a merchant key names a spot. */
export function nameScore(key, placeName) {
  const a = squeeze(key);
  const b = squeeze(placeName);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // One starts with the other: the bank truncated it, or the spot's name is
  // the short form. Needs enough letters that "bar" doesn't match "barbuto".
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 5 && long.startsWith(short)) return 0.9;
  const A = words(key);
  const B = words(placeName);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if ([...B].some(v => v === w || (w.length >= 4 && (v.startsWith(w) || w.startsWith(v))))) hit++;
  return 0.8 * (hit / Math.max(A.size, B.size));
}

export const SUGGEST_MIN = 0.5;

/**
 * The spot a charge most likely belongs to.
 * @returns { place, via: 'rule' | 'name', score } or null
 */
export function suggestPlace(description, places, rules = {}) {
  const key = merchantKey(description);
  const rule = key && rules[key];
  if (rule) {
    const place = places.find(p => p.id === rule.placeId);
    if (place) return { place, via: 'rule', score: 1 };
  }
  let best = null;
  for (const p of places) {
    const score = nameScore(key, p.name);
    if (score >= SUGGEST_MIN && (!best || score > best.score)) best = { place: p, via: 'name', score };
  }
  return best;
}

// Bars tend to be filed as Alcohol; a liquor-store charge that lands here is one
// click to Ignore, which beats the bar visits never showing up.
const EATING_OUT = /restaurant|dining|food|coffee|cafe|bar|alcohol|drinks|fast food|takeout|delivery/i;

/** A charge (not a refund) in a category that reads as eating out. */
export function isEatingOutCharge(t) {
  return Number(t.amount) < 0 && EATING_OUT.test(t.category || '');
}

/** "2026-09-22" for the ledger's "9/22/2026" — what Prep Day stores. */
export function isoDay(dateStr) {
  const s = String(dateStr || '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return '';
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
