import nodemailer from 'nodemailer';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { buildWeeklySummary, lastCompletedWeek } from '../src/lib/weeklySummary.js';
import { renderWeeklyEmailHtml } from '../src/lib/renderWeeklyEmail.js';
import {
  applyRulesToTransactions,
  applySubcategoryRulesToTransactions,
  applyOverrides,
} from '../src/lib/categorize.js';

const DAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// Lazy singleton — Vercel may reuse the function instance across invocations.
function getFirestoreDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
    initializeApp({ credential: cert(parsed) });
  }
  return getFirestore();
}

async function fetchCategoryConfig() {
  const db = getFirestoreDb();
  if (!db) return null;
  try {
    const snap = await db.collection('config').doc('default').get();
    if (!snap.exists) return null;
    return snap.data() || null;
  } catch (err) {
    console.warn('Firestore config fetch failed:', err.message);
    return null;
  }
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
    };
  }).filter(t => t.date && t.description);
}

function inTodayInZone(zone = 'America/New_York') {
  // Returns the local weekday (0=Sun..6=Sat) in the given TZ
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' });
  const name = f.format(new Date()).toLowerCase();
  return DAY_MAP[name.slice(0, 3)] ?? 0;
}

export default async function handler(req, res) {
  try {
    const isTest = req.query?.test === '1' || req.query?.test === 'true';
    const recipientOverride = req.body?.recipient;

    // Cron-invoked calls come as GET from Vercel. If not a test, gate on day-of-week.
    if (!isTest) {
      const configuredDay = (process.env.WEEKLY_EMAIL_DAY || 'sun').toLowerCase().slice(0, 3);
      const configuredIdx = DAY_MAP[configuredDay];
      const todayIdx = inTodayInZone(process.env.WEEKLY_EMAIL_TZ || 'America/New_York');
      if (configuredIdx !== todayIdx) {
        return res.status(200).json({ skipped: true, reason: `Today (${todayIdx}) != configured (${configuredIdx})` });
      }
    }

    const rawTransactions = await fetchTransactionsFromSheet();

    // Apply the same category rules + per-transaction overrides the website
    // applies, so the email reflects the same categorized view.
    const config = await fetchCategoryConfig();
    let transactions = rawTransactions;
    if (config) {
      transactions = applyRulesToTransactions(transactions, config.categoryRules || []);
      transactions = applySubcategoryRulesToTransactions(transactions, config.subcategoryRules || []);
      transactions = applyOverrides(
        transactions,
        config.categoryOverrides || {},
        config.subcategoryOverrides || {},
        {}, // dateOverrides not synced yet
      );
    }

    const { start, end } = lastCompletedWeek();
    const summary = buildWeeklySummary({ transactions, start, end });
    const html = renderWeeklyEmailHtml(summary);

    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    const to = recipientOverride || process.env.EMAIL_TO || user;
    if (!user || !pass) throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD env var');

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
    });

    const subject = isTest
      ? `[Test] Weekly Spending Summary — ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : `Weekly Spending Summary — ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

    await transporter.sendMail({
      from: `"Wealth Architect" <${user}>`,
      to,
      subject,
      html,
    });

    return res.status(200).json({
      sent: true,
      to,
      range: { start: start.toISOString(), end: end.toISOString() },
      transactionCount: summary.transactionCount,
    });
  } catch (err) {
    console.error('weekly-summary error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
