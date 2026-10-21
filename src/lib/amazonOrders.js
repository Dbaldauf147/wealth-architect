/* Joining Amazon orders to the card charges they became, and learning from
 * what they bought.
 *
 * Every Amazon charge reads "AMAZON MKTPL*something", so the merchant history
 * that suggest.js leans on is useless here — it can only ever say "you file
 * Amazon under Shopping most of the time". The order email knows the charge
 * was dish soap. Once an order is joined to its row, the items' words become
 * the evidence instead.
 *
 * The amount is the key, as it is for purchase alerts (see alertMatch.js), and
 * for the same reason: it is exact to the cent and neither side rewrites it.
 * Amazon charges per shipment rather than per order, which gives three shapes:
 *
 *   · a shipment email that quotes its own total — that figure is the charge
 *   · one shipment — the order total is the charge
 *   · several shipments with no totals quoted — two or three charges that add
 *     up to the order total
 *
 * A wrong join only ever costs a bad suggestion, never a written category —
 * but a suggestion that is confidently about someone else's order is how a
 * wrong tap happens, so an ambiguous join is still left alone.
 *
 * Pure: no React, no DOM, no storage.
 */

import { dayNumber } from './alertMatch.js';

/** Is this row an Amazon charge or refund? */
export function isAmazonCharge(t) {
  const s = `${t?.description || ''} ${t?.fullDescription || ''}`.toLowerCase();
  if (!/\bamazon\b|\bamzn\b/.test(s)) return false;
  // Same parent, no order emails: groceries and cloud bills. And buying the
  // stock — "Buy 1.25 shares … AMZN" names Amazon without being a purchase
  // from it.
  return !/whole\s?foods|amazon web services|\baws\b|\bshares?\b/.test(s);
}

const cents = (x) => Math.round(Math.abs(Number(x)) * 100);

// Amazon charges when a shipment leaves, which for a backorder or a
// pre-order can be weeks after the order. Refunds post within days.
const WINDOWS = {
  order: { early: 2, late: 21 },
  shipment: { early: 2, late: 10 },
  refund: { early: 2, late: 14 },
};

// A second candidate this many days nearer than the first is too close to call.
const AMBIGUOUS_DAYS = 3;

// A split order is found by trying sums of charges; past this many in the
// window the combinations stop being believable as one order anyway.
const MAX_SPLIT_POOL = 40;

function targetsFor(order) {
  const out = [];
  const orderDay = dayNumber(order.orderDate);
  const shipments = Object.values(order.shipments || {}).filter(s => Number(s?.total) > 0);
  for (const s of shipments) {
    out.push({ order, c: cents(s.total), day: dayNumber(s.date) ?? orderDay, out: true, via: 'shipment' });
  }
  if (!shipments.length && Number(order.total) > 0) {
    out.push({ order, c: cents(order.total), day: orderDay, out: true, via: 'order' });
  }
  for (const r of Object.values(order.refunds || {})) {
    if (Number(r?.total) > 0) {
      out.push({ order, c: cents(r.total), day: dayNumber(r.date) ?? orderDay, out: false, via: 'refund' });
    }
  }
  return out.filter(t => t.day != null && t.c > 0);
}

function inWindow(entry, target) {
  const w = WINDOWS[target.via] || WINDOWS.order;
  const drift = entry.day - target.day;
  return drift >= -w.early && drift <= w.late;
}

/**
 * Which order each Amazon row belongs to.
 *
 * @param {Array} orders        stored amazonOrders documents
 * @param {Array} transactions
 * @returns {Map<string, {order:object, via:'order'|'shipment'|'refund'|'split'}>} keyed by transactionId
 */
export function matchAmazonOrders(orders, transactions) {
  const matches = new Map();
  if (!orders?.length || !transactions?.length) return matches;

  const pool = [];
  const byCents = new Map();
  for (const t of transactions) {
    if (!t?.transactionId || !t.date || !isAmazonCharge(t)) continue;
    const amount = Number(t.amount);
    const day = dayNumber(t.date);
    if (!Number.isFinite(amount) || amount === 0 || day == null) continue;
    const entry = { t, day, c: cents(amount), out: amount < 0 };
    pool.push(entry);
    const list = byCents.get(entry.c);
    if (list) list.push(entry);
    else byCents.set(entry.c, [entry]);
  }
  if (!pool.length) return matches;

  const claimed = new Set();
  const claim = (entry, order, via) => {
    claimed.add(entry.t.transactionId);
    matches.set(entry.t.transactionId, { order, via });
  };

  const targets = orders.flatMap(targetsFor).sort((a, b) => a.day - b.day);

  // One charge for one figure. Run over every order before any splitting, so a
  // sum of small charges can't take a row that was a clean single match.
  const unmatched = [];
  for (const target of targets) {
    const candidates = (byCents.get(target.c) || [])
      .filter(e => e.out === target.out && !claimed.has(e.t.transactionId) && inWindow(e, target))
      .sort((a, b) => Math.abs(a.day - target.day) - Math.abs(b.day - target.day));
    const [best, second] = candidates;
    if (best && (!second || Math.abs(second.day - target.day) - Math.abs(best.day - target.day) >= AMBIGUOUS_DAYS)) {
      claim(best, target.order, target.via);
    } else if (!best && target.via === 'order') {
      unmatched.push(target);
    }
  }

  // An order shipped in pieces: two or three charges that add up to its total.
  for (const target of unmatched) {
    const near = pool
      .filter(e => e.out && !claimed.has(e.t.transactionId) && e.c < target.c && inWindow(e, target))
      .slice(0, MAX_SPLIT_POOL);
    const combos = [];
    for (let i = 0; i < near.length && combos.length < 2; i++) {
      for (let j = i + 1; j < near.length && combos.length < 2; j++) {
        const two = near[i].c + near[j].c;
        if (two === target.c) { combos.push([near[i], near[j]]); continue; }
        if (two > target.c) continue;
        for (let k = j + 1; k < near.length && combos.length < 2; k++) {
          if (two + near[k].c === target.c) combos.push([near[i], near[j], near[k]]);
        }
      }
    }
    // Two different ways to make the total is no way at all.
    if (combos.length === 1) for (const e of combos[0]) claim(e, target.order, 'split');
  }

  return matches;
}

// Words that describe how a product is sold, not what it is.
const ITEM_NOISE = new Set([
  'and', 'the', 'for', 'with', 'from', 'pack', 'packs', 'count', 'set', 'sets', 'pcs', 'piece', 'pieces',
  'inch', 'inches', 'ounce', 'ounces', 'pound', 'pounds', 'lbs', 'size', 'sizes', 'color', 'colors',
  'black', 'white', 'grey', 'gray', 'blue', 'red', 'green', 'pink', 'brown', 'beige', 'clear', 'silver',
  'new', 'compatible', 'premium', 'large', 'small', 'medium', 'extra', 'mens', 'womens', 'men', 'women',
  'amazon', 'basics', 'brand', 'value', 'bulk', 'each', 'per', 'total', 'includes', 'durable', 'portable',
  'quality', 'design', 'style', 'original', 'version', 'model', 'upgraded', 'heavy', 'duty', 'free',
]);

/** The words in an item name that say what it is. */
export function itemTokens(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(w => w.length >= 3 && !ITEM_NOISE.has(w));
}

function orderTokens(order) {
  const set = new Set();
  for (const item of order?.items || []) for (const tok of itemTokens(item.name)) set.add(tok);
  return set;
}

const isCategorized = (t) => !!t?.category && t.category !== 'Uncategorized';

/**
 * Item words → the categories the user filed them under, learned from every
 * Amazon row that is both joined to an order and already categorized. A
 * backfill of past emails is what makes this useful on day one: last year's
 * categorized Amazon rows become the history.
 */
export function buildItemIndex(transactions, matches) {
  const byToken = new Map();   // token -> Map(category -> weight)
  const tokenDocs = new Map(); // token -> orders using it
  let size = 0;
  for (const t of transactions || []) {
    if (!isCategorized(t)) continue;
    const hit = matches?.get(t.transactionId);
    if (!hit) continue;
    const tokens = orderTokens(hit.order);
    if (!tokens.size) continue;
    size += 1;
    for (const tok of tokens) {
      let m = byToken.get(tok);
      if (!m) byToken.set(tok, (m = new Map()));
      m.set(t.category, (m.get(t.category) || 0) + 1);
      tokenDocs.set(tok, (tokenDocs.get(tok) || 0) + 1);
    }
  }
  return { byToken, tokenDocs, size };
}

/**
 * Categories for an order, from past orders that bought the same kind of
 * thing. Same shape as suggestCategories so the deck can show them as-is:
 *   { category, confidence, reason, source: 'items' }
 */
export function suggestFromItems(order, index, options) {
  const limit = options?.limit ?? 3;
  if (!order || !index?.size) return [];
  const scores = new Map(); // category -> { score, words: [{tok, weight}] }
  let evidence = 0;
  for (const tok of orderTokens(order)) {
    const hits = index.byToken.get(tok);
    if (!hits) continue;
    const docs = index.tokenDocs.get(tok) || 1;
    // A word on most past orders identifies nothing.
    const idf = Math.log(1 + index.size / docs);
    if (idf <= 0.1) continue;
    let total = 0;
    for (const v of hits.values()) total += v;
    for (const [cat, v] of hits) {
      const weight = idf * (v / total);
      const s = scores.get(cat) || { score: 0, words: [] };
      s.score += weight;
      s.words.push({ tok, weight });
      scores.set(cat, s);
    }
    evidence += idf;
  }
  if (!scores.size) return [];

  let sum = 0;
  for (const s of scores.values()) sum += s.score;
  // A single shared word is a hint; several are a finding.
  const strength = Math.min(1, evidence / 3);
  return [...scores.entries()]
    .map(([category, s]) => {
      const share = s.score / sum;
      const words = s.words.sort((a, b) => b.weight - a.weight).slice(0, 2).map(w => `“${w.tok}”`);
      return {
        category,
        share,
        confidence: Math.max(0, Math.min(0.95, (0.25 + 0.65 * share) * (0.55 + 0.45 * strength))),
        reason: `Past Amazon orders with ${words.join(' and ')} went here`,
        source: 'items',
      };
    })
    .filter(s => s.share >= 0.15 && s.category !== 'Uncategorized')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit)
    .map(s => ({ category: s.category, confidence: s.confidence, reason: s.reason, source: s.source }));
}

/**
 * Put the item evidence ahead of the merchant evidence. For an Amazon row the
 * merchant can only say "Amazon is usually Shopping"; the items say what this
 * charge actually was, so they lead even at a lower confidence.
 */
export function withItemSuggestions(itemSuggestions, baseSuggestions, limit = 3) {
  const out = [...(itemSuggestions || [])];
  for (const s of baseSuggestions || []) {
    if (!out.some(o => o.category === s.category)) out.push(s);
  }
  return out.slice(0, limit);
}

/** "Anker USB-C Cable · Dish Soap +2 more" — for a card, not a receipt. */
export function itemSummary(order, max = 2) {
  const names = (order?.items || []).map(i => i.name).filter(Boolean);
  if (!names.length) return '';
  const short = names.slice(0, max).map(n => (n.length > 48 ? `${n.slice(0, 47)}…` : n));
  const rest = names.length - short.length;
  return rest > 0 ? `${short.join(' · ')} +${rest} more` : short.join(' · ');
}

const usd = (x) => `$${Math.abs(Number(x)).toFixed(2)}`;

/**
 * Why a row is joined to its order, in words — for the flag on the desktop
 * Transactions table. Every join is on the exact amount, so this says which
 * figure in the email it was.
 */
export function describeAmazonMatch(match) {
  const order = match?.order;
  if (!order) return '';
  const id = order.orderId ? `Amazon order ${order.orderId}` : 'an Amazon order';
  switch (match.via) {
    case 'shipment': return `Exact amount matched to a shipment email for ${id} (from Gmail)`;
    case 'refund': return `Exact amount matched to a refund email for ${id} (from Gmail)`;
    case 'split': return `One of several charges that add up exactly to the ${usd(order.total)} total of ${id} (from Gmail)`;
    default: return `Exact amount matched to the order total of ${id} (from Gmail)`;
  }
}

/** Amazon's order page, for an id in its usual 3-7-7 form. */
export function amazonOrderUrl(order) {
  const id = String(order?.orderId || '');
  return /^[A-Z0-9]{3}-\d{7}-\d{7}$/.test(id)
    ? `https://www.amazon.com/gp/your-account/order-details?orderID=${id}`
    : '';
}
