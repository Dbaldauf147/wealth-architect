// Daily portfolio snapshot.
//
// The Stock Performance page reconstructs history from trade rows plus
// today's price series, which is why it works from a single paste. The
// weakness is that it shows the past as the feed currently describes it: a
// delisting, a ticker reassignment or a vendor revision silently rewrites
// months that already happened.
//
// This records what each day actually looked like. Once a day it prices the
// imported positions, writes one row, and never touches it again. The page
// prefers these rows where they exist and falls back to reconstruction for
// anything older than the first snapshot.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getSeries, getQuotes } from './_lib/marketFeed.js';
import {
  hydrateTrades, hydrateActions, hydrateIncome, hydrateCashRows,
  buildLots, tradedSymbols,
} from '../src/lib/robinhood.js';
import { makeSeries } from '../src/lib/benchmark.js';
import { benchmarkLots, externalCashComparison } from '../src/lib/tradeBenchmark.js';

const HISTORY_PATH = ['portfolioHistory', 'daily'];
const BENCHMARK_SYMBOL = '^SP500TR';
// One doc holds every row. At roughly 90 bytes each that is decades of
// trading before the 1MB document limit is anywhere near, and it keeps the
// page's read to a single fetch.
const MAX_ROWS = 8000;

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

export default async function handler(req, res) {
  // Vercel signs cron invocations when CRON_SECRET is set. If it isn't, the
  // endpoint stays open like the other jobs here — it only ever writes an
  // idempotent row for today, so a stray call costs nothing.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const db = getFirestoreDb();
    if (!db) return res.status(500).json({ error: 'Missing FIREBASE_SERVICE_ACCOUNT_JSON' });

    const configSnap = await db.collection('config').doc('default').get();
    const stored = configSnap.exists ? (configSnap.data()?.robinhoodTrades || null) : null;
    const trades = hydrateTrades(stored?.trades);
    if (!trades.length) {
      return res.status(200).json({ skipped: 'no imported trades to snapshot' });
    }

    const corporateActions = hydrateActions(stored?.corporateActions);
    const income = hydrateIncome(stored?.income);
    const transfers = hydrateCashRows(stored?.transfers);
    const otherCash = hydrateCashRows(stored?.otherCash);

    const symbols = new Set(tradedSymbols(trades));
    for (const a of corporateActions) if (a.symbol) symbols.add(a.symbol);
    const earliest = trades.reduce((a, t) => (t.date < a ? t.date : a), trades[0].date);

    const [quotes, benchPayload] = await Promise.all([
      getQuotes([...symbols].sort(), earliest),
      getSeries(BENCHMARK_SYMBOL, '1999-12-31'),
    ]);

    const apiSplits = {};
    for (const [symbol, q] of Object.entries(quotes)) {
      if (q && !q.error) apiSplits[symbol] = Array.isArray(q.splits) ? q.splits : [];
    }

    const series = makeSeries(benchPayload.points);
    const lots = buildLots(trades, corporateActions, apiSplits);
    const result = benchmarkLots(lots, series, quotes, series.lastT, income);
    const external = externalCashComparison({
      transfers, otherCash, trades, income,
      lotRows: result.rows, series, asOfT: series.lastT,
    });

    // Refuse to record a row built from prices that didn't arrive. A gap in
    // the series is recoverable; a wrong row that looks real is not.
    const unpricedSymbols = Object.entries(quotes).filter(([, q]) => q?.error).map(([s]) => s);
    if (!(external.holdings > 0) && result.totals.lots > 0) {
      return res.status(502).json({
        error: 'No holdings could be priced — not recording a snapshot',
        unpricedSymbols,
      });
    }

    // Dated by the price the row reflects, not by when the job happened to
    // run, so a late or retried invocation lands on the right day.
    const asOf = new Date(series.lastT).toISOString().slice(0, 10);
    const row = {
      d: asOf,
      v: Number(external.ending.toFixed(2)),       // portfolio value
      h: Number(external.holdings.toFixed(2)),     // holdings at market
      k: Number(external.cash.toFixed(2)),         // cash balance
      c: Number(external.netTransfers.toFixed(2)), // your own money in
      b: Number(external.benchEnding.toFixed(2)),  // same deposits in the index
    };

    const ref = db.collection(HISTORY_PATH[0]).doc(HISTORY_PATH[1]);
    const written = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const rows = (snap.exists ? snap.data()?.rows : null) || [];
      // One row per date: a re-run replaces rather than appends.
      const next = rows.filter(r => r.d !== asOf);
      next.push(row);
      next.sort((a, b) => a.d.localeCompare(b.d));
      tx.set(ref, {
        rows: next.slice(-MAX_ROWS),
        updatedAt: new Date().toISOString(),
      });
      return next.length;
    });

    console.log(`portfolio-snapshot ${asOf}: value ${row.v}, bench ${row.b} (${written} rows)`);
    return res.status(200).json({ recorded: row, totalRows: written, unpricedSymbols });
  } catch (err) {
    console.error('portfolio-snapshot failed:', err);
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
}
