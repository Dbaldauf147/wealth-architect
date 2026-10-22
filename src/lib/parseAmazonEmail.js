/* Reading an Amazon order email.
 *
 * The card statement says "AMAZON MKTPL*2K4AB" for a phone charger and for a
 * month of groceries alike, so the merchant tells you nothing about what a
 * charge was for. The email Amazon sent about it does. This pulls the three
 * facts worth keeping out of one:
 *
 *     the order number   112-1234567-1234567   — the key every email shares
 *     the amount         Grand Total: $45.67   — what the card will be charged
 *     the items          "Anker USB-C Cable"   — what the money bought
 *
 * Amazon's wording drifts every year or so and differs between the order,
 * shipment and refund emails, so like parseAlert this reads by shape rather
 * than by template, and anything it can't find comes back null rather than
 * guessed. Only those facts leave this module — the body also carries a
 * shipping address and a name, and none of that is stored.
 *
 * Pure: no network, no storage. Runs in the Vercel function that receives the
 * email, and in tests.
 */

const ORDER_ID = /\b([0-9D]\d{2}-\d{7}-\d{7})\b/;

// A dollar figure. Amazon writes "$12.99" in older mail and "12.99 USD" in
// newer; either way two decimals, which keeps quantities and ids out.
// The 2026 layout also drops a trailing zero — "20.1 USD" for $20.10 — so one
// decimal counts too, but only with "USD" after it, which keeps "1.5 lb" out.
const MONEY = /(?:\$\s?|USD\s?)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2}|\.\d(?=\s?USD)))(?:\s?USD)?/;
const MONEY_LINE = /^(?:\$\s?|USD\s?)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2}|\.\d(?=\s?USD)))(?:\s?USD)?$/i;

// Totals, most specific first. "Total before tax" is not what gets charged,
// and "Subtotal" never matches \btotal\b, which is what keeps it out.
const TOTAL_LABELS = {
  refund: [/\brefund total\b/i, /\btotal refund(?: amount)?\b/i, /\brefund (?:amount|subtotal)\b/i, /\byour refund of\b/i, /\brefund of\b/i],
  // Only a figure that is the shipment's own. A shipment email quoting the
  // order total says nothing about what this box was charged.
  shipment: [/\bshipment total\b/i, /\btotal for this shipment\b/i],
  order: [/\bgrand total\b/i, /\border total\b/i, /\btotal for this order\b/i, /\btotal charged\b/i],
};
const GENERIC_TOTAL = /\btotal\b(?!\s+before)(?!\s+savings)/i;

// Whole Foods delivery, ordered through Amazon. The card is charged the order
// less the driver tip, and the tip posts on its own as "Amazon Tips*…", so the
// tip is worth reading out. "Tip" alone only counts at the start of a line.
// Only Whole Foods' own order mail: its subject says "Whole Foods Market
// order" and its text opens with the store's name. Ordinary Amazon mail can
// name Whole Foods near the top too (a banner, a "365 by Whole Foods" item),
// and reading that as a grocery order filed a voice recorder under Groceries.
const GROCERY_SUBJECT = /whole\s*foods\s*market\s+order/i;
const GROCERY_HEAD = /^\s*whole\s*foods\s*market\s*$/i;
const GROCERY_ITEM = 'Whole Foods groceries';
const TIP_LABELS = [/\b(?:driver|delivery|courier|shopper)\s+tip\b/i, /^\s*tip\b/im];

// Lines that are the email's furniture rather than something that was bought.
const NOT_AN_ITEM = /^(?:order|orders|ship|shipped|shipping|deliver|delivered|delivery|arriving|arrives|estimated|total|grand total|subtotal|items?\(s\)|tax|estimated tax|quantity|qty|sold by|condition|view|track|return|refund|payment|hi|hello|thanks|thank you|your|manage|buy again|questions|price|amount|gift)\b/i;

// The kinds of email worth reading. Cancellations, delivery photos and
// "rate your purchase" notes carry no charge and get ignored.
function kindOf(subject, from) {
  const s = subject || '';
  const f = (from || '').toLowerCase();
  if (/cancel/i.test(s)) return null;
  if (/refund/i.test(s) || (/return@/.test(f) && /refund/i.test(s))) return 'refund';
  if (/^\s*(?:shipped|delivered|out for delivery)\b|has shipped|have shipped|is on the way|shipment/i.test(s)) return 'shipment';
  if (/^\s*ordered\b|your amazon(?:\.com)? order|order confirmation|your order of|thanks for your order|your order #/i.test(s)) return 'order';
  if (/shipment-tracking@/.test(f)) return 'shipment';
  if (/auto-confirm@|digital-no-reply@/.test(f)) return 'order';
  return null;
}

function toNumber(s) {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** The first figure within a short reach after a label — same line or the next. */
function amountAfterLabel(text, label) {
  const re = new RegExp(label.source, `${label.flags.replace('g', '')}g`);
  let m;
  while ((m = re.exec(text))) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
    const money = MONEY.exec(after);
    // A figure separated from the label by more words is some other line's.
    if (money && /^[\s:*\-–—]*(?:\(?[a-z ]{0,20}\)?[\s:]*)?$/i.test(after.slice(0, money.index))) {
      const n = toNumber(money[1]);
      if (n != null && n > 0) return n;
    }
  }
  return null;
}

function findTotal(text, kind) {
  for (const label of TOTAL_LABELS[kind] || []) {
    const n = amountAfterLabel(text, label);
    if (n != null) return n;
  }
  // A shipment email with no shipment total carries no charge of its own —
  // falling back to a bare "Total" there would usually read the order's.
  if (kind === 'shipment') return null;
  return amountAfterLabel(text, GENERIC_TOTAL);
}

function stripLinks(s) {
  return String(s || '')
    .replace(/<https?:[^>]*>/gi, ' ')
    .replace(/\(https?:[^)]*\)/gi, ' ')
    .replace(/\[https?:[^\]]*\]/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ');
}

export function cleanItemName(s) {
  return stripLinks(s)
    .replace(/^[\s*•·\-–—>]+/, '')
    // A refund email brackets the name: "[MURLONG Sponge Holder...]"
    .replace(/^\[([^\]]*)\]$/, '$1')
    .replace(/\s*(?:\.{3}|…)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function plausibleItem(name) {
  if (!name || name.length < 3) return false;
  if (MONEY_LINE.test(name)) return false;
  if (NOT_AN_ITEM.test(name)) return false;
  if (ORDER_ID.test(name)) return false;
  if (!/[a-z]{2}/i.test(name)) return false;
  return true;
}

/**
 * What the subject says was bought, in either of Amazon's two styles:
 *
 *   Ordered: "Anker USB C Cable..." and 2 more items   — the first item, quoted
 *   Delivered 2 items: Supplements, Tea                — Amazon's own labels
 *
 * The second is the 2026 layout, whose body carries no product names at all —
 * they are only in the pictures — so the labels are all there is. They suit
 * the job anyway: "Tea" is worded the same on every order, so it is learnt
 * from fast.
 */
const SUBJECT_VERB = String.raw`^\s*(?:ordered|shipped|delivered|out for delivery|arriving[^:]*)`;
// "Delivered 2 items: Supplements, Tea"
const LABELS_AFTER = new RegExp(`${SUBJECT_VERB}\\s+\\d+\\s+items?\\s*:\\s*(.+)$`, 'i');
// "Shipped: 1 Pantry item", "Ordered: 9 Kitchen, Nutrition & Wellness, and other items"
const LABELS_BETWEEN = new RegExp(`${SUBJECT_VERB}\\s*:?\\s+\\d+\\s+(.+?)\\s+items?\\s*$`, 'i');

function subjectItems(subject) {
  const quoted = /["“]([^"”]{3,})["”]/.exec(subject || '');
  if (quoted) return [cleanItemName(quoted[1])];
  const labelled = LABELS_AFTER.exec(subject || '') || LABELS_BETWEEN.exec(subject || '');
  if (!labelled) return [];
  return labelled[1]
    .replace(/\s*(?:,\s*)?(?:and\s+(?:\d+\s+)?more(?:\s+items?)?|and\s+other|\.{3}|…)\s*$/i, '')
    .split(/\s*,\s*/)
    .map(cleanItemName)
    .filter(plausibleItem);
}

/**
 * The email cut into one stretch per order it mentions.
 *
 * One checkout that Amazon splits into several orders gets one confirmation
 * listing each in turn — "Order # A … Grand Total: 68.97 … Order # B … Grand
 * Total: 20.10" — so each order's total is the one after its own number, not
 * the first in the email. A number repeated straight after itself (the line,
 * then its link) is the same stretch.
 */
function orderBlocks(body) {
  const re = new RegExp(ORDER_ID.source, 'g');
  const hits = [];
  let m;
  while ((m = re.exec(body))) {
    if (hits.length && hits[hits.length - 1].id === m[1]) continue;
    hits.push({ id: m[1], at: m.index });
  }
  return hits.map((h, i) => ({ id: h.id, text: body.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : body.length) }));
}

/** Items in the body: the line above each "Quantity: 1" or "Sold by:". */
function bodyItems(body) {
  const lines = stripLinks(body).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!/^(?:quantity|qty)\s*:?\s*\d+|^sold by\b/i.test(lines[i])) continue;
    // The name sits directly above, unless a price line got there first.
    let j = i - 1;
    while (j >= 0 && j >= i - 3 && (MONEY_LINE.test(lines[j]) || /^(?:quantity|qty|sold by|condition)\b/i.test(lines[j]))) j -= 1;
    if (j < 0) continue;
    const name = cleanItemName(lines[j]);
    if (!plausibleItem(name)) continue;
    let price = null;
    for (let k = i - 1; k <= Math.min(lines.length - 1, i + 3); k++) {
      if (k === j) continue;
      const m = MONEY_LINE.exec(lines[k]);
      if (m) { price = toNumber(m[1]); break; }
    }
    out.push({ name, price });
  }
  return out;
}

const keyOf = (name) => cleanItemName(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Union two item lists, treating a name that is a prefix of another as the
 * same item — the subject's "Anker USB C Cable" is the body's "Anker USB C
 * Cable, 6ft, 2-Pack" cut short.
 */
export function mergeItems(a, b, max = 25) {
  const out = [];
  for (const item of [...(a || []), ...(b || [])]) {
    if (!item || !item.name) continue;
    const k = keyOf(item.name);
    if (!k) continue;
    const same = out.findIndex(o => {
      const ok = keyOf(o.name);
      return ok === k || ok.startsWith(k) || k.startsWith(ok);
    });
    if (same === -1) {
      out.push({ name: item.name, price: item.price ?? null });
      continue;
    }
    const prev = out[same];
    out[same] = {
      name: keyOf(item.name).length > keyOf(prev.name).length ? item.name : prev.name,
      price: prev.price ?? item.price ?? null,
    };
  }
  return out.slice(0, max);
}

function isoDay(date) {
  const d = date ? new Date(date) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Every order an email is about — usually one, several when a single checkout
 * was split into orders.
 *
 * @param {{subject?:string, from?:string, body?:string, date?:string}} email
 * @returns {{ok:true, orders:Array<{ok:true, kind:'order'|'shipment'|'refund', orderId:string, total:number|null, items:Array<{name:string, price:number|null}>, date:string|null}>}
 *          | {ok:false, reason:string}}
 */
export function parseAmazonEmailOrders(email) {
  const subject = String(email?.subject || '');
  const from = String(email?.from || '');
  const body = String(email?.body || '');

  if (from && !/amazon\.|wholefoods/i.test(from)) return { ok: false, reason: 'not from Amazon' };

  // A Whole Foods email about an order is read as the order whatever its
  // subject says: the one sent after delivery carries the final total, which
  // is what the card is charged once weighed items and substitutions settle.
  const firstLine = (stripLinks(body).split(/\r?\n/).find(l => l.trim()) || '');
  const grocery = GROCERY_SUBJECT.test(subject) || GROCERY_HEAD.test(firstLine);
  let kind = kindOf(subject, from);
  if (grocery && kind !== 'refund' && !/cancel/i.test(subject)) kind = 'order';
  if (!kind) return { ok: false, reason: 'not an order, shipment or refund email' };
  const groceryFacts = () => {
    if (!grocery) return {};
    let tip = null;
    for (const label of TIP_LABELS) if (tip == null) tip = amountAfterLabel(body, label);
    return { grocery: true, tip };
  };
  // Whole Foods mail names no items at all. One stand-in gives the popup
  // something to say and the Review deck a word to learn the category from.
  const groceryItems = (items) => (grocery && !items.length ? [{ name: GROCERY_ITEM, price: null }] : items);

  const date = isoDay(email?.date);
  const blocks = orderBlocks(body);
  const ids = [...new Set(blocks.map(b => b.id))];

  if (ids.length <= 1) {
    const id = ORDER_ID.exec(subject) || ORDER_ID.exec(body);
    if (!id) return { ok: false, reason: 'no order number' };
    // The whole body: a refund quotes its total before the order number.
    // The subject quotes the first item cut short, sometimes reworded. When the
    // body lists the items properly it is only ever a worse copy of one of them.
    const listed = bodyItems(body);
    const fromSubject = listed.length ? [] : subjectItems(subject);
    const items = groceryItems(mergeItems(listed, fromSubject.map(name => ({ name, price: null }))));
    return { ok: true, orders: [{ ok: true, kind, orderId: id[1], total: findTotal(body, kind), items, date, ...groceryFacts() }] };
  }

  // Several orders. The subject's labels span all of them and can't be shared
  // out, so each order keeps only what its own stretch lists; its shipment
  // emails, one per order, bring the labels.
  return {
    ok: true,
    orders: ids.map(id => {
      const own = blocks.filter(b => b.id === id);
      let total = null;
      let items = [];
      for (const b of own) {
        if (total == null) total = findTotal(b.text, kind);
        items = mergeItems(items, bodyItems(b.text));
      }
      return { ok: true, kind, orderId: id, total, items: groceryItems(items), date, ...groceryFacts() };
    }),
  };
}

/**
 * Is this a Whole Foods delivery? Whole Foods mail never names a product, so
 * an order that lists real items is an ordinary Amazon order whatever its
 * flag says: orders saved before the detection was tightened carry the flag.
 */
export function isGroceryOrder(order) {
  return !!order?.grocery && (order.items || []).every(i => i?.name === GROCERY_ITEM);
}

/** The first order an email is about — see parseAmazonEmailOrders for all of them. */
export function parseAmazonEmail(email) {
  const r = parseAmazonEmailOrders(email);
  return r.ok ? r.orders[0] : r;
}

/**
 * Fold one parsed email into the stored order.
 *
 * Every email about an order lands on the same document, in whatever order
 * Gmail hands them over, and the same email may arrive twice. So each fact is
 * kept where a repeat overwrites rather than adds: the order total is a single
 * field, and each shipment or refund is keyed by the email it came from.
 *
 * @param {object|null} existing  the stored order, or null for a new one
 * @param {object} parsed         a successful parseAmazonEmail result
 * @param {string} emailKey       a stable id for the email (Gmail's message id)
 */
export function mergeAmazonOrder(existing, parsed, emailKey) {
  const prev = existing || {};
  const next = {
    orderId: parsed.orderId,
    orderDate: prev.orderDate || null,
    total: prev.total ?? null,
    items: mergeItems(prev.items, parsed.items),
    shipments: { ...(prev.shipments || {}) },
    refunds: { ...(prev.refunds || {}) },
  };

  // The earliest email is the closest to when the order was placed, and the
  // card is never charged before it — which is the anchor matching wants.
  if (parsed.date && (!next.orderDate || parsed.date < next.orderDate)) next.orderDate = parsed.date;

  // A grocery order's emails quote an estimate first and the final charge
  // after delivery, so the latest one wins; any other order's total is fixed.
  // A stored order flagged grocery that lists real products was flagged by
  // the older, looser test; the next email about it puts that right.
  if (parsed.grocery || (prev.grocery && isGroceryOrder({ grocery: true, items: next.items }))) {
    next.grocery = true;
    next.totalDate = prev.totalDate ?? null;
    next.tip = parsed.tip ?? prev.tip ?? null;
    if (parsed.kind === 'order' && parsed.total != null && (!next.totalDate || !parsed.date || parsed.date >= next.totalDate)) {
      next.total = parsed.total;
      next.totalDate = parsed.date || next.totalDate;
    }
  } else if (parsed.kind === 'order' && parsed.total != null) next.total = parsed.total;
  if (parsed.kind === 'shipment' && parsed.total != null) {
    next.shipments[emailKey] = { total: parsed.total, date: parsed.date };
  }
  if (parsed.kind === 'refund' && parsed.total != null) {
    next.refunds[emailKey] = { total: parsed.total, date: parsed.date };
  }
  return next;
}
