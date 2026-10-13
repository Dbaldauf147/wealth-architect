// Receives Amazon order, shipment and refund emails from a Google Apps Script
// running in the user's own Gmail (scripts/amazon-gmail.gs), and folds each
// one into an order record in Firestore `amazonOrders`.
//
// Like api/spend-alert.js, nothing here creates or changes a transaction. An
// order is a note about what a charge bought; the page joins it to the card
// row by amount and uses the items to suggest a category in the review deck.
//
// Parsing happens here, not in the script, so a change in Amazon's wording is
// fixed by a deploy rather than by asking the user to re-paste the script. And
// only the parsed facts are stored — order number, totals, item names — never
// the body, which carries a name and a shipping address into a collection the
// page can read without signing in.
//
// Request:  POST { emails: [{ id, subject, from, date, body }] }
//           header x-ingest-secret. ?dry=1 parses and reports without writing.
// Response: { ok, saved, orders: [...ids], ignored: [{ id, reason }] }
//
// Env:
//   AMAZON_EMAIL_SECRET           Shared secret the script sends. Falls back to
//                                 SPEND_ALERT_SECRET so no new value is needed.
//   FIREBASE_SERVICE_ACCOUNT_JSON Service account, same one the crons use.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { parseAmazonEmail, mergeAmazonOrder } from '../src/lib/parseAmazonEmail.js';

const COLLECTION = 'amazonOrders';
const MAX_EMAILS = 100;
const MAX_BODY = 40000;

function getFirestoreDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
    initializeApp({ credential: cert(parsed) });
  }
  return getFirestore();
}

const clean = (value, max) => String(value == null ? '' : value).slice(0, max);

// Gmail message ids are hex; anything else is reduced to something safe as a
// Firestore map key.
const emailKey = (id) => `m${clean(id, 64).replace(/[^A-Za-z0-9]/g, '')}`;

/* The email's text as the parser saw it, links removed — returned by a dry
 * run only, for an email it read no items from, so a layout Amazon has
 * changed can be seen and fixed. Never stored. */
function textSample(body) {
  return String(body || '')
    .replace(/<https?:[^>]*>|\(https?:[^)]*\)|https?:\/\/\S+/gi, ' ')
    .split(/\r?\n/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 150)
    .map(l => l.slice(0, 160));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.AMAZON_EMAIL_SECRET || process.env.SPEND_ALERT_SECRET;
  if (!secret) {
    return res.status(503).json({
      error: 'Amazon email import is not switched on. Set AMAZON_EMAIL_SECRET (or SPEND_ALERT_SECRET).',
    });
  }
  if (req.headers['x-ingest-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const emails = Array.isArray(body.emails) ? body.emails.slice(0, MAX_EMAILS) : [];
  if (!emails.length) return res.status(400).json({ error: 'emails[] is required' });
  const dry = req.query?.dry === '1' || body.dry === true;

  const ignored = [];
  const parsedByOrder = new Map(); // orderId -> [{ parsed, key }]
  const samples = [];
  for (const e of emails) {
    const id = clean(e?.id, 64);
    const parsed = parseAmazonEmail({
      subject: clean(e?.subject, 500),
      from: clean(e?.from, 200),
      date: clean(e?.date, 60),
      body: clean(e?.body, MAX_BODY),
    });
    if (!parsed.ok) { ignored.push({ id, reason: parsed.reason }); continue; }
    if (dry && !parsed.items.length) {
      samples.push({ id, subject: clean(e?.subject, 500), lines: textSample(clean(e?.body, MAX_BODY)) });
    }
    const list = parsedByOrder.get(parsed.orderId) || [];
    list.push({ parsed, key: emailKey(id || `${parsed.kind}${parsed.date}${parsed.total}`) });
    parsedByOrder.set(parsed.orderId, list);
  }

  if (dry) {
    return res.status(200).json({
      ok: true,
      dry: true,
      parsed: [...parsedByOrder.values()].flat().map(p => p.parsed),
      ignored,
      noItemsRead: samples,
    });
  }

  try {
    const db = getFirestoreDb();
    if (!db) return res.status(500).json({ error: 'Missing FIREBASE_SERVICE_ACCOUNT_JSON' });

    const now = new Date().toISOString();
    for (const [orderId, list] of parsedByOrder) {
      const ref = db.collection(COLLECTION).doc(orderId);
      // Read-merge-write in a transaction: the hourly run and a backfill can
      // both be posting emails about the same order at once.
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        let next = snap.exists ? snap.data() : null;
        for (const { parsed, key } of list) next = mergeAmazonOrder(next, parsed, key);
        tx.set(ref, { ...next, updatedAt: now });
      });
    }

    return res.status(200).json({
      ok: true,
      saved: [...parsedByOrder.values()].reduce((n, l) => n + l.length, 0),
      orders: [...parsedByOrder.keys()],
      ignored,
    });
  } catch (err) {
    console.error('amazon-email failed:', err);
    return res.status(500).json({ error: 'Could not save the orders' });
  }
}
