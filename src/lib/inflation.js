// Inflation math over the CPI-U series from /api/market-data?cpi=…
//
// The point of this file is a single question: did the money grow faster than
// prices did? A 40% gain over eight years sounds like a win and is in fact a
// loss of purchasing power, and nothing else on the page can tell you that.
//
// Everything works in *today's dollars*: a 2017 deposit is restated at what it
// would take to buy the same basket now, and compared against what the account
// is worth now. That direction is deliberate — restating today's balance in
// 2017 dollars gives the identical ratio but a number nobody can act on.

import { makeSeries, xirr, MS_DAY } from './benchmark.js';

/** Wrap raw CPI points in the same lookup structure the price series uses. */
export function makeCpiSeries(points) {
  return makeSeries(points);
}

/**
 * Price-level ratio between two dates — 1.2 means it takes $1.20 to buy what
 * $1.00 bought. Null when either date falls outside the published series.
 */
export function priceRatio(cpi, fromT, toT) {
  if (!cpi || !cpi.length) return null;
  const a = cpi.closeAt(fromT);
  const b = cpi.closeAt(toT);
  if (!a || !b) return null;
  return b / a;
}

/** Cumulative inflation between two dates, as a return. */
export function inflationBetween(cpi, fromT, toT) {
  const ratio = priceRatio(cpi, fromT, toT);
  return ratio == null ? null : ratio - 1;
}

/** What `amount` at `fromT` is worth in `toT` dollars. */
export function inflateTo(cpi, amount, fromT, toT) {
  const ratio = priceRatio(cpi, fromT, toT);
  return ratio == null ? null : amount * ratio;
}

/**
 * The real return behind a nominal one.
 *
 * (1+n)/(1+i)−1, not n−i. The subtraction is the approximation everyone
 * reaches for and it drifts badly exactly where it matters: 60% nominal
 * against 30% inflation is 23% real, not 30%.
 */
export function realReturn(nominal, inflation) {
  if (nominal == null || inflation == null) return null;
  if (1 + inflation <= 0) return null;
  return (1 + nominal) / (1 + inflation) - 1;
}

/** Annualize a cumulative return over a span, matching benchmark.js's rules. */
function annualizeOver(total, fromT, toT) {
  if (total == null) return null;
  const years = (toT - fromT) / (365.25 * MS_DAY);
  if (years < 1 / 12) return null;
  return Math.pow(1 + total, 1 / years) - 1;
}

/**
 * Restate dated cash flows in `asOfT` dollars, then solve for the rate.
 *
 * This is the honest real money-weighted return: deflating each flow before
 * the solve accounts for the fact that money put in during a high-inflation
 * stretch cost more purchasing power than the same face value put in later.
 * Dividing a nominal IRR by average inflation would not.
 */
export function realIrr(flows, cpi, asOfT) {
  if (!cpi || !cpi.length) return null;
  const last = cpi.closeAt(asOfT);
  if (!last) return null;
  const adjusted = [];
  for (const f of flows || []) {
    const level = cpi.closeAt(f.t);
    if (!level) return null; // a flow we can't deflate would bias the answer
    adjusted.push({ t: f.t, amount: f.amount * (last / level) });
  }
  return xirr(adjusted);
}

/**
 * Per-lot, per-ticker and total comparison of what the money did against what
 * prices did over the very same holding periods.
 *
 * The counterfactual is the same shape as the S&P one already on the page:
 * every dollar committed on day X is asked only to have kept its purchasing
 * power until the day it came back out. Anything above that line is real gain.
 *
 * @param {object} result  the return value of benchmarkLots()
 * @param {object} cpi     a series from makeCpiSeries()
 * @param {Array}  incomeFlows  dated dividend cash, so real IRR sees it
 */
export function inflationCompare(result, cpi, incomeFlows = []) {
  if (!result || !cpi || !cpi.length || !result.rows.length) return null;

  const byRow = new Map();
  const bySymbol = new Map();
  const totals = { invested: 0, totalValue: 0, inflValue: 0, lots: 0 };
  let unpriced = 0;
  let unpricedCost = 0;
  const flows = [];

  for (const row of result.rows) {
    const ratio = priceRatio(cpi, row.buyT, row.exitT);
    if (ratio == null) {
      unpriced++;
      unpricedCost += row.costBasis;
      continue;
    }

    // What the cost basis would have to be worth just to have stood still.
    const inflValue = row.costBasis * ratio;
    const entry = {
      inflFactor: ratio,
      inflValue,
      inflRet: ratio - 1,
      // Dollars of purchasing power created or destroyed.
      realGain: row.totalValue - inflValue,
      realRet: realReturn(row.ret, ratio - 1),
      beatInflation: row.totalValue >= inflValue,
    };
    byRow.set(row, entry);

    totals.invested += row.costBasis;
    totals.totalValue += row.totalValue;
    totals.inflValue += inflValue;
    totals.lots++;

    if (!bySymbol.has(row.symbol)) {
      bySymbol.set(row.symbol, {
        symbol: row.symbol, invested: 0, totalValue: 0, inflValue: 0, lots: 0,
        firstBuyT: row.buyT, lastExitT: row.exitT,
      });
    }
    const s = bySymbol.get(row.symbol);
    s.invested += row.costBasis;
    s.totalValue += row.totalValue;
    s.inflValue += inflValue;
    s.lots++;
    s.firstBuyT = Math.min(s.firstBuyT, row.buyT);
    s.lastExitT = Math.max(s.lastExitT, row.exitT);

    flows.push({ t: row.buyT, amount: -row.costBasis });
    flows.push({ t: row.exitT, amount: row.value });
  }

  if (!totals.lots) return null;

  for (const f of incomeFlows || []) flows.push(f);

  const finish = (t) => ({
    ...t,
    realGain: t.totalValue - t.inflValue,
    realRet: t.invested > 0
      ? realReturn(t.totalValue / t.invested - 1, t.inflValue / t.invested - 1)
      : null,
    inflRet: t.invested > 0 ? t.inflValue / t.invested - 1 : null,
    ret: t.invested > 0 ? t.totalValue / t.invested - 1 : null,
  });

  const symbols = [...bySymbol.values()].map(finish).sort((a, b) => b.realGain - a.realGain);

  return {
    byRow,
    symbols,
    totals: finish(totals),
    realIrr: realIrr(flows, cpi, result.rows.reduce((m, r) => Math.max(m, r.exitT), 0)),
    excluded: { lots: unpriced, cost: unpricedCost },
  };
}

/**
 * The whole-account real picture, built on cash that actually crossed the
 * account boundary — the same basis externalCashComparison() uses, and for the
 * same reason: dividends recycled into later buys can't double-count here.
 *
 * @param {Array}  transfers  deposits (+) and withdrawals (−) with `t`
 * @param {object} cpi
 * @param {number} ending     what the account is worth now, in today's dollars
 * @param {number} asOfT
 */
export function realCashComparison({ transfers, cpi, ending, asOfT }) {
  if (!cpi || !cpi.length || !Number.isFinite(ending)) return null;

  const nowLevel = cpi.closeAt(asOfT);
  if (!nowLevel) return null;

  let inflatedIn = 0;      // every transfer restated in today's dollars
  let nominalIn = 0;
  let firstT = Infinity;
  let unpriced = 0;
  const flows = [];

  for (const row of transfers || []) {
    if (!Number.isFinite(row.t) || !Number.isFinite(row.amount) || row.amount === 0) continue;
    const level = cpi.closeAt(row.t);
    if (!level) { unpriced += Math.abs(row.amount); continue; }
    inflatedIn += row.amount * (nowLevel / level);
    nominalIn += row.amount;
    firstT = Math.min(firstT, row.t);
    flows.push({ t: row.t, amount: -row.amount });
  }

  if (!flows.length || !Number.isFinite(firstT)) return null;

  const inflationSinceFirst = inflationBetween(cpi, firstT, asOfT);

  return {
    firstT,
    nominalIn,
    // What you'd need today to have the buying power your deposits had when
    // you made them. The account has to clear this to have gained anything.
    inflatedIn,
    ending,
    // Purchasing power created, in today's dollars.
    realGain: ending - inflatedIn,
    realRet: inflatedIn > 0 ? ending / inflatedIn - 1 : null,
    nominalRet: nominalIn > 0 ? ending / nominalIn - 1 : null,
    inflationSinceFirst,
    inflationAnnual: annualizeOver(inflationSinceFirst, firstT, asOfT),
    realIrr: realIrr([...flows, { t: asOfT, amount: ending }], cpi, asOfT),
    unpricedTransfers: unpriced,
    beatInflation: ending >= inflatedIn,
  };
}

/**
 * Restate a portfolio history in today's dollars.
 *
 * Both lines are deflated, not just one: the value at each point is what that
 * balance would buy now, and the contribution line accumulates each deposit at
 * what it would cost now. Read together the gap is real gain at every instant,
 * which is the only version of this chart that doesn't flatter the early years.
 *
 * @param {Array} points     [{ t, value, contributed }] from buildPortfolioHistory
 * @param {Array} transfers  the deposit/withdrawal ledger, with `t`
 */
export function realHistory(points, transfers, cpi, asOfT) {
  if (!cpi || !cpi.length || !points || points.length < 2) return null;
  const nowLevel = cpi.closeAt(asOfT);
  if (!nowLevel) return null;

  const moves = (transfers || [])
    .filter(r => Number.isFinite(r.t) && Number.isFinite(r.amount))
    .sort((a, b) => a.t - b.t);

  let cursor = 0;
  let inflatedIn = 0;
  const out = [];

  for (const p of points) {
    while (cursor < moves.length && moves[cursor].t <= p.t) {
      const level = cpi.closeAt(moves[cursor].t);
      if (level) inflatedIn += moves[cursor].amount * (nowLevel / level);
      cursor++;
    }
    const level = cpi.closeAt(p.t);
    if (!level || !Number.isFinite(p.value)) continue;
    out.push({
      t: p.t,
      value: p.value * (nowLevel / level),
      contributed: inflatedIn,
      nominalValue: p.value,
      nominalContributed: p.contributed,
    });
  }

  return out.length >= 2 ? out : null;
}

/**
 * Calendar-year inflation from the series, measured December to December so it
 * lines up with the calendar-year index returns already on the page.
 */
export function calendarYearInflation(cpi) {
  if (!cpi || !cpi.length) return [];
  const decByYear = new Map();
  for (let i = 0; i < cpi.length; i++) {
    const d = new Date(cpi.times[i]);
    if (d.getUTCMonth() === 11) decByYear.set(d.getUTCFullYear(), cpi.closes[i]);
  }
  const years = [...decByYear.keys()].sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < years.length; i++) {
    out.push({
      year: years[i],
      ret: decByYear.get(years[i]) / decByYear.get(years[i - 1]) - 1,
      partial: false,
    });
  }
  // The current year has no December yet; report it as year-to-date from the
  // last December so the newest bar isn't simply missing.
  const nowYear = new Date(cpi.lastT).getUTCFullYear();
  if (!decByYear.has(nowYear) && decByYear.has(nowYear - 1)) {
    out.push({
      year: nowYear,
      ret: cpi.lastClose / decByYear.get(nowYear - 1) - 1,
      partial: true,
    });
  }
  return out;
}

/** Annualized inflation between two dates. */
export function inflationCagr(cpi, fromT, toT) {
  return annualizeOver(inflationBetween(cpi, fromT, toT), fromT, toT);
}

/** How stale the last published reading is, in whole months. */
export function cpiLagMonths(cpi, asOfT) {
  if (!cpi || !cpi.length) return null;
  const last = new Date(cpi.lastT);
  const now = new Date(asOfT);
  return (now.getUTCFullYear() - last.getUTCFullYear()) * 12
    + (now.getUTCMonth() - last.getUTCMonth());
}
