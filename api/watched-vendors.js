// Daily email of new transactions at vendors flagged on the Transactions page.
//
// Reads the watch rules (config/default → watchedVendors), runs them against
// the sheet with the same rules, overrides and hidden rows the website applies,
// and emails every matching transaction it hasn't seen before — once each.
//
// What it has seen lives per rule in watchedVendorSeen/{ruleId}
// ({ signature, seen: [txnKey...] }), outside config/default for the same
// reason vendorAlertSends does: the website writes that doc back whole, so a
// field the server put there would be wiped by the next save from any device.
// A rule it has never seen, or one whose filters changed, is baselined without
// an email (see newFlaggedTransactions), so flagging a vendor doesn't mail its
// whole history.
//
// Query:
//   ?dry=1   report what would be sent, without emailing or recording
//
// Env (all already used by the other crons):
//   FIREBASE_SERVICE_ACCOUNT_JSON, SHEETS_API_KEY, SHEETS_SHEET_ID,
//   GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_TO (optional), CRON_SECRET (optional),
//   PUBLIC_SITE_URL (optional)

import nodemailer from 'nodemailer';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  applyRulesToTransactions,
  applySubcategoryRulesToTransactions,
  applyOverrides,
} from '../src/lib/categorize.js';
import {
  newFlaggedTransactions,
  renderWatchedVendorEmail,
  watchStateDocId,
} from '../src/lib/watchedVendors.js';

const SEEN = 'watchedVendorSeen';

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

async function fetchTransactionsFromSheet() {
  const apiKey = process.env.SHEETS_API_KEY;
  const sheetId = process.env.SHEETS_SHEET_ID;
  if (!apiKey || !sheetId) throw new Error('Missing SHEETS_API_KEY or SHEETS_SHEET_ID env var');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent('Transactions')}!B1:O10000?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
  const data = await res.json();
  const rows = data.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return {
      date: obj['Date'] || '',
      description: obj['Description'] || '',
      category: obj['Category'] || '',
      amount: parseFloat((obj['Amount'] || '0').replace(/[$,]/g, '')) || 0,
      account: obj['Account'] || '',
      institution: obj['Institution'] || '',
      transactionId: obj['Transaction ID'] || '',
      fullDescription: obj['Full Description'] || '',
    };
  }).filter(t => t.date && t.description);
}

export default async function handler(req, res) {
  // Vercel signs cron invocations when CRON_SECRET is set; without it the
  // route is open, which is tolerable because a repeat call sends nothing new.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const dry = req.query?.dry === '1' || req.query?.dry === 'true';

  try {
    const db = getFirestoreDb();
    if (!db) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON env var');

    const snap = await db.collection('config').doc('default').get();
    const config = (snap.exists && snap.data()) || {};
    const rules = Array.isArray(config.watchedVendors) ? config.watchedVendors : [];
    if (!rules.length) return res.status(200).json({ skipped: true, reason: 'No flagged vendors' });

    let transactions = await fetchTransactionsFromSheet();
    transactions = applyRulesToTransactions(transactions, config.categoryRules || []);
    transactions = applySubcategoryRulesToTransactions(transactions, config.subcategoryRules || []);
    transactions = applyOverrides(
      transactions,
      config.categoryOverrides || {},
      config.subcategoryOverrides || {},
      config.dateOverrides || {},
    );
    const hidden = new Set(Array.isArray(config.hiddenTransactionIds) ? config.hiddenTransactionIds : []);
    if (hidden.size) transactions = transactions.filter(t => !hidden.has(t.transactionId));

    const stateSnaps = await Promise.all(rules.filter(r => r && r.id).map(r => db.collection(SEEN).doc(watchStateDocId(r)).get()));
    const state = new Map();
    for (const s of stateSnaps) {
      if (!s.exists) continue;
      const d = s.data() || {};
      if (d.ruleId) state.set(d.ruleId, { signature: d.signature, seen: Array.isArray(d.seen) ? d.seen : [] });
    }

    const { notify, nextState, baselined } = newFlaggedTransactions(rules, transactions, state);
    const summary = {
      rules: rules.length,
      baselined,
      newTransactions: notify.map(n => ({ vendor: n.rule.description, count: n.transactions.length })),
    };
    if (dry) return res.status(200).json({ sent: false, dry: true, ...summary });

    let sent = false;
    let to = null;
    let subject = null;
    if (notify.length) {
      const user = process.env.GMAIL_USER;
      const pass = process.env.GMAIL_APP_PASSWORD;
      if (!user || !pass) throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD env var');
      to = process.env.EMAIL_TO || user;
      const rendered = renderWatchedVendorEmail(notify, {
        siteUrl: process.env.PUBLIC_SITE_URL || 'https://wealth-architect-delta.vercel.app',
      });
      subject = rendered.subject;
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass },
      });
      await transporter.sendMail({ from: `"Wealth Architect" <${user}>`, to, subject, html: rendered.html });
      sent = true;
    }

    // Recorded only after the send succeeds (a throw above skips this), so a
    // failed send retries tomorrow instead of being marked seen.
    const updatedAt = new Date().toISOString();
    const batch = db.batch();
    for (const rule of rules) {
      const next = rule && nextState.get(rule.id);
      if (!next) continue;
      batch.set(db.collection(SEEN).doc(watchStateDocId(rule)), {
        ruleId: rule.id, signature: next.signature, seen: next.seen, updatedAt,
      });
    }
    await batch.commit().catch(err => {
      // The email went; at worst tomorrow's run repeats it.
      console.warn('watched-vendors seen record failed:', err?.message || err);
    });

    return res.status(200).json({ sent, to, subject, ...summary });
  } catch (err) {
    console.error('watched-vendors error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
