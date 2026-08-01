// Rebuild what the whole account was worth, month by month, against the same
// deposits put into the index instead.
//
// The ending value here is the same quantity the headline uses — holdings at
// market plus the cash balance — so the last point on the chart is the number
// in the hero, not a parallel calculation that might drift from it.

import { makeSeries, utcDay, toISODate, MS_DAY } from './benchmark.js';

/**
 * Wrap a ticker's quoted closes for lookup.
 *
 * No split adjustment is applied here, and that is deliberate: the feed's
 * close series is *already* back-adjusted for splits (only dividends are
 * absent, which is what makes it the right series for market value). Adjusting
 * again would divide historical prices by every split a second time — a 6:1
 * would inflate the position sixfold.
 */
export function priceSeries(points) {
  return makeSeries(points);
}

/** Month-start timestamps spanning a range, plus the exact end. */
function monthlySamples(fromT, toT) {
  const out = [];
  const d = new Date(fromT);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  for (;;) {
    const t = Date.UTC(y, m, 1, 23, 59, 0);
    if (t > toT) break;
    if (t >= fromT) out.push(t);
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  if (!out.length || out[out.length - 1] < toT) out.push(toT);
  return out;
}

/**
 * @param {object}   lots          from buildLots()
 * @param {object}   tickerSeries  symbol → split-adjusted price series
 * @param {object}   ledger        { trades, transfers, otherCash, income }
 * @param {object}   benchSeries   ^SP500TR series
 * @param {number}   toT           the "now" to run up to
 *
 * Returns { points, unpriced } where each point is
 * { t, value, contributed, bench } — your account, your net deposits, and
 * those same deposits in the index.
 */
export function buildPortfolioHistory({ lots, tickerSeries, ledger, benchSeries, toT }) {
  const trades = ledger?.trades || [];
  const transfers = ledger?.transfers || [];
  const otherCash = ledger?.otherCash || [];
  const income = ledger?.income || [];

  const dated = [
    ...transfers.map(r => ({ t: r.t, amount: r.amount, external: true })),
    ...otherCash.map(r => ({ t: r.t, amount: r.amount, external: false })),
    ...income.map(r => ({ t: r.t, amount: r.amount, external: false })),
    ...trades.map(t => ({ t: t.t, amount: t.side === 'buy' ? -t.amount : t.amount, external: false })),
  ].filter(r => Number.isFinite(r.t) && Number.isFinite(r.amount))
    .sort((a, b) => a.t - b.t);

  if (!dated.length) return { points: [], unpriced: [] };

  const allLots = [...(lots?.closed || []), ...(lots?.open || [])];
  const fromT = Math.min(dated[0].t, ...allLots.map(l => l.buyT).filter(Number.isFinite));
  if (!Number.isFinite(fromT) || fromT >= toT) return { points: [], unpriced: [] };

  const unpriced = new Set();

  // Value one lot at time t as shares × price.
  //
  // Not cost × (price_then / price_at_purchase): monthly candles carry the
  // month's closing price, so reading a purchase price off them would use a
  // price up to a month after the trade and skew every lot. Share counts are
  // already split-adjusted to today and the price series is too, so the two
  // line up at every date — and at the final sample this reproduces the
  // headline's market value exactly rather than approximating it.
  const lotValueAt = (lot, t) => {
    if (lot.basket) {
      let total = 0;
      for (const [sym, qty] of Object.entries(lot.basket)) {
        const px = tickerSeries[sym]?.closeAt(t);
        if (!px) { unpriced.add(sym); continue; }
        total += qty * px;
      }
      return total * (lot.basketWeight ?? 1);
    }
    const s = tickerSeries[lot.symbol];
    const px = s?.closeAt(t);
    if (!px || !Number.isFinite(lot.quantity)) { unpriced.add(lot.symbol); return null; }
    return lot.quantity * px;
  };

  const points = [];
  let cursor = 0;
  let cash = 0;
  let contributed = 0;
  let benchUnits = 0;

  for (const t of monthlySamples(fromT, toT)) {
    // Roll the ledger forward to this sample.
    while (cursor < dated.length && dated[cursor].t <= t) {
      const row = dated[cursor];
      cash += row.amount;
      if (row.external) {
        contributed += row.amount;
        const level = benchSeries.closeAt(row.t);
        if (level) benchUnits += row.amount / level;
      }
      cursor++;
    }

    let holdings = 0;
    for (const lot of allLots) {
      if (!(lot.buyT <= t)) continue;
      // Once sold, the money is cash — the sale is already in the ledger.
      if (lot.sellT != null && t >= lot.sellT) continue;
      const v = lotValueAt(lot, t);
      if (v != null) holdings += v;
    }

    const benchLevel = benchSeries.closeAt(t);
    points.push({
      t,
      value: holdings + cash,
      contributed,
      bench: benchLevel ? benchUnits * benchLevel : null,
    });
  }

  // How much of the position could actually be valued at the end. A chart
  // drawn from a fraction of the holdings is not a slightly-low chart, it is a
  // wrong one, so the caller is given the numbers to refuse it.
  let pricedCost = 0;
  let unpricedCost = 0;
  for (const lot of allLots) {
    if (lot.sellT != null && toT >= lot.sellT) continue;
    if (!(lot.buyT <= toT)) continue;
    const v = lotValueAt(lot, toT);
    if (v == null) unpricedCost += lot.costBasis;
    else pricedCost += lot.costBasis;
  }

  return {
    points,
    unpriced: [...unpriced].sort(),
    pricedCost,
    unpricedCost,
    pricedFraction: pricedCost + unpricedCost > 0 ? pricedCost / (pricedCost + unpricedCost) : 0,
  };
}

/**
 * Splice recorded daily snapshots over the reconstructed monthly history.
 *
 * Reconstruction shows the past as the price feed describes it *today*, so a
 * vendor revision or a ticker reassignment quietly rewrites months that have
 * already happened. A recorded row is what that day actually looked like, so
 * where one exists it wins; reconstruction only fills in the stretch before
 * logging began.
 */
export function mergeLoggedHistory(reconstructed, logged) {
  const rows = (logged || [])
    .map(r => ({
      t: utcDay(r.d),
      value: Number(r.v),
      contributed: Number(r.c),
      bench: Number(r.b),
      holdings: Number(r.h),
      cash: Number(r.k),
      logged: true,
    }))
    .filter(r => Number.isFinite(r.t) && Number.isFinite(r.value))
    .sort((a, b) => a.t - b.t);

  if (!rows.length) return { points: reconstructed || [], loggedFrom: null, loggedCount: 0 };

  // Compare on the calendar date, not the timestamp: a reconstructed sample
  // and a recorded row for the same day sit hours apart and would otherwise
  // both be plotted, putting two points on one date.
  const fromDate = toISODate(rows[0].t);
  const from = rows[0].t;
  const before = (reconstructed || []).filter(p => toISODate(p.t) < fromDate);
  return {
    points: [...before, ...rows],
    loggedFrom: from,
    loggedCount: rows.length,
  };
}

/** Deposits and withdrawals as discrete events, for plotting alongside. */
export function contributionEvents(transfers) {
  return (transfers || [])
    .filter(r => Number.isFinite(r.t) && Number.isFinite(r.amount) && r.amount !== 0)
    .sort((a, b) => a.t - b.t);
}

export { MS_DAY };
