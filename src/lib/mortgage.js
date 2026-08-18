// Mortgage math: what the payment is, where it goes, and when it ends.
//
// Everything here works on a monthly schedule rather than a closed-form
// formula, because the interesting questions all break the closed form:
// an extra $200 a month, a lump sum in year three, PMI that falls away the
// month the balance crosses a threshold. Running the schedule is cheap
// (360 iterations) and it is the only way those answers stay consistent
// with each other.
//
// Rates are taken as percentages (6.5 means 6.5%), because that is what the
// user types and converting once at the edge beats converting everywhere.

/** Monthly compounding rate from an annual percentage. */
export function monthlyRate(annualPct) {
  return (Number(annualPct) || 0) / 100 / 12;
}

/**
 * Level payment that retires `principal` over `termYears` — the standard
 * amortization formula. A 0% loan divides evenly instead, which the formula
 * cannot do (it divides by zero).
 */
export function monthlyPayment(principal, annualRatePct, termYears) {
  const P = Number(principal) || 0;
  const n = Math.round((Number(termYears) || 0) * 12);
  if (P <= 0 || n <= 0) return 0;
  const i = monthlyRate(annualRatePct);
  if (i === 0) return P / n;
  const factor = Math.pow(1 + i, n);
  return P * i * factor / (factor - 1);
}

/**
 * Balance after `monthsElapsed` payments on the original schedule — no extra
 * payments. Used where a full schedule would be overkill, e.g. the payoff
 * figure at the end of a buy-vs-rent horizon.
 */
export function remainingBalance(principal, annualRatePct, termYears, monthsElapsed) {
  const P = Number(principal) || 0;
  const n = Math.round((Number(termYears) || 0) * 12);
  const m = Math.min(Math.max(0, Math.round(monthsElapsed)), n);
  if (P <= 0 || n <= 0) return 0;
  const i = monthlyRate(annualRatePct);
  if (i === 0) return Math.max(0, P * (1 - m / n));
  const pay = monthlyPayment(P, annualRatePct, termYears);
  const grown = Math.pow(1 + i, m);
  return Math.max(0, P * grown - pay * (grown - 1) / i);
}

// Private mortgage insurance comes off when the loan is small enough relative
// to the home's *original* value. Two thresholds matter and they are not the
// same: a servicer must cancel automatically at 78%, but the borrower can
// request cancellation at 80% and most do, so 80% is the default here. The
// UI says which one it used.
export const PMI_REQUEST_LTV = 0.80;
export const PMI_AUTO_LTV = 0.78;

/**
 * Full monthly schedule, including extra payments and PMI.
 *
 * `extraMonthly` is applied every month; `lumpSums` is a list of
 * `{ month, amount }` one-off payments (month 1 = first payment). Both go
 * straight to principal, which is what shortens the loan.
 *
 * Returns the monthly rows, a per-year rollup, and the summary figures the
 * page shows. `baseline` is the same loan without extras, so the saving from
 * paying extra is a subtraction rather than a second call site.
 */
export function amortize({
  principal,
  annualRatePct,
  termYears,
  extraMonthly = 0,
  lumpSums = [],
  // PMI is a share of the original loan, charged monthly until the balance
  // drops below `pmiDropLtv` of the original home value.
  pmiAnnualPct = 0,
  homeValue = 0,
  pmiDropLtv = PMI_REQUEST_LTV,
  startDate = null,
}) {
  const P = Number(principal) || 0;
  const n = Math.round((Number(termYears) || 0) * 12);
  const i = monthlyRate(annualRatePct);
  const basePayment = monthlyPayment(P, annualRatePct, termYears);
  const extra = Math.max(0, Number(extraMonthly) || 0);
  const value = Number(homeValue) || 0;
  const pmiMonthly = value > 0 && P / value > pmiDropLtv
    ? P * ((Number(pmiAnnualPct) || 0) / 100) / 12
    : 0;
  const pmiStopBalance = value * pmiDropLtv;

  const lumpByMonth = new Map();
  for (const l of lumpSums || []) {
    const m = Math.round(Number(l?.month) || 0);
    const amt = Number(l?.amount) || 0;
    if (m > 0 && amt > 0) lumpByMonth.set(m, (lumpByMonth.get(m) || 0) + amt);
  }

  const start = startDate instanceof Date ? startDate : new Date();
  const rows = [];
  let balance = P;
  let cumInterest = 0;
  let cumPrincipal = 0;
  let cumPmi = 0;

  for (let m = 1; m <= n && balance > 0.005; m++) {
    const interest = balance * i;
    // The last payment is whatever is left, not a full instalment.
    let principalPart = Math.min(Math.max(0, basePayment - interest), balance);
    let extraPart = Math.min(extra + (lumpByMonth.get(m) || 0), balance - principalPart);
    if (extraPart < 0) extraPart = 0;
    const pmi = pmiMonthly > 0 && balance > pmiStopBalance ? pmiMonthly : 0;

    balance = balance - principalPart - extraPart;
    cumInterest += interest;
    cumPrincipal += principalPart + extraPart;
    cumPmi += pmi;

    rows.push({
      month: m,
      date: new Date(start.getFullYear(), start.getMonth() + m, 1),
      payment: principalPart + interest,
      interest,
      principal: principalPart,
      extra: extraPart,
      pmi,
      balance: Math.max(0, balance),
      cumInterest,
      cumPrincipal,
    });
  }

  // Per-calendar-year-of-loan rollup for the schedule table and the charts.
  const years = [];
  for (let y = 0; y * 12 < rows.length; y++) {
    const slice = rows.slice(y * 12, y * 12 + 12);
    if (!slice.length) break;
    const last = slice[slice.length - 1];
    years.push({
      year: y + 1,
      interest: slice.reduce((s, r) => s + r.interest, 0),
      principal: slice.reduce((s, r) => s + r.principal + r.extra, 0),
      pmi: slice.reduce((s, r) => s + r.pmi, 0),
      endBalance: last.balance,
      cumInterest: last.cumInterest,
      cumPrincipal: last.cumPrincipal,
      endDate: last.date,
    });
  }

  const months = rows.length;
  // `years` is the per-year rollup above — the scalar term is `payoffYears`,
  // deliberately not `years`, because one shadowing the other is a bug you
  // only find when something downstream tries to map over a number.
  const summary = {
    payment: basePayment,
    pmiMonthly,
    months,
    payoffYears: months / 12,
    totalInterest: cumInterest,
    totalPmi: cumPmi,
    totalPaid: cumInterest + cumPrincipal + cumPmi,
    payoffDate: rows.length ? rows[rows.length - 1].date : null,
    // Month the PMI charge stops, or null when there was never any.
    pmiEndsMonth: pmiMonthly > 0
      ? (rows.find(r => r.pmi === 0)?.month ?? null)
      : null,
  };

  return { rows, years, ...summary };
}

/**
 * The extras' effect, as the difference between two schedules. Returns null
 * when there are no extras, so callers can skip the panel entirely.
 */
export function extraPaymentSavings(args) {
  const extra = Math.max(0, Number(args.extraMonthly) || 0);
  const lumps = (args.lumpSums || []).filter(l => (Number(l?.amount) || 0) > 0);
  if (extra === 0 && lumps.length === 0) return null;
  const withExtra = amortize(args);
  const without = amortize({ ...args, extraMonthly: 0, lumpSums: [] });
  return {
    interestSaved: without.totalInterest - withExtra.totalInterest,
    pmiSaved: without.totalPmi - withExtra.totalPmi,
    monthsSaved: without.months - withExtra.months,
    payoffDate: withExtra.payoffDate,
    withExtra,
    without,
  };
}

/**
 * The whole monthly housing cost, not just the loan. The gap between "my
 * mortgage" and "what leaves my account" is mostly tax and insurance, and it
 * is routinely a third of the total.
 */
export function monthlyHousingCost({
  price,
  downPayment,
  annualRatePct,
  termYears,
  propertyTaxPct = 0,
  homeInsuranceAnnual = 0,
  hoaMonthly = 0,
  pmiAnnualPct = 0,
  maintenancePct = 0,
}) {
  const p = Number(price) || 0;
  const down = Math.min(Math.max(0, Number(downPayment) || 0), p);
  const loan = Math.max(0, p - down);
  const pi = monthlyPayment(loan, annualRatePct, termYears);
  const tax = p * ((Number(propertyTaxPct) || 0) / 100) / 12;
  const insurance = (Number(homeInsuranceAnnual) || 0) / 12;
  const hoa = Number(hoaMonthly) || 0;
  const pmi = p > 0 && loan / p > PMI_REQUEST_LTV
    ? loan * ((Number(pmiAnnualPct) || 0) / 100) / 12
    : 0;
  const maintenance = p * ((Number(maintenancePct) || 0) / 100) / 12;
  return {
    loan,
    downPct: p > 0 ? down / p : 0,
    principalAndInterest: pi,
    propertyTax: tax,
    insurance,
    hoa,
    pmi,
    maintenance,
    // PITI as lenders mean it — what they qualify you on. Maintenance is real
    // money but it isn't in the ratio, so it is kept separate.
    piti: pi + tax + insurance + hoa + pmi,
    total: pi + tax + insurance + hoa + pmi + maintenance,
  };
}

// Lenders' rules of thumb. The front-end ratio caps housing against income;
// the back-end ratio caps *all* debt. Conforming loans stretch to 43–50% on
// the back end, but 36% is the figure that leaves room to live.
export const DEFAULT_FRONT_END_DTI = 28;
export const DEFAULT_BACK_END_DTI = 36;

/**
 * Largest price whose housing cost fits both DTI limits and the cash on hand.
 *
 * Solved by bisection rather than algebra: PMI switches on below a 20% down
 * payment, which makes cost-as-a-function-of-price discontinuous, and a
 * closed form would either ignore that or quietly get it wrong.
 */
export function affordablePrice({
  annualIncome,
  monthlyDebts = 0,
  downPayment = 0,
  annualRatePct,
  termYears = 30,
  propertyTaxPct = 1.1,
  homeInsurancePct = 0.55,
  hoaMonthly = 0,
  pmiAnnualPct = 0.5,
  frontEndDti = DEFAULT_FRONT_END_DTI,
  backEndDti = DEFAULT_BACK_END_DTI,
}) {
  const income = Math.max(0, Number(annualIncome) || 0) / 12;
  const debts = Math.max(0, Number(monthlyDebts) || 0);
  const cash = Math.max(0, Number(downPayment) || 0);
  const frontCap = income * ((Number(frontEndDti) || 0) / 100);
  const backCap = Math.max(0, income * ((Number(backEndDti) || 0) / 100) - debts);
  const budget = Math.min(frontCap, backCap);
  if (budget <= 0) {
    return { maxPrice: 0, budget: 0, frontCap, backCap, limitedBy: 'income', cost: null };
  }

  const costAt = (price) => monthlyHousingCost({
    price,
    downPayment: Math.min(cash, price),
    annualRatePct,
    termYears,
    propertyTaxPct,
    homeInsuranceAnnual: price * ((Number(homeInsurancePct) || 0) / 100),
    hoaMonthly,
    pmiAnnualPct,
  }).piti;

  // The cost is monotonic in price, so bisect. 40 halvings takes a $10M
  // bracket below a dollar of error.
  let lo = 0;
  let hi = 10_000_000;
  if (costAt(hi) <= budget) return finish(hi);
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (costAt(mid) <= budget) lo = mid; else hi = mid;
  }
  return finish(lo);

  function finish(price) {
    const cost = monthlyHousingCost({
      price,
      downPayment: Math.min(cash, price),
      annualRatePct,
      termYears,
      propertyTaxPct,
      homeInsuranceAnnual: price * ((Number(homeInsurancePct) || 0) / 100),
      hoaMonthly,
      pmiAnnualPct,
    });
    return {
      maxPrice: price,
      budget,
      frontCap,
      backCap,
      limitedBy: frontCap <= backCap ? 'housing ratio' : 'total debt ratio',
      cost,
      downPct: price > 0 ? Math.min(cash, price) / price : 0,
    };
  }
}
