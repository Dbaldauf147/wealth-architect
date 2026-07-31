// Compare matched trade lots against the S&P 500.
//
// The counterfactual is per-lot and holding-period-matched: every dollar you
// put into a position on day X is instead put into the index on day X and
// taken out on the day you sold (or held to today for an open position).
// That isolates security selection from timing — the index sim experiences
// exactly the same cash-flow schedule you did.

import { returnBetween, xirr } from './benchmark.js';

function emptyTotals() {
  return { invested: 0, returned: 0, benchReturned: 0, lots: 0 };
}

/**
 * @param {{closed: Array, open: Array}} lots   from buildLots()
 * @param {object} series                       benchmark series from makeSeries()
 * @param {Record<string, {price?: number, error?: string}>} quotes
 * @param {number} asOfT                        timestamp to mark open lots at
 */
export function benchmarkLots(lots, series, quotes, asOfT) {
  const rows = [];
  const excluded = { beforeSeries: 0, unpriced: 0, unpricedSymbols: new Set() };

  const evaluate = (lot, { exitT, exitDate, proceeds, open }) => {
    const growth = (() => {
      const r = returnBetween(series, lot.buyT, exitT);
      return r == null ? null : 1 + r;
    })();

    // A trade that predates the benchmark series has no honest comparison —
    // count it out of both sides rather than anchoring it to the first close.
    if (growth == null) {
      excluded.beforeSeries++;
      return;
    }
    if (proceeds == null) {
      excluded.unpriced++;
      excluded.unpricedSymbols.add(lot.symbol);
      return;
    }

    const benchValue = lot.costBasis * growth;
    rows.push({
      symbol: lot.symbol,
      open,
      quantity: lot.quantity,
      buyT: lot.buyT,
      buyDate: lot.buyDate,
      exitT,
      exitDate,
      costBasis: lot.costBasis,
      value: proceeds,
      gain: proceeds - lot.costBasis,
      ret: lot.costBasis > 0 ? proceeds / lot.costBasis - 1 : null,
      benchValue,
      benchGain: benchValue - lot.costBasis,
      benchRet: growth - 1,
      alpha: proceeds - benchValue,
      heldDays: Math.max(0, Math.round((exitT - lot.buyT) / 86400000)),
    });
  };

  for (const lot of lots.closed || []) {
    evaluate(lot, {
      exitT: lot.sellT,
      exitDate: lot.sellDate,
      proceeds: lot.proceeds,
      open: false,
    });
  }

  for (const lot of lots.open || []) {
    const quote = quotes?.[lot.symbol];
    const price = Number.isFinite(quote?.price) ? quote.price : null;
    evaluate(lot, {
      exitT: asOfT,
      exitDate: quote?.asOf || null,
      proceeds: price == null ? null : lot.quantity * price,
      open: true,
    });
  }

  // ── Roll up ───────────────────────────────────────────────────────────
  const totals = emptyTotals();
  const closedTotals = emptyTotals();
  const openTotals = emptyTotals();
  const bySymbol = new Map();

  for (const row of rows) {
    const buckets = [totals, row.open ? openTotals : closedTotals];
    for (const b of buckets) {
      b.invested += row.costBasis;
      b.returned += row.value;
      b.benchReturned += row.benchValue;
      b.lots++;
    }

    if (!bySymbol.has(row.symbol)) {
      bySymbol.set(row.symbol, {
        symbol: row.symbol,
        ...emptyTotals(),
        openLots: 0,
        closedLots: 0,
        firstBuyT: row.buyT,
        lastExitT: row.exitT,
      });
    }
    const s = bySymbol.get(row.symbol);
    s.invested += row.costBasis;
    s.returned += row.value;
    s.benchReturned += row.benchValue;
    s.lots++;
    if (row.open) s.openLots++; else s.closedLots++;
    s.firstBuyT = Math.min(s.firstBuyT, row.buyT);
    s.lastExitT = Math.max(s.lastExitT, row.exitT);
  }

  const finish = (t) => ({
    ...t,
    gain: t.returned - t.invested,
    ret: t.invested > 0 ? t.returned / t.invested - 1 : null,
    benchGain: t.benchReturned - t.invested,
    benchRet: t.invested > 0 ? t.benchReturned / t.invested - 1 : null,
    alpha: t.returned - t.benchReturned,
  });

  const symbols = [...bySymbol.values()]
    .map(finish)
    .sort((a, b) => b.alpha - a.alpha);

  // Money-weighted returns over identical cash-flow schedules. Negative =
  // money in, positive = money out.
  const yourFlows = [];
  const benchFlows = [];
  for (const row of rows) {
    yourFlows.push({ t: row.buyT, amount: -row.costBasis });
    yourFlows.push({ t: row.exitT, amount: row.value });
    benchFlows.push({ t: row.buyT, amount: -row.costBasis });
    benchFlows.push({ t: row.exitT, amount: row.benchValue });
  }

  return {
    rows: rows.sort((a, b) => b.alpha - a.alpha),
    symbols,
    totals: finish(totals),
    closedTotals: finish(closedTotals),
    openTotals: finish(openTotals),
    yourIrr: xirr(yourFlows),
    benchIrr: xirr(benchFlows),
    excluded: {
      beforeSeries: excluded.beforeSeries,
      unpriced: excluded.unpriced,
      unpricedSymbols: [...excluded.unpricedSymbols],
    },
  };
}

/** Symbols with open lots — the only ones needing a live quote. */
export function openSymbols(lots) {
  return [...new Set((lots.open || []).map(l => l.symbol))];
}
