import nodemailer from 'nodemailer';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { buildPaymentReminder, renderPaymentReminderHtml } from '../src/lib/paymentReminder.js';
import {
  applyRulesToTransactions,
  applySubcategoryRulesToTransactions,
  applyOverrides,
} from '../src/lib/categorize.js';

// Same tolerant card-name parser the Cards Optimizer uses to dedup the
// Balances feed. Kept inline (instead of imported from CardsPage) so this
// function stays free of any client-only dependencies.
function parseAccountName(s) {
  const lower = (s || '').toLowerCase();
  const digitMatch = lower.match(/\d{4,}(?!.*\d)/);
  const digits = digitMatch ? digitMatch[0].slice(-4) : '';
  const core = lower
    .replace(/[(){}\[\],./\\_*×-]+/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\bx+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const full = digits ? `${core}#${digits}` : core;
  return { full, core, digits };
}

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

async function fetchConfig() {
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

async function fetchSheet(tabName, range) {
  const apiKey = process.env.SHEETS_API_KEY;
  const sheetId = process.env.SHEETS_SHEET_ID;
  if (!apiKey || !sheetId) throw new Error('Missing SHEETS_API_KEY or SHEETS_SHEET_ID env var');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!${range}?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
  const data = await res.json();
  return data.values || [];
}

async function fetchTransactionsFromSheet() {
  const rows = await fetchSheet('Transactions', 'B1:O10000');
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

function parseMoney(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,]/g, '')) || 0;
}

// Mirror src/utils/sheets.js#fetchBalances on the server. Kept inline to
// avoid pulling client-only imports through the dependency tree.
async function fetchBalancesFromSheet() {
  const rows = await fetchSheet('Balances', 'A1:H50');
  let netWorth = 0, totalAssets = 0, totalLiabilities = 0;
  const assets = [], liabilities = [];
  let section = null;
  for (const row of rows) {
    const colB = (row[1] || '').trim();
    const colC = (row[2] || '').trim();
    const colD = (row[3] || '').trim();
    const colF = (row[5] || '').trim();
    const colG = (row[6] || '').trim();
    const colH = (row[7] || '').trim();
    if (colB === 'NET WORTH') { netWorth = parseMoney(colH); continue; }
    if (colB === 'ASSETS') { totalAssets = parseMoney(colD); totalLiabilities = parseMoney(colH); continue; }
    if (colB === 'UNGROUPED ASSET') { section = 'assets'; continue; }
    if (section === 'assets') {
      if (colB && colC && colD) assets.push({ name: colB, updated: colC, balance: parseMoney(colD) });
      if (colF && colG) liabilities.push({ name: colF, updated: colG, balance: parseMoney(colH) });
    }
  }
  return { netWorth, totalAssets, totalLiabilities, assets, liabilities };
}

// Derive the credit-card list the Cards Optimizer uses — dedup the
// liabilities by parsed identity so a single card with two Tiller rows
// doesn't fire two reminders.
function deriveCardsFromLiabilities(balances) {
  if (!balances || !Array.isArray(balances.liabilities)) return [];
  const seen = new Set();
  const out = [];
  for (const l of balances.liabilities) {
    const key = parseAccountName(l.name).full;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: l.name });
  }
  return out;
}

// Same matching the client does to attribute transactions to the canonical
// card name (so the schedule lib sees consistent t.account values).
function canonicalizeTransactionAccounts(transactions, cards) {
  const byFull = new Map();
  const byDigits = new Map();
  const ambiguousDigits = new Set();
  for (const c of cards) {
    const { full, digits } = parseAccountName(c.name);
    if (full) byFull.set(full, c.name);
    if (digits) {
      if (byDigits.has(digits) && byDigits.get(digits) !== c.name) ambiguousDigits.add(digits);
      else byDigits.set(digits, c.name);
    }
  }
  const out = [];
  for (const t of transactions || []) {
    const { full, digits } = parseAccountName(t.account);
    let canonical = byFull.get(full);
    if (!canonical && digits && !ambiguousDigits.has(digits)) canonical = byDigits.get(digits);
    if (canonical) out.push(t.account === canonical ? t : { ...t, account: canonical });
    else out.push(t);
  }
  return out;
}

export default async function handler(req, res) {
  try {
    const isTest = req.query?.test === '1' || req.query?.test === 'true';
    const recipientOverride = req.body?.recipient;
    const tz = process.env.WEEKLY_EMAIL_TZ || 'America/New_York';

    // Fetch sheet data + config in parallel — they're independent.
    const [rawTransactions, balances, config] = await Promise.all([
      fetchTransactionsFromSheet(),
      fetchBalancesFromSheet(),
      fetchConfig(),
    ]);

    // Apply the same categorization the website + weekly summary do, so
    // "credit card payments" are recognized consistently.
    let transactions = rawTransactions;
    if (config) {
      transactions = applyRulesToTransactions(transactions, config.categoryRules || []);
      transactions = applySubcategoryRulesToTransactions(transactions, config.subcategoryRules || []);
      transactions = applyOverrides(
        transactions,
        config.categoryOverrides || {},
        config.subcategoryOverrides || {},
        config.dateOverrides || {},
      );
    }

    const prefs = (config && config.paymentReminderPrefs) || {};
    // User can disable from the Settings page. The cron still fires but we
    // bail before sending. Env var override forces send for testing.
    if (prefs.enabled === false && !isTest) {
      return res.status(200).json({ skipped: true, reason: 'Disabled in Settings' });
    }

    const cards = deriveCardsFromLiabilities(balances);
    transactions = canonicalizeTransactionAccounts(transactions, cards);

    const last4 = process.env.PAYMENT_REMINDER_ACCOUNT_LAST4
      || prefs.payingAccountLast4
      || '1118';

    const payload = buildPaymentReminder({
      cards,
      transactions,
      balances,
      asOf: new Date(),
      tz,
      payingAccountLast4: last4,
      hiddenCards: (config && Array.isArray(config.hiddenCards)) ? config.hiddenCards : [],
      nicknames: (config && config.accountNicknames) || {},
    });

    if (!payload) {
      return res.status(200).json({ skipped: true, reason: 'No card payments projected for tomorrow' });
    }

    if (isTest && req.query?.dry === '1') {
      return res.status(200).json({ payload });
    }

    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    const to = recipientOverride || process.env.EMAIL_TO || user;
    if (!user || !pass) throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD env var');

    const html = renderPaymentReminderHtml(payload);
    const cardLabel = payload.cardsDueTomorrow.length === 1
      ? payload.cardsDueTomorrow[0].displayName
      : `${payload.cardsDueTomorrow.length} cards`;
    const subject = `${isTest ? '[Test] ' : ''}Card payment due tomorrow — ${cardLabel}`;

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
    });

    await transporter.sendMail({
      from: `"Wealth Architect" <${user}>`,
      to,
      subject,
      html,
    });

    return res.status(200).json({
      sent: true,
      to,
      cardsDueTomorrow: payload.cardsDueTomorrow.map(c => ({ name: c.displayName, amount: c.amount })),
      totalDue: payload.totalDue,
      payingAccountBalance: payload.payingAccount ? payload.payingAccount.balance : null,
    });
  } catch (err) {
    console.error('payment-reminder error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
