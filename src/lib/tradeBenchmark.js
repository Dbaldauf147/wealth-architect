// Compare matched trade lots against the S&P 500.
//
// The counterfactual is per-lot and holding-period-matched: every dollar you
// put into a position on day X is instead put into the index on day X and
// taken out on the day you sold (or held to today for an open position).
// That isolates security selection from timing — the index sim experiences
// exactly the same cash-flow schedule you did.

import { returnBetween, xirr } from './benchmark.js';
import { allocateIncome } from './robinhood.js';

function emptyTotals() {
  return { invested: 0, returned: 0, income: 0, benchReturned: 0, lots: 0 };
}

/**
 * @param {{closed: Array, open: Array}} lots   from buildLots()
 * @param {object} series                       benchmark series from makeSeries()
 * @param {Record<string, {price?: number, error?: string}>} quotes
 * @param {number} asOfT                        timestamp to mark open lots at
 */
export function benchmarkLots(lots, series, quotes, asOfT, income) {
  const rows = [];
  const excluded = { beforeSeries: 0, unpriced: 0, unpricedSymbols: new Set() };

  // Dividends are part of the return on the money invested, and the benchmark
  // reinvests its own, so leaving them out would penalise every payer.
  const dividends = allocateIncome(lots, income);

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
      for (const sym of lot.basketMembers || [lot.symbol]) excluded.unpricedSymbols.add(sym);
      return;
    }

    const benchValue = lot.costBasis * growth;
    const lotIncome = dividends.byLot.get(lot) || 0;
    // Total return: what the position is worth plus the cash it paid out.
    // This is the like-for-like figure against a total-return index.
    const totalValue = proceeds + lotIncome;

    rows.push({
      symbol: lot.symbol,
      open,
      basket: lot.basket || null,
      quantity: lot.quantity,
      buyT: lot.buyT,
      buyDate: lot.buyDate,
      exitT,
      exitDate,
      costBasis: lot.costBasis,
      value: proceeds,
      income: lotIncome,
      totalValue,
      gain: totalValue - lot.costBasis,
      ret: lot.costBasis > 0 ? totalValue / lot.costBasis - 1 : null,
      // Price-only return, kept so the UI can show what dividends contributed.
      priceRet: lot.costBasis > 0 ? proceeds / lot.costBasis - 1 : null,
      benchValue,
      benchGain: benchValue - lot.costBasis,
      benchRet: growth - 1,
      alpha: totalValue - benchValue,
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
    // A basket lot survived a reorg: its value is the whole resulting share
    // basket, of which this purchase owns a cost-weighted share.
    if (lot.basket) {
      let basketValue = 0;
      let asOf = null;
      let priced = true;
      for (const [sym, qty] of Object.entries(lot.basket)) {
        const px = quotes?.[sym]?.price;
        if (!Number.isFinite(px)) { priced = false; break; }
        basketValue += qty * px;
        asOf = quotes[sym].asOf || asOf;
      }
      evaluate(lot, {
        exitT: asOfT,
        exitDate: asOf,
        proceeds: priced ? basketValue * lot.basketWeight : null,
        open: true,
      });
      continue;
    }

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
      b.income += row.income;
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
    s.income += row.income;
    s.benchReturned += row.benchValue;
    s.lots++;
    if (row.open) s.openLots++; else s.closedLots++;
    s.firstBuyT = Math.min(s.firstBuyT, row.buyT);
    s.lastExitT = Math.max(s.lastExitT, row.exitT);
  }

  const finish = (t) => ({
    ...t,
    totalValue: t.returned + t.income,
    gain: t.returned + t.income - t.invested,
    ret: t.invested > 0 ? (t.returned + t.income) / t.invested - 1 : null,
    priceRet: t.invested > 0 ? t.returned / t.invested - 1 : null,
    benchGain: t.benchReturned - t.invested,
    benchRet: t.invested > 0 ? t.benchReturned / t.invested - 1 : null,
    alpha: t.returned + t.income - t.benchReturned,
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
  // Dividends enter on their own pay dates — cash received in 2021 compounds
  // differently from the same dollars received today. The benchmark needs no
  // equivalent because ^SP500TR already reinvests its own.
  for (const flow of dividends.flows) yourFlows.push(flow);

  return {
    rows: rows.sort((a, b) => b.alpha - a.alpha),
    symbols,
    totals: finish(totals),
    closedTotals: finish(closedTotals),
    openTotals: finish(openTotals),
    yourIrr: xirr(yourFlows),
    benchIrr: xirr(benchFlows),
    dividends: {
      allocated: dividends.allocated,
      unallocated: dividends.unallocated,
      unallocatedSymbols: dividends.unallocatedSymbols,
    },
    excluded: {
      beforeSeries: excluded.beforeSeries,
      unpriced: excluded.unpriced,
      unpricedSymbols: [...excluded.unpricedSymbols],
    },
  };
}

/**
 * The portfolio-level answer: your own money in and out, against the same
 * money put into the index on the same dates.
 *
 * This exists because the per-lot comparison can't be made airtight when
 * dividends are recycled. A dividend that later funds a purchase gets counted
 * twice there — once as income on the lot that paid it, once as fresh cost
 * basis on the lot that bought with it. Measuring only cash that crossed the
 * account boundary sidesteps the problem entirely: dividends never appear as
 * a flow, they simply show up inside the ending value, exactly as the index's
 * own dividends show up inside ^SP500TR.
 *
 * Ending value = what the holdings are worth + the cash sitting in the
 * account, reconciled from the full activity ledger.
 */
export function externalCashComparison({
  transfers, otherCash, trades, income, lotRows, series, asOfT,
}) {
  const sum = (arr) => (arr || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);

  const netTransfers = sum(transfers);
  const deposits = (transfers || []).filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const withdrawals = -(transfers || []).filter(r => r.amount < 0).reduce((s, r) => s + r.amount, 0);

  const buys = (trades || []).filter(t => t.side === 'buy').reduce((s, t) => s + t.amount, 0);
  const sells = (trades || []).filter(t => t.side === 'sell').reduce((s, t) => s + t.amount, 0);

  // Every dollar the account has seen, netted: what came in, less what was
  // spent on stock, plus what sales and dividends returned, less fees.
  const cash = netTransfers + sells + sum(income) + sum(otherCash) - buys;
  const holdings = (lotRows || []).filter(r => r.open).reduce((s, r) => s + r.value, 0);
  const ending = holdings + cash;

  // The same transfers, into the index instead. Units can only be bought or
  // sold at the level on the day the cash actually moved.
  let units = 0;
  const flows = [];
  let unpriced = 0;
  for (const row of transfers || []) {
    if (!Number.isFinite(row.t) || !Number.isFinite(row.amount) || row.amount === 0) continue;
    const level = series.closeAt(row.t);
    if (!level) { unpriced += row.amount; continue; }
    units += row.amount / level;
    // Investor's perspective: money into the account is money out of pocket.
    flows.push({ t: row.t, amount: -row.amount });
  }
  const benchEnding = units * series.lastClose;

  return {
    deposits,
    withdrawals,
    netTransfers,
    cash,
    holdings,
    ending,
    benchEnding,
    alpha: ending - benchEnding,
    ret: netTransfers > 0 ? ending / netTransfers - 1 : null,
    benchRet: netTransfers > 0 ? benchEnding / netTransfers - 1 : null,
    yourIrr: xirr([...flows, { t: asOfT, amount: ending }]),
    benchIrr: xirr([...flows, { t: asOfT, amount: benchEnding }]),
    transferCount: (transfers || []).length,
    unpricedTransfers: unpriced,
  };
}

/** Symbols with open lots — the only ones needing a live quote. */
export function openSymbols(lots) {
  const out = new Set();
  for (const lot of lots.open || []) {
    if (lot.basket) for (const sym of Object.keys(lot.basket)) out.add(sym);
    else out.add(lot.symbol);
  }
  return [...out];
}
