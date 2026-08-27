// Receives a purchase alert from the phone, seconds after the card is used.
//
// Two things on iOS can call this, both Shortcuts personal automations:
//
//   · Message      — triggered by the bank's SMS. Posts { text } and this
//                    route reads the amount and merchant out of it.
//   · Transaction  — triggered by an Apple Pay tap. Posts the fields already
//                    structured, so nothing has to be parsed.
//
// Nothing here creates a transaction. The sheet stays the only source of rows;
// an alert is a note saying "this purchase happened, and here is what I said
// it was" that waits for the real row to arrive and then hands over its
// category. That is why an alert nobody categorizes costs nothing — it simply
// expires unread.
//
// The route exists on the server rather than being written from the page for
// the same reason api/rally-expense.js does: the shared secret must not sit in
// a browser bundle. A Shortcut is not a browser bundle, so it can hold one.
//
// Env:
//   SPEND_ALERT_SECRET            Shared secret; the Shortcut sends it as
//                                 x-ingest-secret. Without it the route is off.
//   FIREBASE_SERVICE_ACCOUNT_JSON Service account, same one the crons use.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { parseAlert } from '../src/lib/parseAlert.js';

const COLLECTION = 'spendAlerts';

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

function clean(value, max = 200) {
  return String(value == null ? '' : value).slice(0, max).trim();
}

/* A stable id, so the same alert arriving twice overwrites rather than doubles.
 *
 * A Shortcut that fires twice — a retried request, a message delivered to both
 * phone and iPad — produces byte-identical text within the same second. Hashing
 * the text with the hour it arrived collapses those into one document. Two
 * genuinely identical purchases in the same hour would collapse too; that is
 * the deliberate trade, and the second one is not lost, it just goes through
 * the review deck the ordinary way. */
function alertId(signature, receivedAt) {
  const hour = receivedAt.slice(0, 13); // YYYY-MM-DDTHH
  let h = 5381;
  const s = `${signature}|${hour}`;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `a${h.toString(36)}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.SPEND_ALERT_SECRET;
  if (!secret) {
    return res.status(503).json({
      error: 'Purchase alerts are not switched on. Set SPEND_ALERT_SECRET.',
    });
  }
  // Anyone who can guess the URL could otherwise post junk into the review
  // queue. Compared as given — this gates writes to a private queue, not money.
  const offered = req.headers['x-ingest-secret'];
  if (offered !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const receivedAt = new Date().toISOString();
  const source = body.source === 'wallet' ? 'wallet' : 'sms';

  let amount;
  let merchant;
  let card;
  let date;
  let bank;
  let refund = false;
  let raw = clean(body.text, 500);

  if (source === 'wallet') {
    // Apple Wallet hands over structured fields; nothing to read out of prose.
    amount = Math.abs(Number(body.amount));
    merchant = clean(body.merchant, 120) || null;
    card = clean(body.card, 10) || null;
    date = clean(body.date, 40) || null;
    bank = clean(body.bank, 60) || null;
    raw = raw || [merchant, body.amount].filter(Boolean).join(' · ');
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
  } else {
    if (!raw) return res.status(400).json({ error: 'text is required' });
    const parsed = parseAlert(raw);
    if (!parsed.ok) {
      // A decline or a balance notice is not a failure — the automation fires
      // on every message from the bank and most of them are not purchases.
      // 200 so the Shortcut doesn't report an error the user must go and read.
      return res.status(200).json({ ignored: true, reason: parsed.reason });
    }
    ({ amount, merchant, card, date, bank, refund } = parsed);
  }

  const record = {
    source,
    amount,
    merchant: merchant || null,
    card: card || null,
    // The bank's own date when it quoted one; otherwise the moment it arrived,
    // which for a real-time alert is the same day.
    date: date || receivedAt.slice(0, 10),
    quotedDate: date || null,
    bank: bank || null,
    refund: !!refund,
    raw,
    receivedAt,
    category: null,
    appliedTo: null,
    dismissed: false,
  };

  try {
    const db = getFirestoreDb();
    if (!db) return res.status(500).json({ error: 'Missing FIREBASE_SERVICE_ACCOUNT_JSON' });

    const signature = `${record.amount}|${record.merchant || ''}|${record.raw}`;
    const id = alertId(signature, receivedAt);
    // merge:true so a re-post can't wipe a category the user has already
    // chosen on this alert between the two deliveries.
    await db.collection(COLLECTION).doc(id).set(record, { merge: true });

    return res.status(200).json({
      ok: true,
      id,
      amount: record.amount,
      merchant: record.merchant,
      date: record.date,
    });
  } catch (err) {
    console.error('spend-alert failed:', err);
    return res.status(500).json({ error: 'Could not save the alert' });
  }
}
