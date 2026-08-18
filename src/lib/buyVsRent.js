// Buy vs. rent, built on the New York Times Upshot calculator's method.
//
// NOTES FROM THE NYT MODEL — the parts that make it better than the
// "mortgage payment vs. rent" comparison everyone reaches for first:
//
//  1. It compares TOTAL COST OVER A HORIZON, not monthly payments. You pick
//     how long you'll stay, and the model runs both paths to that date and
//     sells the house at the end. A mortgage payment is not a cost — part of
//     it is savings — and rent is not the whole cost of renting either.
//
//  2. OPPORTUNITY COST is a first-class line item on both sides. A down
//     payment isn't spent, it's tied up: money in the house is money not in
//     the market. Every dollar either path pays out is compounded forward at
//     the investment return rate to the end of the horizon, so the totals are
//     stated in end-of-horizon dollars. This is what makes a 20% down payment
//     expensive when markets return 7%, and cheap when they return 2%.
//     Renting gets the same treatment on its deposit and broker fee, so
//     neither side is flattered.
//
//  3. THE TAX BENEFIT IS THE EXCESS OVER THE STANDARD DEDUCTION, not the
//     whole mortgage interest bill. A renter gets the standard deduction for
//     free; an owner only gains from the amount by which itemizing beats it.
//     Since the standard deduction roughly doubled in 2018 this is zero for
//     most buyers, and calculators that quietly credit the full interest
//     deduction overstate ownership by thousands a year. The SALT cap and the
//     mortgage interest debt limit are both applied before that comparison.
//
//  4. IT SOLVES FOR THE BREAK-EVEN RENT. The output that actually decides
//     anything isn't a total, it's "buying beats renting if a comparable
//     place rents for more than $X a month". Rent enters the model linearly
//     (rent, deposit and broker fee all scale with it), so the break-even is
//     an exact solve, not a search.
//
//  5. IT PRICES THE UNGLAMOROUS COSTS. Maintenance, insurance, closing costs
//     both ways, the 5–6% that vanishes at sale, HOA dues, the extra
//     utilities on a place bigger than your rental. These decide the answer
//     as often as the interest rate does, and they're the ones left out.
//
// Where this file departs from NYT, it says so in a comment.

import { monthlyPayment, remainingBalance, PMI_REQUEST_LTV } from './mortgage.js';

// 2025 figures, post-OBBBA. All three are editable in the UI because they
// move, and because the SALT cap in particular is scheduled to fall back to
// $10,000 in 2030 and phases down above ~$500k of income.
export const TAX_YEAR = 2025;
export const STANDARD_DEDUCTION = { single: 15750, married: 31500, head: 23625 };
export const SALT_CAP = 40000;
// Interest is deductible on the first $750k of acquisition debt for loans
// taken after 15 Dec 2017 ($1M for older ones).
export const INTEREST_DEBT_CAP = 750000;
// Section 121 exclusion on the gain from a main home lived in 2 of the last 5.
export const GAIN_EXCLUSION = { single: 250000, married: 500000, head: 250000 };

export const FILING_STATUSES = [
  { id: 'single', label: 'Single' },
  { id: 'married', label: 'Married filing jointly' },
  { id: 'head', label: 'Head of household' },
];

export const DEFAULTS = {
  // The purchase
  price: 425000,
  years: 7,
  downPct: 20,
  mortgageRatePct: 6.5,
  termYears: 30,
  pmiAnnualPct: 0.5,

  // Future
  homeGrowthPct: 3,
  rentGrowthPct: 3,
  investmentReturnPct: 5,
  inflationPct: 2.5,

  // Taxes
  filingStatus: 'married',
  marginalTaxPct: 24,
  propertyTaxPct: 1.1,
  otherSaltAnnual: 0,
  otherItemizedAnnual: 0,
  standardDeduction: STANDARD_DEDUCTION.married,
  saltCap: SALT_CAP,
  interestDebtCap: INTEREST_DEBT_CAP,
  capGainsRatePct: 15,
  applyGainExclusion: true,

  // Owning
  maintenancePct: 1,
  homeInsurancePct: 0.55,
  hoaMonthly: 0,
  hoaDeductiblePct: 0,
  extraUtilitiesMonthly: 100,
  buyClosingPct: 2,
  sellClosingPct: 6,

  // Renting
  monthlyRent: 2400,
  rentersInsuranceMonthly: 15,
  securityDepositMonths: 1,
  brokerFeePct: 0,
};

/** Annual percentage → effective monthly growth, so annual figures land exactly. */
function monthlyGrowth(annualPct) {
  return Math.pow(1 + (Number(annualPct) || 0) / 100, 1 / 12) - 1;
}

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Run both paths to the horizon and total them up.
 *
 * Every figure returned is in END-OF-HORIZON dollars: costs are compounded
 * forward at the investment return rate rather than discounted back. That is
 * the NYT presentation, and it's the one where "opportunity cost" reads as a
 * line item you can point at instead of a discount rate buried in the math.
 */
export function analyzeBuyVsRent(inputRaw = {}) {
  const input = { ...DEFAULTS, ...inputRaw };
  const years = Math.max(1, Math.round(num(input.years, 1)));
  const N = years * 12;

  const price = Math.max(0, num(input.price));
  const downPct = Math.min(100, Math.max(0, num(input.downPct)));
  const downPayment = price * downPct / 100;
  const loan = Math.max(0, price - downPayment);
  const termYears = Math.max(1, num(input.termYears, 30));
  const termMonths = Math.round(termYears * 12);
  const rateM = num(input.mortgageRatePct) / 100 / 12;
  const pi = monthlyPayment(loan, input.mortgageRatePct, termYears);

  const gHome = monthlyGrowth(input.homeGrowthPct);
  const gRent = monthlyGrowth(input.rentGrowthPct);
  const gInfl = monthlyGrowth(input.inflationPct);
  const rInvest = monthlyGrowth(input.investmentReturnPct);

  const marginal = num(input.marginalTaxPct) / 100;
  const standardDeduction = Math.max(0, num(input.standardDeduction));
  const saltCap = Math.max(0, num(input.saltCap));
  const interestCap = Math.max(0, num(input.interestDebtCap));

  const pmiMonthly = price > 0 && loan / price > PMI_REQUEST_LTV
    ? loan * num(input.pmiAnnualPct) / 100 / 12
    : 0;
  const pmiStopBalance = price * PMI_REQUEST_LTV;

  // ── Buying: initial cash out ──────────────────────────────────────────
  const buyClosing = price * num(input.buyClosingPct) / 100;
  const buyInitial = downPayment + buyClosing;

  // ── Buying: month by month ────────────────────────────────────────────
  const gross = { mortgage: 0, propertyTax: 0, maintenance: 0, insurance: 0, hoa: 0, utilities: 0, pmi: 0 };
  let taxBenefit = 0;
  let opportunityBuy = buyInitial * (Math.pow(1 + rInvest, N) - 1);
  let recurringBuyNet = 0;
  let balance = loan;
  let yearInterest = 0;
  let yearPropertyTax = 0;
  let yearHoaDeductible = 0;
  let yearStartBalance = loan;
  const monthlyBuySeries = [];

  const hoaDeductibleShare = Math.min(100, Math.max(0, num(input.hoaDeductiblePct))) / 100;

  for (let t = 1; t <= N; t++) {
    const homeValue = price * Math.pow(1 + gHome, t);

    let interest = 0;
    let mortgagePay = 0;
    if (t <= termMonths && balance > 0.005) {
      interest = balance * rateM;
      const principalPart = Math.min(Math.max(0, pi - interest), balance);
      balance -= principalPart;
      mortgagePay = principalPart + interest;
    }

    // Property tax, maintenance and insurance all track the home's value.
    // Assessment caps (California's Prop 13, Florida's Save Our Homes) would
    // make the tax grow slower than this; the model doesn't know your state,
    // so it uses market value and the notes say so.
    const propertyTax = homeValue * num(input.propertyTaxPct) / 100 / 12;
    const maintenance = homeValue * num(input.maintenancePct) / 100 / 12;
    const insurance = homeValue * num(input.homeInsurancePct) / 100 / 12;
    const hoa = num(input.hoaMonthly) * Math.pow(1 + gInfl, t - 1);
    const utilities = num(input.extraUtilitiesMonthly) * Math.pow(1 + gInfl, t - 1);
    const pmi = pmiMonthly > 0 && balance > pmiStopBalance ? pmiMonthly : 0;

    gross.mortgage += mortgagePay;
    gross.propertyTax += propertyTax;
    gross.maintenance += maintenance;
    gross.insurance += insurance;
    gross.hoa += hoa;
    gross.utilities += utilities;
    gross.pmi += pmi;

    yearInterest += interest;
    yearPropertyTax += propertyTax;
    yearHoaDeductible += hoa * hoaDeductibleShare;

    let outflow = mortgagePay + propertyTax + maintenance + insurance + hoa + utilities + pmi;

    // Settle the year's deductions in the month the tax year closes. A refund
    // arrives later than that in practice; a month of interest on it is noise
    // next to everything else in here.
    if (t % 12 === 0) {
      const avgBalance = (yearStartBalance + balance) / 2;
      // Interest on acquisition debt above the cap isn't deductible; the
      // deductible share is the capped debt over the average balance.
      const deductibleShare = avgBalance > interestCap && interestCap > 0
        ? interestCap / avgBalance
        : 1;
      const deductibleInterest = yearInterest * deductibleShare;
      const salt = Math.min(saltCap, yearPropertyTax + num(input.otherSaltAnnual));
      const itemized = deductibleInterest + salt + yearHoaDeductible + num(input.otherItemizedAnnual);
      // The renter takes the standard deduction for nothing, so only the
      // excess is a benefit of owning. This is the single biggest reason
      // naive calculators overstate buying.
      const benefit = Math.max(0, itemized - standardDeduction) * marginal;
      taxBenefit += benefit;
      outflow -= benefit;
      yearInterest = 0;
      yearPropertyTax = 0;
      yearHoaDeductible = 0;
      yearStartBalance = balance;
    }

    recurringBuyNet += outflow;
    opportunityBuy += outflow * (Math.pow(1 + rInvest, N - t) - 1);
    monthlyBuySeries.push({ month: t, outflow, balance, homeValue });
  }

  // ── Buying: the sale ──────────────────────────────────────────────────
  const saleValue = price * Math.pow(1 + gHome, N);
  const sellingCosts = saleValue * num(input.sellClosingPct) / 100;
  const payoff = remainingBalance(loan, input.mortgageRatePct, termYears, Math.min(N, termMonths));
  // Basis is the purchase price. Capitalizable closing costs and improvements
  // would raise it and cut the tax; leaving them out is the conservative side.
  const gain = Math.max(0, saleValue - sellingCosts - price);
  const exclusion = input.applyGainExclusion
    ? (GAIN_EXCLUSION[input.filingStatus] ?? GAIN_EXCLUSION.single)
    : 0;
  const capGainsTax = Math.max(0, gain - exclusion) * num(input.capGainsRatePct) / 100;
  const netProceeds = saleValue - sellingCosts - payoff - capGainsTax;

  const buyTotal = buyInitial + recurringBuyNet + opportunityBuy - netProceeds;

  const buy = {
    initial: buyInitial,
    downPayment,
    buyClosing,
    loan,
    monthlyPI: pi,
    pmiMonthly,
    recurringGross: Object.values(gross).reduce((s, v) => s + v, 0),
    components: gross,
    taxBenefit,
    recurringNet: recurringBuyNet,
    opportunity: opportunityBuy,
    saleValue,
    sellingCosts,
    payoff,
    gain,
    exclusion,
    capGainsTax,
    netProceeds,
    total: buyTotal,
  };

  const rent = rentSide(input, { N, gRent, gInfl, rInvest });
  const rentTotal = rent.total;

  // ── Break-even rent ───────────────────────────────────────────────────
  // Rent enters the total linearly — rent itself, the deposit and the broker
  // fee all scale with it — so two evaluations pin the line exactly.
  const at0 = rentSide({ ...input, monthlyRent: 0 }, { N, gRent, gInfl, rInvest }).total;
  const at1000 = rentSide({ ...input, monthlyRent: 1000 }, { N, gRent, gInfl, rInvest }).total;
  const slope = (at1000 - at0) / 1000;
  const breakEvenRent = slope > 0 ? (buyTotal - at0) / slope : null;

  return {
    years,
    months: N,
    buy,
    rent,
    breakEvenRent,
    // Positive means buying costs more over this horizon.
    difference: buyTotal - rentTotal,
    verdict: buyTotal < rentTotal ? 'buy' : buyTotal > rentTotal ? 'rent' : 'even',
    monthlyBuySeries,
    input,
  };
}

/** The renting path. Split out because the break-even solve re-runs it. */
function rentSide(input, { N, gRent, gInfl, rInvest }) {
  const rent0 = Math.max(0, num(input.monthlyRent));
  const deposit = rent0 * Math.max(0, num(input.securityDepositMonths));
  const brokerFee = rent0 * 12 * num(input.brokerFeePct) / 100;
  const initial = deposit + brokerFee;

  let rentPaid = 0;
  let insurancePaid = 0;
  let opportunity = initial * (Math.pow(1 + rInvest, N) - 1);

  for (let t = 1; t <= N; t++) {
    const r = rent0 * Math.pow(1 + gRent, t - 1);
    const ins = num(input.rentersInsuranceMonthly) * Math.pow(1 + gInfl, t - 1);
    rentPaid += r;
    insurancePaid += ins;
    opportunity += (r + ins) * (Math.pow(1 + rInvest, N - t) - 1);
  }

  // The deposit comes back at the end. Nominal — most states pay little or no
  // interest on it, and the opportunity cost above already charges for the
  // years it sat there.
  const netProceeds = deposit;
  const recurring = rentPaid + insurancePaid;

  return {
    initial,
    deposit,
    brokerFee,
    rentPaid,
    insurancePaid,
    recurring,
    opportunity,
    netProceeds,
    firstMonthRent: rent0,
    lastMonthRent: rent0 * Math.pow(1 + gRent, Math.max(0, N - 1)),
    total: initial + recurring + opportunity - netProceeds,
  };
}

/**
 * The same comparison run at every horizon from 1 to `maxYears`, which is what
 * answers "how long do I have to stay for this to pay off?".
 *
 * Each year is its own self-contained comparison — buy and sell in year 3, buy
 * and sell in year 4 — so the two curves are only comparable against each
 * other within a year, not across years. That's the honest way to draw it:
 * selling in year 3 really does mean eating the transaction costs over three
 * years, and the curve crossing is exactly the break-even.
 */
export function horizonSeries(input, maxYears = 30) {
  const out = [];
  let crossover = null;
  for (let y = 1; y <= maxYears; y++) {
    const r = analyzeBuyVsRent({ ...input, years: y });
    const row = {
      year: y,
      buyTotal: r.buy.total,
      rentTotal: r.rent.total,
      breakEvenRent: r.breakEvenRent,
      difference: r.buy.total - r.rent.total,
    };
    out.push(row);
    if (crossover == null && row.buyTotal <= row.rentTotal) crossover = y;
  }
  return { rows: out, crossover };
}
