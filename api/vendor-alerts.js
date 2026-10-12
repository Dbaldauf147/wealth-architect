// Daily check of the vendor spend alerts set on the Spending Trends page.
//
// Reads the rules from config/default, evaluates them against the sheet with
// the same rules, overrides and hidden rows the website applies, and sends one
// email covering every alert crossed since the last run. Each send is recorded
// in its own collection (vendorAlertSends) so an alert emails once per period —
// or once per purchase for a per-purchase rule — however many times this runs.
//
// That record lives outside config/default for the same reason
// paymentReminders does: the website writes that doc back whole, so a field the
// server put there would be wiped by the next save from any device.
//
// Query:
//   ?dry=1   evaluate and report what would be sent, without emailing or recording
//
// Env (all already used by the other crons):
//   FIREBASE_SERVICE_ACCOUNT_JSON, SHEETS_API_KEY, SHEETS_SHEET_ID,
//   GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_TO (optional), CRON_SECRET (optional),
//   VENDOR_ALERT_TZ (optional, default America/New_York), PUBLIC_SITE_URL (optional)

import nodemailer from 'nodemailer';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  applyRulesToTransactions,
  applySubcategoryRulesToTransactions,
  applyOverrides,
} from '../src/lib/categorize.js';
import {
  evaluateVendorAlerts,
  pendingSends,
  renderVendorAlertEmail,
  todayIn,
} from '../src/lib/vendorAlerts.js';

const SENDS = 'vendorAlertSends';

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
    const rules = Array.isArray(config.vendorAlerts) ? config.vendorAlerts : [];
    if (!rules.length) return res.status(200).json({ skipped: true, reason: 'No vendor alerts set' });

    let transactions = await fetchTransactionsFromSheet();
    transactions = applyRulesToTransactions(transactions, config.categoryRules || []);
    transactions = applySubcategoryRulesToTransactions(transactions, config.subcategoryRules || []);
    transactions = applyOverrides(
      transactions,
      config.categoryOverrides || {},
      config.subcategoryOverrides || {},
      config.dateOverrides || {},
    );
    // Rows hidden on the Transactions page are hidden from the page's alerts
    // too; the email has to agree with what the page shows.
    const hidden = new Set(Array.isArray(config.hiddenTransactionIds) ? config.hiddenTransactionIds : []);
    if (hidden.size) transactions = transactions.filter(t => !hidden.has(t.transactionId));

    const today = todayIn(process.env.VENDOR_ALERT_TZ || 'America/New_York');
    const results = evaluateVendorAlerts(rules, transactions, today);

    const sentSnap = await db.collection(SENDS).select().get();
    const sent = new Set(sentSnap.docs.map(d => d.id));
    const pending = pendingSends(results, sent);

    const summary = results.map(r => ({
      vendor: r.rule.vendor, period: r.rule.period, threshold: r.threshold,
      spent: Math.round(r.spent * 100) / 100, crossed: r.crossed, email: r.rule.email !== false,
    }));
    if (dry || !pending.length) {
      return res.status(200).json({ sent: false, dry, today, pending: pending.map(p => p.sendKeys).flat(), alerts: summary });
    }

    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD env var');
    const to = process.env.EMAIL_TO || user;

    const { subject, html } = renderVendorAlertEmail(pending, {
      siteUrl: process.env.PUBLIC_SITE_URL || 'https://wealth-architect-delta.vercel.app',
    });
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass },
    });
    await transporter.sendMail({ from: `"Wealth Architect" <${user}>`, to, subject, html });

    // Recorded only after the send succeeds: a failed send retries tomorrow
    // instead of being marked done.
    const sentAt = new Date().toISOString();
    const batch = db.batch();
    for (const p of pending) {
      for (const key of p.sendKeys) {
        batch.set(db.collection(SENDS).doc(key), {
          ruleId: p.result.rule.id,
          vendor: p.result.rule.vendor,
          period: p.result.rule.period,
          threshold: p.result.threshold,
          spent: p.result.spent,
          sentAt,
        });
      }
    }
    await batch.commit().catch(err => {
      // The email went; at worst tomorrow's run repeats it.
      console.warn('vendor-alerts send record failed:', err?.message || err);
    });

    return res.status(200).json({ sent: true, to, subject, today, alerts: summary });
  } catch (err) {
    console.error('vendor-alerts error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
