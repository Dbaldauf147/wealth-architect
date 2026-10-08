/* Cash position: cash on hand minus what's owed on cards — how far above or
   below water you are right now, and at the end of each month.

   Built from Tiller's Balance History, one snapshot per account per day it
   synced. An account is:
     • cash — an asset that's spendable today: checking, savings, money
       market, a cash-management or deposit account;
     • debt — a liability (cards; Tiller writes what's owed as a positive);
     • other — investments, retirement, crypto. Not cash on hand, so left out.
   The split comes from the Class column with the name deciding what kind of
   asset it is; the page lets you switch any account in or out.

   An account whose snapshots stopped (closed, disconnected) shouldn't count
   its last balance forever: past STALE_DAYS without a snapshot it counts as
   zero from then on, and is flagged on the page.

   Pure: no React, no DOM. */

const DAY = 86400000;
export const STALE_DAYS = 35;

const CASH_NAME = /\b(checking|chequing|savings?|money market|cash management|cma|deposit|venmo|cash app|paypal|apple cash)\b/i;
const DEBT_NAME = /\b(credit card|card|rewards|visa|mastercard|amex|discover|loan|line of credit)\b/i;
const INVEST_NAME = /\b(401\s?\(?k\)?|ira|roth|brokerage|securities|crypto|individual|plan|offer|share|robinhood|trust|hsa)\b/i;

/** 'cash' | 'debt' | 'other' for one account, from its class and name. */
export function classifyAccount(name, cls) {
  const c = String(cls || '').toLowerCase();
  const n = String(name || '');
  if (c === 'liability') return 'debt';
  // "Employees Savings Plan" is a retirement plan, not a savings account: an
  // investment word anywhere in the name beats a cash word.
  if (c === 'asset') return CASH_NAME.test(n) && !INVEST_NAME.test(n) ? 'cash' : 'other';
  // No class (an older cached copy of the sheet): judge by name alone.
  if (DEBT_NAME.test(n)) return 'debt';
  if (CASH_NAME.test(n) && !INVEST_NAME.test(n)) return 'cash';
  return 'other';
}

/** One identity per account across renames: its last four digits when it has
 *  a number, otherwise its name. "Robinhood Brokerage …9179" and
 *  "Robinhood individual …9179" are the same account. */
export function accountKey(row) {
  const digits = String(row.accountNum || '').replace(/\D+/g, '').slice(-4);
  return digits ? `#${digits}|${classifyAccount(row.account, row.class)}` : `@${String(row.account || '').toLowerCase()}`;
}

const parseDay = s => {
  const d = new Date(s);
  return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/**
 * @param balanceHistory  rows of { date, account, accountNum, class, balance }
 * @param monthKeys       the window, oldest first ('YYYY-MM')
 * @param today
 * @param overrides       { [accountKey]: true|false } — include/exclude, beats the default
 * @returns {
 *   accounts: [{ key, name, last4, kind, included, latest, latestDate, stale }],
 *   months:   [{ key, cash, debt, net, asOf }],
 *   now:      { cash, debt, net, asOf } | null,
 * }
 */
export function buildCashPosition({ balanceHistory, monthKeys, today = new Date(), overrides = {} }) {
  const byAccount = new Map();
  let newest = null;
  for (const r of balanceHistory || []) {
    const date = parseDay(r.date);
    if (!date || date > today) continue;
    const key = accountKey(r);
    let a = byAccount.get(key);
    if (!a) {
      a = { key, names: {}, kind: classifyAccount(r.account, r.class), last4: String(r.accountNum || '').replace(/\D+/g, '').slice(-4), snaps: [] };
      byAccount.set(key, a);
    }
    a.names[r.account] = date > (a.names[r.account] || 0) ? date : a.names[r.account];
    a.snaps.push({ date, balance: Number(r.balance) || 0 });
    if (!newest || date > newest) newest = date;
  }
  if (!newest) return { accounts: [], months: [], now: null };

  const accounts = [];
  for (const a of byAccount.values()) {
    a.snaps.sort((x, y) => x.date - y.date);
    const last = a.snaps[a.snaps.length - 1];
    const name = Object.entries(a.names).sort((x, y) => y[1] - x[1])[0][0];  // most recent name
    const stale = (newest - last.date) / DAY > STALE_DAYS;
    const byDefault = a.kind === 'cash' || a.kind === 'debt';
    accounts.push({
      key: a.key,
      name,
      last4: a.last4,
      kind: a.kind,
      included: a.key in overrides ? !!overrides[a.key] : byDefault,
      latest: stale ? 0 : last.balance,
      lastBalance: last.balance,
      latestDate: last.date,
      stale,
      snaps: a.snaps,
    });
  }

  // An account's balance as of a day: its latest snapshot on or before it,
  // unless that snapshot is too old to trust (the account had stopped).
  const balanceOn = (acct, day) => {
    let lo = 0, hi = acct.snaps.length - 1, hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (acct.snaps[mid].date <= day) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (hit < 0) return 0;
    const s = acct.snaps[hit];
    return (day - s.date) / DAY > STALE_DAYS ? 0 : s.balance;
  };

  const counted = accounts.filter(a => a.included && a.kind !== 'other');
  // A switched-on "other" account counts as cash: the user is saying it's spendable.
  const extra = accounts.filter(a => a.included && a.kind === 'other');
  const position = day => {
    let cash = 0, debt = 0;
    for (const a of counted) {
      const b = balanceOn(a, day);
      if (a.kind === 'cash') cash += b; else debt += Math.abs(b);
    }
    for (const a of extra) cash += balanceOn(a, day);
    const r = n => Math.round(n * 100) / 100;
    return { cash: r(cash), debt: r(debt), net: r(cash - debt) };
  };

  const months = monthKeys.map(key => {
    const [y, m] = key.split('-').map(Number);
    const end = new Date(y, m, 0);
    const asOf = end < newest ? end : newest;
    // A month before any balance history has no position to show.
    if (asOf < accounts.reduce((min, a) => (a.snaps[0].date < min ? a.snaps[0].date : min), newest)) {
      return { key, cash: null, debt: null, net: null, asOf: null };
    }
    return { key, ...position(asOf), asOf };
  });

  const now = { ...position(newest), asOf: newest };
  const order = { cash: 0, debt: 1, other: 2 };
  accounts.sort((a, b) => order[a.kind] - order[b.kind] || a.stale - b.stale || Math.abs(b.lastBalance) - Math.abs(a.lastBalance));
  for (const a of accounts) delete a.snaps;
  return { accounts, months, now };
}
