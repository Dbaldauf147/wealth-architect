// Daily check: has this month's spending passed the income it's expected to
// bring in? Emails once a month, the first run that finds it over.
//
// Expected income is the same line the Overshot chart draws on the month in
// progress (lib/overIncomeAlert): income in so far, counted as Cash Flow
// counts it, plus the paychecks still due on the Commissions tab's pay
// schedule. Spending is the month's spending so far, also as Cash Flow
// counts it. The ledger gets the same rules, overrides and hidden rows the
// website applies (as api/watched-vendors does).
//
// The send is recorded in overIncomeAlerts/{YYYY-MM}, written only here
// through the Admin SDK, so a month is emailed once however many runs see it
// over. A month that dips back under and over again isn't emailed twice.
//
// If the Prospect Tracker can't be read, nothing is sent: without the
// month-end commission the expected income would be understated and the
// email would be a false alarm.
//
// Query:
//   ?dry=1   report the numbers and what would be sent, without emailing or recording
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
import { currentMonthProjection, renderOverIncomeEmail } from '../src/lib/overIncomeAlert.js';
import { readTrackerCommissions } from './_lib/trackerCommissions.js';

const SENT = 'overIncomeAlerts';

function getFirestoreDb() {
  if (!getApps().some(a => a.name === '[DEFAULT]')) {
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
      accountNum: obj['Account #'] || '',
      institution: obj['Institution'] || '',
      transactionId: obj['Transaction ID'] || '',
      fullDescription: obj['Full Description'] || '',
    };
  }).filter(t => t.date && t.description);
}

// The month and day in the owner's time zone: the cron runs in UTC.
function easternNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12);
}

export default async function handler(req, res) {
  // Vercel signs cron invocations when CRON_SECRET is set; without it the
  // route is open, which is tolerable because a month is only emailed once.
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

    let commissions;
    try { commissions = await readTrackerCommissions(); }
    catch (err) {
      console.warn('over-income-alert: tracker unreadable:', err?.message || err);
      return res.status(200).json({ sent: false, skipped: true, reason: 'The Prospect Tracker could not be read, so expected income is unknown' });
    }

    const today = easternNow();
    const p = currentMonthProjection({
      transactions,
      incomeCategories: Array.isArray(config.incomeCategories) ? config.incomeCategories : [],
      commissions,
      today,
    });
    if (!p) return res.status(200).json({ sent: false, skipped: true, reason: 'No pay schedule to project this month’s income from' });

    const numbers = {
      month: p.key, spending: p.spending, incomeSoFar: p.income, stillDue: p.stillDue,
      expectedIncome: p.projected, over: p.over, gap: p.gap,
    };
    if (!p.over) return res.status(200).json({ sent: false, ...numbers });

    const ref = db.collection(SENT).doc(p.key);
    const prior = await ref.get();
    if (prior.exists) return res.status(200).json({ sent: false, alreadySent: prior.data()?.sentAt || true, ...numbers });

    const rendered = renderOverIncomeEmail(p, {
      siteUrl: process.env.PUBLIC_SITE_URL || 'https://wealth-architect-delta.vercel.app',
      today,
    });
    if (dry) return res.status(200).json({ sent: false, dry: true, subject: rendered.subject, ...numbers });

    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD env var');
    const to = process.env.EMAIL_TO || user;
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass },
    });
    await transporter.sendMail({ from: `"Wealth Architect" <${user}>`, to, subject: rendered.subject, html: rendered.html });

    // Recorded only after the send succeeds, so a failed send retries tomorrow.
    await ref.set({ sentAt: new Date().toISOString(), ...numbers }).catch(err => {
      console.warn('over-income-alert record failed:', err?.message || err);
    });

    return res.status(200).json({ sent: true, to, subject: rendered.subject, ...numbers });
  } catch (err) {
    console.error('over-income-alert error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
