// Keep it, or sell it and buy the index?
//
// The instinct is that a position has to beat the index to be worth keeping.
// For an appreciated holding in a taxable account that is usually wrong, and
// the reason is the tax. Selling hands the government a slice of the position
// *today*, and those dollars stop compounding forever. Keeping defers that,
// so the money working for you is larger from day one — which buys the
// position a margin it is allowed to lose by and still come out ahead.
//
// This file works out how big that margin is, which turns a vague "should I
// switch" into a number you can hold the stock to: the return it has to earn
// for keeping to have been the right call.

/**
 * @param {number} value       what the position is worth now
 * @param {number} basis       its cost basis
 * @param {number} taxToSell   tax due if sold today (negative if it books a loss)
 * @param {number} indexReturn assumed annual return of the index, e.g. 0.09
 * @param {number} years       horizon
 * @param {number} futureTaxRate  rate assumed on gains realized at the horizon
 * @param {boolean} liquidateAtEnd  false models never selling again — a step-up
 *                                  at death, or donating the shares
 * @returns {{required: number, hurdle: number, netProceeds: number} | null}
 */
export function requiredReturn({
  value, basis, taxToSell, indexReturn, years,
  futureTaxRate = 0.15, liquidateAtEnd = true,
}) {
  if (!(value > 0) || !(years > 0) || !Number.isFinite(indexReturn)) return null;
  if (!Number.isFinite(taxToSell) || !Number.isFinite(basis)) return null;

  const tau = Math.min(Math.max(futureTaxRate, 0), 0.9);
  const proceeds = value - taxToSell;           // what actually reaches the index
  if (!(proceeds > 0)) return null;

  const h = Math.pow(1 + indexReturn, years);   // index growth over the horizon

  // Both sides are measured after the tax finally due on them, so the
  // comparison is what you could spend, not what the statement says.
  //
  //   keep, then sell:   V·g − τ(V·g − B)      = V·g(1−τ) + τB
  //   sell now, reinvest: P·h − τ(P·h − P)     = P[h(1−τ) + τ]
  //
  // Setting those equal and solving for g gives the growth the position must
  // manage; the n-th root turns it into an annual rate.
  let g;
  if (liquidateAtEnd) {
    if (tau >= 1) return null;
    g = (proceeds * (h * (1 - tau) + tau) - tau * basis) / (value * (1 - tau));
  } else {
    // Never sold, so neither embedded gain is ever taxed and the whole
    // question is simply how much smaller the index stake starts out.
    g = (proceeds / value) * h;
  }

  if (!(g > 0) || !Number.isFinite(g)) return null;

  const required = Math.pow(g, 1 / years) - 1;
  return {
    required,
    // Negative means the position may trail the index by this much a year and
    // keeping still wins.
    hurdle: required - indexReturn,
    netProceeds: proceeds,
  };
}

/** The same question across several horizons. */
export function breakEvenTable({
  value, basis, taxToSell, indexReturn,
  futureTaxRate, horizons = [1, 3, 5, 10, 20],
}) {
  return horizons.map(years => ({
    years,
    liquidate: requiredReturn({
      value, basis, taxToSell, indexReturn, years, futureTaxRate, liquidateAtEnd: true,
    }),
    forever: requiredReturn({
      value, basis, taxToSell, indexReturn, years, futureTaxRate, liquidateAtEnd: false,
    }),
  }));
}

/**
 * The tax bill's own opportunity cost: what the money handed over today would
 * have become had it stayed invested at the index rate.
 *
 * This is the figure that makes the hurdle intuitive — the tax is not a
 * one-off fee, it is a permanently smaller stake.
 */
export function taxOpportunityCost(taxToSell, indexReturn, years) {
  if (!Number.isFinite(taxToSell) || !Number.isFinite(indexReturn) || !(years > 0)) return null;
  return taxToSell * Math.pow(1 + indexReturn, years);
}

/**
 * The rate to assume on gains taxed at the horizon.
 *
 * Derived from what selling today actually costs rather than assumed, so a
 * position sitting in the 0% bracket isn't charged 15% in the projection.
 * Falls back when the position is flat and the ratio is meaningless.
 */
export function impliedTaxRate(taxToSell, value, basis, fallback = 0.15) {
  const gain = value - basis;
  if (!Number.isFinite(gain) || Math.abs(gain) < 1) return fallback;
  const rate = taxToSell / gain;
  if (!Number.isFinite(rate)) return fallback;
  return Math.min(Math.max(rate, 0), 0.9);
}
