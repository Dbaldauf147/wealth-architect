// Demo mode: make every figure on the site untrue without making it look
// untrue.
//
// The approach is to scale money and share counts by one secret factor and
// leave everything else alone. Percentages, dates, ratios and per-share prices
// are already unidentifying, and keeping them real is what stops the result
// looking like mangled test data — a position still shows the right gain, a
// budget still sits at the right fraction of its cap, a chart keeps its shape.
//
// Because share counts scale by the same factor as money, shares × price still
// equals the displayed value, so nothing contradicts itself. Nobody can invert
// the factor from a percentage, and reading an absolute number tells them
// nothing about the real one.
//
// The honest limits, which the UI states rather than hides:
//   • It defends against someone reading the screen, not someone opening
//     devtools or localStorage — the factor is on the machine.
//   • Ticker symbols stay real. Position *sizes* are hidden, but that someone
//     holds NVDA is visible. Names of merchants and accounts are replaced.
//   • Relative information survives by design: that one holding dwarfs another
//     is exactly what makes the demo worth showing.

// Deterministic 32-bit hash, so the same input always yields the same alias
// within a session and the screen stays stable while someone looks at it.
function hash(str) {
  let h = 2166136261;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = (pool, key, salt) => pool[hash(`${salt}:${key}`) % pool.length];

// Plausible stand-ins. Recognisable *kinds* of thing, so the screen still
// reads as a real financial app rather than obviously scrambled output.
const ACCOUNT_NAMES = [
  'Everyday Checking', 'Household Savings', 'Joint Checking', 'Emergency Fund',
  'Blue Rewards Card', 'Travel Card', 'Cashback Card', 'Store Card',
  'Brokerage', 'Retirement Account', 'Money Market', 'Certificate Account',
  'Auto Loan', 'Home Loan', 'Student Loan', 'Line of Credit',
];

const MERCHANTS = [
  'Corner Cafe', 'Metro Grocery', 'Riverside Market', 'Union Pharmacy',
  'Fleet Fuel', 'City Transit', 'Northside Utilities', 'Harbour Insurance',
  'Bright Fitness', 'Parkview Dental', 'Lakeside Hardware', 'Orchard Bakery',
  'Summit Outfitters', 'Crescent Diner', 'Willow Books', 'Anchor Supply',
  'Pinewood Vet', 'Granite Telecom', 'Beacon Streaming', 'Copperfield Deli',
  'Stonebridge Cleaners', 'Maple Garden Centre', 'Ridgeway Autocare',
  'Elmwood Pizza', 'Tidewater Coffee', 'Foxglove Florist',
];

/**
 * Build the transformer for a session.
 *
 * `seed` fixes both the factor and every alias, so the same account keeps the
 * same fake name for as long as the seed lives. It is generated once and
 * stored, not derived from the data, so nothing about the real figures leaks
 * into it.
 */
export function makeScrambler(seed) {
  // Two bands, well clear of 1. A uniform range would sometimes land near
  // 1.0 and the "anonymised" figure would then sit within a few percent of
  // the real one — which is worse than useless, because it looks anonymised
  // while telling the viewer the truth. Whichever band is drawn, an amount on
  // screen is at least a third out and can be triple.
  const roll = hash(`factor:${seed}`);
  const spread = (roll % 10000) / 10000;
  const factor = (roll & 1)
    ? 0.28 + spread * 0.34   // 0.28 – 0.62
    : 1.60 + spread * 1.90;  // 1.60 – 3.50

  const money = (n) => (Number.isFinite(n) ? n * factor : n);

  const accountName = (name) => {
    if (!name) return name;
    const alias = pick(ACCOUNT_NAMES, name, seed);
    // Keep a trailing 4-digit marker where the real name had one, since
    // several pages key off "card ending in ####" being present.
    return /\d{4}\s*$/.test(String(name))
      ? `${alias} ${1000 + (hash(`digits:${seed}:${name}`) % 9000)}`
      : alias;
  };

  const accountNumber = (num) => {
    if (!num) return num;
    return String(1000 + (hash(`digits:${seed}:${num}`) % 9000));
  };

  const description = (desc) => {
    if (!desc) return desc;
    return pick(MERCHANTS, String(desc).trim().toLowerCase(), seed);
  };

  return { factor, money, accountName, accountNumber, description };
}

const mapValues = (obj, fn) => {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v, k);
  return out;
};

/** Rewrite the keys of a name-keyed map through the alias function. */
const rekey = (obj, keyFn, valueFn = (v) => v) => {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[keyFn(k)] = valueFn(v);
  return out;
};

export function scrambleTransactions(transactions, s) {
  return (transactions || []).map(t => ({
    ...t,
    amount: s.money(t.amount),
    account: s.accountName(t.account),
    accountNum: s.accountNumber(t.accountNum),
    description: s.description(t.description),
    // `fullDescription` and `notes` are free text the user typed or the bank
    // supplied; both can name a person or a place.
    fullDescription: t.fullDescription ? s.description(t.fullDescription) : t.fullDescription,
    note: t.note ? '' : t.note,
  }));
}

export function scrambleBalances(balances, s) {
  if (!balances) return balances;
  const line = (a) => ({ ...a, name: s.accountName(a.name), balance: s.money(a.balance) });
  return {
    ...balances,
    assets: (balances.assets || []).map(line),
    liabilities: (balances.liabilities || []).map(line),
    totalAssets: s.money(balances.totalAssets),
    totalLiabilities: s.money(balances.totalLiabilities),
    netWorth: s.money(balances.netWorth),
  };
}

export function scrambleBalanceHistory(history, s) {
  return (history || []).map(r => ({
    ...r,
    account: s.accountName(r.account),
    balance: s.money(r.balance),
  }));
}

/**
 * Trades scale by quantity and cash, never by price.
 *
 * Share counts move with the same factor as the money, so quantity × the real
 * market price still equals the scaled position value. Leaving prices alone
 * keeps them checkable against the outside world without exposing size.
 */
export function scrambleRobinhood(stored, s) {
  if (!stored) return stored;
  const cash = (rows) => (rows || []).map(r => ({ ...r, amount: s.money(r.amount) }));
  return {
    ...stored,
    trades: (stored.trades || []).map(t => ({
      ...t,
      quantity: s.money(t.quantity),
      amount: s.money(t.amount),
      // price deliberately untouched
    })),
    corporateActions: (stored.corporateActions || []).map(a => ({
      ...a,
      quantity: Number.isFinite(a.quantity) ? s.money(a.quantity) : a.quantity,
      // The trailing-'S' marker carries direction, so rebuild it rather than
      // leaving a raw string that no longer matches the scaled quantity.
      quantityRaw: typeof a.quantityRaw === 'string' && /s\s*$/i.test(a.quantityRaw)
        ? `${s.money(a.quantity)}S`
        : String(s.money(a.quantity) ?? ''),
    })),
    income: cash(stored.income),
    transfers: cash(stored.transfers),
    otherCash: cash(stored.otherCash),
  };
}

export function scrambleCustomItems(items, s) {
  return (items || []).map(a => ({ ...a, name: s.accountName(a.name), balance: s.money(a.balance) }));
}

export function scrambleLoan(loan, s) {
  if (!loan) return loan;
  return {
    ...loan,
    name: loan.name ? s.accountName(loan.name) : loan.name,
    lender: loan.lender ? s.accountName(loan.lender) : loan.lender,
    note: '',
    principal: s.money(loan.principal),
    payments: (loan.payments || []).map(p => ({ ...p, amount: s.money(p.amount), note: '' })),
  };
}

/** Name-keyed lookups have to follow the aliases or they stop matching. */
export function scrambleAccountMaps(maps, s) {
  return {
    accountNicknames: rekey(maps.accountNicknames, s.accountName, s.accountName),
    accountNumbers: rekey(maps.accountNumbers, s.accountName, s.accountNumber),
    accountGroups: rekey(maps.accountGroups, s.accountName),
    assetClasses: rekey(maps.assetClasses, s.accountName),
  };
}

export function scrambleHiddenCards(cards, s) {
  return (cards || []).map(s.accountName);
}

export function scramblePaymentPrefs(prefs, s) {
  if (!prefs) return prefs;
  return {
    ...prefs,
    payingAccountLast4: prefs.payingAccountLast4
      ? s.accountNumber(prefs.payingAccountLast4)
      : prefs.payingAccountLast4,
  };
}

export function scrambleNotes(notes) {
  // Free text the user wrote about a transaction — drop it wholesale rather
  // than trying to decide which notes are safe.
  return mapValues(notes, () => '');
}
