import { JWT } from 'google-auth-library';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { buildCalendarEvents, toCalendarEventBody } from '../src/lib/calendarSync.js';
import {
  applyRulesToTransactions,
  applySubcategoryRulesToTransactions,
  applyOverrides,
} from '../src/lib/categorize.js';

// ── Card-name parsing / sheet reads: mirror api/payment-reminder.js so both
// crons attribute transactions to the same canonical card names. Kept inline
// (not imported from CardsPage) so this stays free of client-only deps. ──

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

// ── Google Calendar auth + REST ──

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

function loadCalendarServiceAccount() {
  // A dedicated SA is cleanest, but the Firebase SA works too as long as the
  // Calendar API is enabled on its project and the target calendar is shared
  // with its client_email.
  const raw = process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON
    || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { throw new Error('GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON is not valid JSON'); }
}

async function getCalendarToken(sa) {
  const client = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
  });
  const { access_token: token } = await client.authorize();
  if (!token) throw new Error('Failed to mint Google Calendar access token');
  return token;
}

// Upsert by deterministic id: try update (PUT) first; if the event doesn't
// exist yet, insert it (POST) carrying the same id. A 409 on insert means a
// concurrent run already created it, so fall back to update.
async function upsertEvent(token, calendarId, body) {
  const base = `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  let res = await fetch(`${base}/${body.id}`, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (res.status === 404) {
    res = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.status === 409) {
      res = await fetch(`${base}/${body.id}`, { method: 'PUT', headers, body: JSON.stringify(body) });
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Calendar upsert ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function deleteEvent(token, calendarId, eventId) {
  const url = `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  // Already gone (404) or previously cancelled (410) is a successful no-op.
  return res.ok || res.status === 404 || res.status === 410;
}

export default async function handler(req, res) {
  try {
    const isTest = req.query?.test === '1' || req.query?.test === 'true';
    const isDry = req.query?.dry === '1' || req.query?.dry === 'true';
    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    const siteUrl = process.env.PUBLIC_SITE_URL || 'https://wealth-architect-delta.vercel.app';

    const sa = loadCalendarServiceAccount();

    // Not configured yet → no-op so the daily cron doesn't error before setup.
    if (!isDry && (!calendarId || !sa)) {
      return res.status(200).json({
        skipped: true,
        reason: 'Calendar sync not configured (set GOOGLE_CALENDAR_ID and a service-account env var, and share the calendar with the SA email)',
      });
    }

    const [rawTransactions, balances, config] = await Promise.all([
      fetchTransactionsFromSheet(),
      fetchBalancesFromSheet(),
      fetchConfig(),
    ]);

    // Same categorization the website + other crons apply, so "credit card
    // payments" are recognized consistently.
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

    const prefs = (config && config.calendarSyncPrefs) || {};
    const reminderPrefs = (config && config.paymentReminderPrefs) || {};
    // Opt-out from Settings. The cron still fires but bails before writing.
    if (prefs.enabled === false && !isTest) {
      return res.status(200).json({ skipped: true, reason: 'Disabled in Settings' });
    }

    const cards = deriveCardsFromLiabilities(balances);
    transactions = canonicalizeTransactionAccounts(transactions, cards);

    const last4 = process.env.PAYMENT_REMINDER_ACCOUNT_LAST4
      || prefs.payingAccountLast4
      || reminderPrefs.payingAccountLast4
      || '1118';

    const { events, removals } = buildCalendarEvents({
      cards,
      transactions,
      balances,
      asOf: new Date(),
      hiddenCards: (config && Array.isArray(config.hiddenCards)) ? config.hiddenCards : [],
      nicknames: (config && config.accountNicknames) || {},
      payingAccountLast4: last4,
    });

    // Preview without touching the calendar.
    if (isDry) {
      return res.status(200).json({
        dry: true,
        calendarId: calendarId || null,
        serviceAccountConfigured: !!sa,
        events: events.map(e => ({ card: e.displayName, date: e.dateKey, amount: e.amount, eventId: e.eventId, summary: e.summary })),
        removals: removals.map(r => ({ card: r.card, eventId: r.eventId })),
      });
    }

    const token = await getCalendarToken(sa);

    const upserted = [];
    const failed = [];
    for (const spec of events) {
      try {
        await upsertEvent(token, calendarId, toCalendarEventBody(spec, { siteUrl }));
        upserted.push({ card: spec.displayName, date: spec.dateKey, amount: spec.amount });
      } catch (err) {
        console.error('calendar upsert failed:', spec.eventId, err.message);
        failed.push({ card: spec.displayName, error: err.message });
      }
    }

    const removed = [];
    for (const r of removals) {
      try {
        const ok = await deleteEvent(token, calendarId, r.eventId);
        if (ok) removed.push({ card: r.card });
      } catch (err) {
        console.error('calendar delete failed:', r.eventId, err.message);
      }
    }

    return res.status(failed.length ? 207 : 200).json({
      synced: true,
      calendarId,
      upserted,
      removed,
      failed,
    });
  } catch (err) {
    console.error('calendar-sync error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
