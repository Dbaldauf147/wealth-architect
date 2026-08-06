// What selling would cost in tax.
//
// This is an estimate, and the file is written so that every assumption it
// makes is a named constant you can check rather than a number buried in a
// formula. It models the parts that dominate the answer for someone selling
// stock out of a taxable brokerage account:
//
//   • the one-year line between short- and long-term treatment
//   • long-term gains stacking on top of ordinary income into 0/15/20
//   • short-term gains taxed as ordinary income at your marginal rate
//   • the 3.8% net investment income tax over the MAGI thresholds
//   • loss netting, the $3,000 ordinary offset, and the carry-forward
//   • a flat state rate, because state treatment varies too much to model
//
// It does not model AMT, the QSBS exclusion, wash sales, state-specific
// capital-gains regimes, the additional Medicare tax on wages, quarterly
// estimated-payment penalties, or anything about retirement accounts. Those
// are listed on screen too — an estimate that hides its own gaps is worse
// than no estimate.

/**
 * Federal figures for this tax year, from IRS Rev. Proc. 2025-32 (the annual
 * inflation-adjustment notice). Bump TAX_YEAR and these five tables together
 * when the next one is published; nothing else in this file is year-specific.
 */
export const TAX_YEAR = 2026;
export const TAX_SOURCE = 'IRS Rev. Proc. 2025-32 (2026 inflation adjustments)';

export const FILING_STATUSES = [
  { id: 'single', label: 'Single' },
  { id: 'mfj', label: 'Married, filing jointly' },
  { id: 'hoh', label: 'Head of household' },
];

// Ordinary income tax, on taxable income. [upper bound of bracket, rate].
export const ORDINARY_BRACKETS = {
  single: [
    [12_400, 0.10], [50_400, 0.12], [105_700, 0.22], [201_775, 0.24],
    [256_225, 0.32], [640_600, 0.35], [Infinity, 0.37],
  ],
  mfj: [
    [24_800, 0.10], [100_800, 0.12], [211_400, 0.22], [403_550, 0.24],
    [512_450, 0.32], [768_700, 0.35], [Infinity, 0.37],
  ],
  hoh: [
    [17_700, 0.10], [67_450, 0.12], [105_700, 0.22], [201_750, 0.24],
    [256_200, 0.32], [640_600, 0.35], [Infinity, 0.37],
  ],
};

// Long-term capital gains, on total taxable income including the gains.
export const LTCG_BRACKETS = {
  single: [[49_450, 0], [545_500, 0.15], [Infinity, 0.20]],
  mfj: [[98_900, 0], [613_700, 0.15], [Infinity, 0.20]],
  hoh: [[66_200, 0], [579_600, 0.15], [Infinity, 0.20]],
};

export const STANDARD_DEDUCTION = { single: 16_100, mfj: 32_200, hoh: 24_150 };

// Net investment income tax. Not indexed to inflation — these thresholds have
// been the same since 2013 and are why they bite more every year.
export const NIIT_RATE = 0.038;
export const NIIT_THRESHOLD = { single: 200_000, mfj: 250_000, hoh: 200_000 };

// The most net capital loss that can be written off against ordinary income in
// one year. Also not indexed; it has been $3,000 since 1978.
export const MAX_LOSS_OFFSET = 3_000;

// A lot held longer than this qualifies for long-term rates. The statute is
// "more than one year", so exactly 365 days is still short-term.
export const LONG_TERM_DAYS = 366;

const statusOr = (status) => (ORDINARY_BRACKETS[status] ? status : 'single');

/** Federal ordinary income tax on a taxable-income figure. */
export function ordinaryTax(taxableIncome, status) {
  const brackets = ORDINARY_BRACKETS[statusOr(status)];
  let tax = 0;
  let floor = 0;
  for (const [ceiling, rate] of brackets) {
    if (taxableIncome <= floor) break;
    tax += (Math.min(taxableIncome, ceiling) - floor) * rate;
    floor = ceiling;
  }
  return Math.max(0, tax);
}

/** The rate the next dollar of ordinary income would be taxed at. */
export function marginalOrdinaryRate(taxableIncome, status) {
  const brackets = ORDINARY_BRACKETS[statusOr(status)];
  for (const [ceiling, rate] of brackets) {
    if (taxableIncome < ceiling) return rate;
  }
  return brackets[brackets.length - 1][1];
}

/**
 * Long-term gains stacked on top of ordinary income.
 *
 * Order matters and is not a modelling choice: the code taxes ordinary income
 * first and lets the preferential rates fill whatever bracket room is left, so
 * the same $50k gain can be free for one filer and cost $10k for another.
 */
export function longTermTax(ordinaryTaxable, gain, status) {
  const brackets = LTCG_BRACKETS[statusOr(status)];
  let remaining = Math.max(0, gain);
  let position = Math.max(0, ordinaryTaxable);
  let tax = 0;
  const bands = [];

  for (const [ceiling, rate] of brackets) {
    if (remaining <= 0) break;
    const room = Math.max(0, ceiling - position);
    const amount = Math.min(remaining, room);
    if (amount > 0) {
      tax += amount * rate;
      bands.push({ rate, amount });
      remaining -= amount;
      position += amount;
    }
  }
  return { tax, bands };
}

/**
 * Net short- and long-term results against each other the way Schedule D does.
 *
 * Losses in one column offset gains in the other, and only what survives is
 * taxed. A net loss overall is deductible against ordinary income up to
 * $3,000, and the rest carries into future years — which is why harvesting
 * more than that in one December buys nothing extra this April.
 */
export function netGains(shortTerm, longTerm) {
  let netShort = shortTerm;
  let netLong = longTerm;

  // Only cross-offset when the signs disagree; two gains or two losses stand.
  if (netShort < 0 && netLong > 0) {
    const used = Math.min(-netShort, netLong);
    netShort += used;
    netLong -= used;
  } else if (netLong < 0 && netShort > 0) {
    const used = Math.min(-netLong, netShort);
    netLong += used;
    netShort -= used;
  }

  const netLoss = Math.min(0, netShort + netLong);
  const ordinaryOffset = Math.min(-netLoss, MAX_LOSS_OFFSET);
  const carryForward = Math.max(0, -netLoss - MAX_LOSS_OFFSET);

  return {
    netShort: Math.max(0, netShort),
    netLong: Math.max(0, netLong),
    netLoss: -netLoss,
    ordinaryOffset,
    carryForward,
  };
}

/**
 * The whole bill for a set of gains.
 *
 * @param {number} shortTermGain     gains on lots held a year or less (may be negative)
 * @param {number} longTermGain      gains on lots held longer (may be negative)
 * @param {number} otherTaxableIncome  everything else, after deductions
 * @param {string} status            a FILING_STATUSES id
 * @param {number} stateRate         flat state rate on gains, as a fraction
 * @param {boolean} includeNiit
 */
export function estimateTax({
  shortTermGain = 0,
  longTermGain = 0,
  otherTaxableIncome = 0,
  status = 'single',
  stateRate = 0,
  includeNiit = true,
}) {
  const net = netGains(shortTermGain, longTermGain);
  const base = Math.max(0, otherTaxableIncome);

  // Short-term gains are ordinary income, so their cost is the *increment* to
  // the ordinary bill — not a flat rate. A sale that straddles two brackets is
  // taxed at both, which a single marginal rate would get wrong.
  const baseAfterOffset = Math.max(0, base - net.ordinaryOffset);
  const ordinaryTaxable = baseAfterOffset + net.netShort;
  const federalShort = ordinaryTax(ordinaryTaxable, status) - ordinaryTax(baseAfterOffset, status);
  const lossRelief = ordinaryTax(base, status) - ordinaryTax(baseAfterOffset, status);

  const lt = longTermTax(ordinaryTaxable, net.netLong, status);

  const investmentIncome = net.netShort + net.netLong;
  const magi = ordinaryTaxable + net.netLong;
  const niitBase = includeNiit
    ? Math.max(0, Math.min(investmentIncome, magi - (NIIT_THRESHOLD[statusOr(status)] || Infinity)))
    : 0;
  const niit = niitBase * NIIT_RATE;

  const state = Math.max(0, investmentIncome) * Math.max(0, stateRate || 0);

  const federal = federalShort + lt.tax + niit;
  const total = federal + state;
  const grossGain = shortTermGain + longTermGain;

  return {
    net,
    federalShort,
    federalLong: lt.tax,
    longTermBands: lt.bands,
    niit,
    niitBase,
    state,
    federal,
    total,
    // A net loss makes the bill negative — it *reduces* other tax owed.
    lossRelief,
    netCost: total - lossRelief,
    grossGain,
    // Share of the gain that goes to tax. Meaningless on a loss, so null.
    effectiveRate: grossGain > 0 ? total / grossGain : null,
    marginalOrdinaryRate: marginalOrdinaryRate(ordinaryTaxable, status),
    // The rate the last dollar of long-term gain paid — the number people mean
    // when they ask "am I in the 15% or the 20%".
    topLongTermRate: lt.bands.length ? lt.bands[lt.bands.length - 1].rate : null,
    ordinaryTaxable,
  };
}

/** Is a lot held from `buyT` to `asOfT` long-term yet? */
export function isLongTerm(buyT, asOfT) {
  return heldDays(buyT, asOfT) >= LONG_TERM_DAYS;
}

export function heldDays(buyT, asOfT) {
  if (!Number.isFinite(buyT) || !Number.isFinite(asOfT)) return 0;
  return Math.floor((asOfT - buyT) / 86_400_000);
}

/** The moment a lot crosses into long-term treatment. */
export function longTermDate(buyT) {
  return buyT + LONG_TERM_DAYS * 86_400_000;
}

/**
 * Split a set of open lots into the taxable pieces of a sale.
 *
 * Dividends already received are deliberately excluded: they were taxed in the
 * year they were paid, and taxing them again as part of the sale would
 * overstate the bill. Only proceeds less cost basis is a capital gain.
 */
export function summarizeLots(rows, asOfT) {
  const out = {
    shortTermGain: 0, longTermGain: 0,
    shortTermProceeds: 0, longTermProceeds: 0,
    shortTermBasis: 0, longTermBasis: 0,
    shortLots: 0, longLots: 0,
    gainLots: 0, lossLots: 0,
    proceeds: 0, basis: 0,
  };
  for (const r of rows || []) {
    if (!Number.isFinite(r.value) || !Number.isFinite(r.costBasis)) continue;
    const gain = r.value - r.costBasis;
    const long = isLongTerm(r.buyT, asOfT);
    out.proceeds += r.value;
    out.basis += r.costBasis;
    if (long) {
      out.longTermGain += gain;
      out.longTermProceeds += r.value;
      out.longTermBasis += r.costBasis;
      out.longLots++;
    } else {
      out.shortTermGain += gain;
      out.shortTermProceeds += r.value;
      out.shortTermBasis += r.costBasis;
      out.shortLots++;
    }
    if (gain >= 0) out.gainLots++; else out.lossLots++;
  }
  out.gain = out.shortTermGain + out.longTermGain;
  return out;
}
