// Month-over-month net worth snapshot.
//
// This is the model behind the "Snapshot" view on the Net Worth page: pick two
// months, and see every account's balance in the first, what it was in the
// second, and the roll-up totals that actually drive decisions —
// how much is locked in retirement, how much is liquid, and how much of the
// liquid pile survives the tax bill if it were sold today.
//
// Two independent labels hang off each account:
//
//   • Category       — Retirement / Liquid Assets / Non Liquid Assets /
//                      Liabilities / Excluded. Drives the top-line totals.
//   • Liquid category — Stocks - House / Stocks / Cash. Only meaningful for
//                      Liquid Assets; it splits the liquid pile into the part
//                      that would be sold (and taxed) and the part that is
//                      already spendable.
//
// "Stocks - House" is the bucket earmarked for a purchase, so it is the only
// one carrying a tax haircut — the rest is not being sold, so no tax is owed
// on it yet. The rate is a user setting, not a tax calculation; see
// lib/taxes.js for the real estimator.

export const CATEGORY_RETIREMENT = 'Retirement';
export const CATEGORY_LIQUID = 'Liquid Assets';
export const CATEGORY_NON_LIQUID = 'Non Liquid Assets';
export const CATEGORY_LIABILITIES = 'Liabilities';
export const CATEGORY_EXCLUDED = 'Excluded';

export const ACCOUNT_CATEGORIES = [
  CATEGORY_RETIREMENT,
  CATEGORY_LIQUID,
  CATEGORY_NON_LIQUID,
  CATEGORY_LIABILITIES,
  CATEGORY_EXCLUDED,
];

export const LIQUID_STOCKS_HOUSE = 'Stocks - House';
export const LIQUID_STOCKS = 'Stocks';
export const LIQUID_CASH = 'Cash';

export const LIQUID_CATEGORIES = [LIQUID_STOCKS_HOUSE, LIQUID_STOCKS, LIQUID_CASH];

// Only the house bucket is assumed to be sold, so only it is taxed.
export const TAXED_LIQUID_CATEGORY = LIQUID_STOCKS_HOUSE;

// A placeholder rate, not an estimate. The Tax on Selling page does the real
// arithmetic; this is the blended number the user wants the snapshot to net
// out at.
export const DEFAULT_SALE_TAX_RATE = 0.10;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Parse the date strings Tiller writes into Balance History. Both `2026-04-30`
 * and `4/30/2026` show up depending on the sheet's locale. Built as local
 * dates on purpose — `new Date('2026-04-01')` is UTC midnight, which lands in
 * March for anyone west of Greenwich and would file the row under the wrong
 * month.
 */
export function parseSheetDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** 'YYYY-MM' — sorts lexicographically, which is why it is the map key. */
export function monthKeyOf(date) {
  if (!date) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(key) {
  if (!key) return '—';
  const [y, m] = key.split('-');
  const idx = Number(m) - 1;
  if (!MONTH_NAMES[idx]) return key;
  return `${MONTH_NAMES[idx]} ${y}`;
}

export function monthLabelShort(key) {
  if (!key) return '—';
  const [y, m] = key.split('-');
  const idx = Number(m) - 1;
  if (!MONTH_NAMES[idx]) return key;
  return `${MONTH_NAMES[idx].slice(0, 3)} ${y.slice(2)}`;
}

// ── Default classification ───────────────────────────────────────────────
// Every account starts with a guess so the view is useful before the user has
// labelled anything. The guess reads the asset class they already assigned on
// the Overview page first, then falls back to the account's name.

const RETIREMENT_PATTERNS = /\b(401\s*\(?k\)?|403\s*\(?b\)?|457|ira|roth|pension|hsa|tsp|retirement)\b/i;
const CASH_PATTERNS = /\b(checking|chequing|savings|saving|cash|money\s*market|venmo|paypal|zelle|banking|debit|deposit)\b/i;

/**
 * Best guess at an account's category. `assetClass` is the Cash/Stocks/
 * Retirement label from the Overview page's Asset Allocation card, when set.
 */
export function guessCategory(account, assetClass) {
  if (!account) return CATEGORY_EXCLUDED;
  if (account.side === 'liability') return CATEGORY_LIABILITIES;
  if (assetClass === 'Retirement') return CATEGORY_RETIREMENT;
  if (assetClass === 'Cash' || assetClass === 'Stocks') return CATEGORY_LIQUID;
  if (RETIREMENT_PATTERNS.test(account.name || '')) return CATEGORY_RETIREMENT;
  // A custom asset is something Tiller can't see — a house, a car, a private
  // holding. Those are the illiquid ones by definition.
  if (account.custom) return CATEGORY_NON_LIQUID;
  return CATEGORY_LIQUID;
}

/**
 * Best guess at an account's liquid category. Returns null for anything that
 * isn't liquid, since the column is meaningless there.
 */
export function guessLiquidCategory(account, assetClass, category) {
  if (category !== CATEGORY_LIQUID) return null;
  if (assetClass === 'Cash') return LIQUID_CASH;
  if (assetClass === 'Stocks') return LIQUID_STOCKS_HOUSE;
  if (CASH_PATTERNS.test(account?.name || '')) return LIQUID_CASH;
  return LIQUID_STOCKS_HOUSE;
}

// ── Monthly balances ─────────────────────────────────────────────────────

/**
 * Collapse Balance History into one forward-filled balance per account per
 * month.
 *
 * A month's entry holds every account's balance as of the last snapshot on or
 * before that month's end — so an account that only reports quarterly still
 * counts in the months between. `reported` records which accounts actually
 * posted a row inside the month, which is what separates "this balance is
 * current" from "this balance is the last one we saw".
 *
 * Months with no snapshots at all are absent from the result; they'd be pure
 * carry-forward with nothing to say.
 *
 * @param {Array<{date: string, account: string, balance: number}>} balanceHistory
 * @returns {Array<{key: string, balances: Map<string, number>, reported: Set<string>}>}
 *   ascending by month.
 */
export function buildMonthlyBalances(balanceHistory) {
  const rows = [];
  for (const r of balanceHistory || []) {
    if (!r || !r.account || !r.date) continue;
    const d = parseSheetDate(r.date);
    if (!d) continue;
    rows.push({ t: d.getTime(), key: monthKeyOf(d), account: r.account, balance: r.balance || 0 });
  }
  if (!rows.length) return [];
  rows.sort((a, b) => a.t - b.t);

  const months = [];
  const running = new Map();
  let currentKey = null;
  let reported = null;

  for (const r of rows) {
    if (r.key !== currentKey) {
      if (currentKey) months.push({ key: currentKey, balances: new Map(running), reported });
      currentKey = r.key;
      reported = new Set();
    }
    running.set(r.account, r.balance);
    reported.add(r.account);
  }
  if (currentKey) months.push({ key: currentKey, balances: new Map(running), reported });
  return months;
}

/**
 * Roll a month's balances up into the summary lines.
 *
 * `classify(name)` returns `{ category, liquidCategory }` for an account.
 * Amounts are taken at face value except liabilities, which are summed by
 * absolute value — Tiller records debt as negative on some accounts and
 * positive on others, and the difference is a data-entry accident, not a
 * signal.
 */
export function summarizeMonth(balances, classify, saleTaxRate = DEFAULT_SALE_TAX_RATE) {
  const out = {
    retirement: 0,
    liquidAssets: 0,
    nonLiquid: 0,
    liabilities: 0,
    stocks: 0,
    stocksTaxed: 0,   // the slice the haircut applies to
    stocksHeld: 0,    // the slice assumed not to be sold
    cash: 0,
  };
  if (!balances) return finishSummary(out, saleTaxRate);

  for (const [name, value] of balances) {
    const amount = value || 0;
    const { category, liquidCategory } = classify(name);
    if (category === CATEGORY_RETIREMENT) out.retirement += amount;
    else if (category === CATEGORY_NON_LIQUID) out.nonLiquid += amount;
    else if (category === CATEGORY_LIABILITIES) out.liabilities += Math.abs(amount);
    else if (category === CATEGORY_LIQUID) {
      out.liquidAssets += amount;
      if (liquidCategory === LIQUID_CASH) out.cash += amount;
      else if (liquidCategory === TAXED_LIQUID_CATEGORY) { out.stocks += amount; out.stocksTaxed += amount; }
      else if (liquidCategory === LIQUID_STOCKS) { out.stocks += amount; out.stocksHeld += amount; }
    }
  }
  return finishSummary(out, saleTaxRate);
}

function finishSummary(out, saleTaxRate) {
  const rate = Number.isFinite(saleTaxRate) ? saleTaxRate : 0;
  // A loss isn't taxed on sale, so the haircut only bites on a positive
  // balance. Without this a negative bucket would be credited tax it never
  // paid.
  out.saleTax = Math.max(out.stocksTaxed, 0) * rate;
  out.stocksLessTax = out.stocks - out.saleTax;
  out.investable = out.stocksLessTax + out.cash;
  // The headline the sheet calls "Total": what is actually accumulating.
  // Non-liquid holdings and debts sit on their own lines below it.
  out.total = out.retirement + out.liquidAssets;
  out.netWorth = out.total + out.nonLiquid - out.liabilities;
  return out;
}

/** change / |base|, or null when there is no base to divide by. */
export function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}
