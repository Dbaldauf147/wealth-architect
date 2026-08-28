/* Card promotions — the credits and benefits a card gives back, and how much
   of each has actually been used.

   Extracted from CardPromosPage so the weekly email can report the same
   numbers the page shows. Pure: no React, no DOM, no localStorage, and every
   "now" arrives as an argument, so the Vercel Function and the tests can both
   ask what a promo looked like at a given moment. */

/* ── Seed data: Chase Sapphire Reserve benefits ── */
export const SEED_PROMOS = [
  {
    id: 'seed-csr-travel',
    card: 'Chase Sapphire Reserve',
    name: '$300 Annual Travel Credit',
    value: 300,
    used: 0,
    period: 'annual',
    matchSubcategory: 'Travel Credit',
    notes: 'Auto-applied to anything Chase codes as travel — NYC MTA, Citi Bike, rideshare, tolls, parking, hotels, airlines.',
    color: '#0058be',
  },
  {
    id: 'seed-csr-lyft',
    card: 'Chase Sapphire Reserve',
    name: '$10 Monthly Lyft Credit',
    value: 10,
    used: 0,
    period: 'monthly',
    notes: 'Through March 2027. Activated in Lyft app with Chase card set as default.',
    color: '#0058be',
  },
  {
    id: 'seed-csr-doordash',
    card: 'Chase Sapphire Reserve',
    name: 'DoorDash DashPass',
    value: 120,
    used: 0,
    period: 'annual',
    notes: 'Free DashPass membership through 2027, plus monthly dining/grocery credits.',
    color: '#0058be',
  },
  {
    id: 'seed-csr-global-entry',
    card: 'Chase Sapphire Reserve',
    name: 'Global Entry / TSA PreCheck',
    value: 120,
    used: 0,
    period: 'annual',
    notes: 'Up to $120 statement credit every 4 years for application fee.',
    color: '#0058be',
  },
  {
    id: 'seed-csr-pp',
    card: 'Chase Sapphire Reserve',
    name: 'Priority Pass Select',
    value: 469,
    used: 0,
    period: 'annual',
    notes: 'Complimentary Priority Pass lounge access (1,300+ airport lounges worldwide).',
    color: '#0058be',
  },
];

/** Inclusive start of the cycle a promo is currently in, or null for a
 *  one-time benefit (which has no window — once used, it stays used). */
export function periodWindowStart(period, asOf = new Date()) {
  const now = asOf instanceof Date ? asOf : new Date(asOf);
  if (period === 'monthly') return new Date(now.getFullYear(), now.getMonth(), 1);
  if (period === 'quarterly') {
    const q = Math.floor(now.getMonth() / 3);
    return new Date(now.getFullYear(), q * 3, 1);
  }
  if (period === 'annual') return new Date(now.getFullYear(), 0, 1);
  return null;
}

function parseISODate(s) {
  if (!s) return null;
  const d = new Date(String(s).slice(0, 10) + 'T00:00:00');
  return isNaN(d) ? null : d;
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

/** A promo counts as manually completed only if it was marked within the
 *  CURRENT cycle — so a monthly credit ticked in July shows up unused again in
 *  August. One-time promos have no window, so they stay completed once marked. */
export function isPromoCompleted(p, asOf = new Date()) {
  if (!p || !p.completedAt) return false;
  const start = periodWindowStart(p.period, asOf);
  if (!start) return true;
  const d = parseISODate(p.completedAt);
  return d ? d >= start : true;
}

function normalizeDesc(s) {
  return (s || '').toLowerCase().trim().replace(/[\s\-–—]+/g, ' ');
}

export function promoHasAutoMatch(p) {
  if (!p) return false;
  return !!((p.matchSubcategory || '').trim() || (p.matchCategory || '').trim() || (p.matchDescription || '').trim());
}

/** OR semantics across the three match fields: a transaction qualifies if it
 *  matches ANY of the populated criteria. Description match uses the same
 *  bidirectional contains check the auto-categorization rules use. */
export function transactionMatchesPromo(t, promo) {
  if (!t || !promo) return false;
  const wantSub = (promo.matchSubcategory || '').trim().toLowerCase();
  const wantCat = (promo.matchCategory || '').trim().toLowerCase();
  const wantDesc = normalizeDesc(promo.matchDescription);
  if (!wantSub && !wantCat && !wantDesc) return false;
  if (wantSub && (t.subcategory || '').toLowerCase() === wantSub) return true;
  if (wantCat && (t.category || '').toLowerCase() === wantCat) return true;
  if (wantDesc) {
    const txnDesc = normalizeDesc(t.description);
    const txnFull = normalizeDesc(t.fullDescription);
    if (txnDesc && (txnDesc.includes(wantDesc) || wantDesc.includes(txnDesc))) return true;
    if (txnFull && txnFull.includes(wantDesc)) return true;
  }
  return false;
}

/** Every transaction a promo's match rules claim, newest first, across all
 *  history — not just the current cycle. The cycle bound belongs to the
 *  "how much is used" question; "when did I last touch this benefit" is a
 *  different question and a monthly credit that went unused this month is
 *  exactly when the last-used date is worth seeing. */
export function matchingTransactions(promo, transactions) {
  if (!promoHasAutoMatch(promo)) return [];
  const out = [];
  for (const t of transactions || []) {
    const amt = Number(t.amount) || 0;
    if (amt === 0) continue;
    if (!transactionMatchesPromo(t, promo)) continue;
    const d = parseDate(t.date);
    if (!d) continue;
    out.push({ ...t, _date: d });
  }
  out.sort((a, b) => b._date - a._date);
  return out;
}

/** Spend counted against a promo in its current cycle, or null when the promo
 *  has no match rules and is therefore tracked by hand.
 *
 *  Absolute value on purpose, so the rule works in either direction: tag the
 *  original travel CHARGE (negative) to track redeemable spend, or tag the
 *  statement CREDIT (positive) to track the actual redemption. */
export function autoUsedForPromo(promo, transactions, asOf = new Date()) {
  if (!promoHasAutoMatch(promo)) return null;
  if (!transactions || transactions.length === 0) return 0;
  const start = periodWindowStart(promo.period, asOf);
  let sum = 0;
  for (const t of transactions) {
    const amt = Number(t.amount) || 0;
    if (amt === 0) continue;
    if (start) {
      const d = parseDate(t.date);
      if (!d || d < start) continue;
    }
    if (!transactionMatchesPromo(t, promo)) continue;
    sum += Math.abs(amt);
  }
  return sum;
}

/** How much of a promo is used, in the same priority order the page applies:
 *    1. manually marked complete this cycle → the full value
 *    2. auto-tracked from transactions when a match field is set
 *    3. the manual "used" number the user typed */
export function effectiveUsedFor(promo, transactions, asOf = new Date()) {
  if (isPromoCompleted(promo, asOf)) return Number(promo.value) || 0;
  const auto = autoUsedForPromo(promo, transactions, asOf);
  return auto != null ? auto : (Number(promo.used) || 0);
}

/** Roll the promo list up for reporting: per-promo progress with the most
 *  recent qualifying transaction, plus totals across everything.
 *
 *  `limit` caps how many promos come back in `items` (the rest are counted in
 *  `moreCount`), because this feeds an email and not a page. Promos are ranked
 *  by how much value is still on the table, so the ones worth acting on this
 *  week sort to the top and a fully-used credit doesn't crowd them out. */
export function summarizeCardPromos({ promos, transactions, asOf = new Date(), limit = 8 }) {
  const list = Array.isArray(promos) ? promos : [];
  const rows = list.map((p) => {
    const value = Number(p.value) || 0;
    const used = effectiveUsedFor(p, transactions, asOf);
    const matches = matchingTransactions(p, transactions);
    const last = matches[0] || null;
    const cycleStart = periodWindowStart(p.period, asOf);
    return {
      id: p.id,
      card: p.card || '',
      name: p.name || 'Untitled promo',
      period: p.period || 'one-time',
      color: p.color || null,
      value,
      used,
      // Never report more used than the promo is worth — a $300 credit with
      // $900 of matching travel is used up, not 300% used.
      remaining: Math.max(0, value - Math.min(used, value)),
      completed: isPromoCompleted(p, asOf),
      tracked: promoHasAutoMatch(p),
      matchCount: matches.length,
      lastTransaction: last
        ? {
            date: last._date.toISOString(),
            description: last.description || '',
            amount: Math.abs(Number(last.amount) || 0),
            account: last.account || '',
            // Whether that last hit counts toward the cycle showing above, so
            // the email can distinguish "used this month" from "last used in May".
            inCurrentCycle: cycleStart ? last._date >= cycleStart : true,
          }
        : null,
    };
  });

  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const totalUsed = rows.reduce((s, r) => s + Math.min(r.used, r.value), 0);

  const ranked = [...rows].sort((a, b) => {
    // Most left on the table first; ties broken by the bigger benefit.
    if (b.remaining !== a.remaining) return b.remaining - a.remaining;
    return b.value - a.value;
  });

  return {
    totalValue,
    totalUsed,
    remaining: totalValue - totalUsed,
    pct: totalValue > 0 ? totalUsed / totalValue : 0,
    count: rows.length,
    completedCount: rows.filter(r => r.completed).length,
    items: ranked.slice(0, limit),
    moreCount: Math.max(0, ranked.length - limit),
  };
}
