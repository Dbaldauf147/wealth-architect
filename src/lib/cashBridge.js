/* Why the cash position moved differently from income − spending.

   For a period of whole months, the report walks from the surplus Cash Flow
   reports (income − spending) to the change in the cash position (cash
   minus card balances, from Balance History), one named reason at a time.

   The surplus S follows Cash Flow's rules (pageTotalsByMonth): every positive
   amount is income; a category counts as spending at |its net| when it nets
   negative over the period; transfers, card payments and investing are left
   out. The cash position only moves with transactions on the counted
   accounts (C), plus account changes and anything the balances did that no
   transaction explains. The walk is an identity, every line computed:

     S
     ± refunds                    a positive in a spending category is added
                                  to income AND lowers that category's
                                  spending, so S rises twice what cash does;
                                  in a refund-only month |net| counts it as
                                  spending instead, so S misses it
     + outflows not counted as spending   money out in a category Cash Flow
                                  doesn't treat as spending (tax payments in
                                  "Tax Refund/Payment", a category that nets
                                  to a refund)
     − income outside / + spending outside   on accounts the position doesn't count
     ± timing                     rent counted in the month it pays for, not
                                  the month it arrived
     ± money moved (unpaired)     investing, transfers, card payments whose
                                  other side isn't a counted account; moves
                                  between two counted accounts are paired up
                                  and cancel, whatever each side is categorised
     = C, the change the transactions explain
     ± accounts started / stopped updating
     ± balance changes with no matching transaction
     = actual change in the cash position

   Pure: no React, no DOM. */

import { pageTotalsByMonth, cashFlowMonthKey } from './cashflowExport.js';
import { buildCashPosition, classifyAccount, STALE_DAYS } from './cashPosition.js';

const DAY = 86400000;
const MOVE_GROUPS = [
  { id: 'investing', cats: ['investments', 'retirement'] },
  { id: 'transfers', cats: ['transfer'] },
  { id: 'cardPayments', cats: ['credit card payment', 'credit card payments'] },
];
const MOVING = new Set(MOVE_GROUPS.flatMap(g => g.cats));
// Cash Flow never counts these as spending (cashflowExport NON_EXPENSE_CATS).
const NON_EXPENSE = new Set(['paycheck', 'income', 'tax refund/payment']);
// How far apart the two sides of a move between your own accounts can post.
const PAIR_DAYS = 7;

const round2 = n => Math.round(n * 100) / 100;
const cents = n => Math.round(Number(n) * 100);
const last4 = s => String(s || '').replace(/\D+/g, '').slice(-4);

function monthKeyOfDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function prevKey(key) {
  const [y, m] = key.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Month keys from `from` to `to`, inclusive. */
export function monthRange(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  for (let guard = 0; guard < 600; guard++) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    if (k > to) break;
    out.push(k);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/** Whether each transaction's account is one the cash position counts.
 *  Matched by last four digits, then by name, against the accounts the
 *  position was built from. Unknown accounts don't count. */
export function countedAccountMatcher(accounts) {
  const byDigits = new Map();
  const byName = new Map();
  for (const a of accounts) {
    if (a.last4) {
      // Two accounts can share digits across kinds (a card and a brokerage);
      // the one that counts wins, as the transaction can only be on one.
      if (!byDigits.has(a.last4) || a.included) byDigits.set(a.last4, a);
    }
    byName.set(String(a.name || '').toLowerCase(), a);
  }
  return t => {
    const d = last4(t.accountNum) || last4((String(t.account || '').match(/\d{4,}(?!.*\d)/) || [''])[0]);
    const a = (d && byDigits.get(d)) || byName.get(String(t.account || '').toLowerCase());
    if (a) return { counted: a.included, kind: a.kind, account: a };
    // Not in Balance History at all: never counted — with no balances it
    // isn't part of the position being explained.
    return { counted: false, kind: classifyAccount(t.account, ''), account: null };
  };
}

/** Moves between two counted accounts cancel out: a −X on one and a +X on
 *  another (or a payment and its reversal) within PAIR_DAYS. Pairs the
 *  nearest first; returns the set of rows that found a partner. */
export function pairInternalMoves(rows) {
  const paired = new Set();
  const sorted = [...rows].sort((a, b) => a.date - b.date);
  const candidates = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const gap = (sorted[j].date - sorted[i].date) / DAY;
      if (gap > PAIR_DAYS) break;
      if (cents(sorted[i].amount) === -cents(sorted[j].amount)) candidates.push({ a: sorted[i], b: sorted[j], gap, cross: sorted[i].account !== sorted[j].account });
    }
  }
  // Across two accounts beats a same-account reversal; then the nearest.
  candidates.sort((x, y) => (y.cross - x.cross) || x.gap - y.gap);
  for (const c of candidates) {
    if (paired.has(c.a) || paired.has(c.b)) continue;
    paired.add(c.a); paired.add(c.b);
  }
  return paired;
}

const LINE_TEXT = {
  refundsTwice: {
    label: 'Money in under spending categories (Cash Flow counts it twice)',
    hint: 'Cash Flow adds every refund or reimbursement in a spending category to income and also subtracts it from that category’s spending, so in a normal month the surplus rises by twice what your cash does (taken back out here). In a month where a category is only refunds, it counts the refund as spending instead, and the surplus misses it (added back here). Venmo or Zelle paybacks filed under Restaurants or Travel behave the same way.',
  },
  uncounted: {
    label: 'Money out that Cash Flow doesn’t count as spending',
    hint: 'Outflows in categories Cash Flow leaves out of spending: anything under Paycheck, Income or Tax Refund/Payment (a tax payment, for example), and categories that net to a refund over the period. Your cash paid them; the surplus never saw them.',
  },
  outsideIncome: {
    label: 'Income that landed outside your cash and cards',
    hint: 'Counted as income on Cash Flow, but paid into an account the cash position doesn’t count — dividends and interest in a brokerage or retirement account, for example. It raised the surplus without raising your cash.',
  },
  outsideSpending: {
    label: 'Spending paid from outside your cash and cards',
    hint: 'Money out of an account the position doesn’t count. It lowered the surplus but not your cash.',
  },
  timing: {
    label: 'Rent counted in a different month',
    hint: 'Cash Flow counts rent received late in a month toward the next month (the one it pays for). Your cash got it when it arrived, so at the edges of the period the two disagree.',
  },
  investing: {
    label: 'Sent to (or taken from) investments & retirement',
    hint: 'Money between your cash and a brokerage, IRA or similar. Not spending, so the surplus ignores it — but it leaves your cash.',
  },
  transfers: {
    label: 'Transfers to (or from) accounts not counted',
    hint: 'Transfers whose other side isn’t a counted account — to Robinhood, to someone else, or from savings the position doesn’t count. Transfers between two counted accounts are paired up and cancel out.',
  },
  cardPayments: {
    label: 'Card payments that don’t cancel out',
    hint: 'A payment from checking to a counted card cancels out and isn’t shown. These are payments whose other side isn’t counted (a closed or switched-off card), a payment and its credit in different periods, or a returned payment.',
  },
  other: {
    label: 'Other differences',
    hint: 'Anything the lines above don’t name between the surplus and the transactions. It should be close to zero.',
  },
  accounts: {
    label: 'Accounts that started or stopped updating',
    hint: 'An account that began syncing brings its whole balance in at once; one that stopped (a closed or disconnected card) drops its last balance out after 35 days without an update. Neither is money you earned or spent.',
  },
  unexplained: {
    label: 'Balance changes with no matching transaction',
    hint: 'The balances moved by this much more (or less) than the transactions in those accounts add up to: interest and fees that never import, pending charges, a missing transaction, or a balance snapshot taken a few days off the month end.',
  },
};
export const LINE_ORDER = ['refundsTwice', 'uncounted', 'outsideIncome', 'outsideSpending', 'timing', 'investing', 'transfers', 'cardPayments', 'other', 'accounts', 'unexplained'];

/**
 * @param transactions, balanceHistory
 * @param overrides   the page's include/exclude choices (as for buildCashPosition)
 * @param from, to    'YYYY-MM', inclusive
 * @returns null when there's no balance history for the period, else
 *   { from, to, start, end, surplus, income, spending, actualChange, explainedChange,
 *     lines: [{ id, label, hint, amount, items, count }], internal: { count, volume },
 *     months: [{ key, surplus, actual, gap, lines, top }] }
 */
export function computeCashBridge({ transactions, balanceHistory, overrides = {}, from, to, today = new Date() }) {
  const keys = monthRange(from, to);
  if (!keys.length) return null;
  const pos = buildCashPosition({ balanceHistory, monthKeys: [prevKey(from), ...keys], today, overrides, keepSnaps: true });
  if (!pos.now) return null;
  const posByKey = Object.fromEntries(pos.months.map(m => [m.key, m]));
  const startPos = posByKey[prevKey(from)]?.net != null ? posByKey[prevKey(from)] : null;
  if (!startPos) return null;

  const match = countedAccountMatcher(pos.accounts);
  const { totals, qualifying } = pageTotalsByMonth(transactions, keys);
  const inRange = new Set(keys);

  const per = Object.fromEntries(keys.map(k => [k, Object.fromEntries([...LINE_ORDER, 'counted'].map(id => [id, 0]))]));
  const items = Object.fromEntries(LINE_ORDER.map(id => [id, []]));
  const add = (key, id, effect, row) => {
    if (!inRange.has(key) || !effect) return;
    per[key][id] += effect;
    if (row) items[id].push({ ...row, effect });
  };

  // Per (Cash Flow month, category): the positive and negative sums the
  // surplus was built from, across every account.
  const byCat = {};
  const moves = [];
  for (const t of transactions || []) {
    const amount = Number(t.amount);
    if (!amount || !t.date) continue;
    const date = new Date(t.date);
    if (isNaN(date)) continue;
    const cal = monthKeyOfDate(date);
    const cf = cashFlowMonthKey(t);
    if (!inRange.has(cal) && !inRange.has(cf)) continue;
    const cat = String(t.category || '').toLowerCase();
    const catKey = t.category || 'Uncategorized';
    const where = match(t);
    const row = { date, description: t.description, account: t.account, category: catKey, amount };

    if (where.counted && inRange.has(cal)) per[cal].counted += amount;

    if (MOVING.has(cat)) {
      // Not in the surplus. On a counted account it moves the position —
      // unless its other side is counted too, which pairing finds below.
      if (where.counted && inRange.has(cal)) moves.push({ ...row, group: MOVE_GROUPS.find(g => g.cats.includes(cat)).id, key: cal });
      continue;
    }

    if (inRange.has(cf)) {
      const k = `${cf}|${catKey}`;
      const c = (byCat[k] ||= { key: cf, catKey, nonExpense: NON_EXPENSE.has(cat), pos: 0, neg: 0, posRows: [], negRows: [] });
      if (amount > 0) { c.pos += amount; c.posRows.push(row); } else { c.neg += amount; c.negRows.push(row); }
      if (!where.counted) {
        if (amount > 0) add(cf, 'outsideIncome', -amount, row);
        else add(cf, 'outsideSpending', -amount, row);
      }
    }
    // Rent snapped to the month it pays for: cash had it in the calendar month.
    if (where.counted && cf !== cal) {
      add(cal, 'timing', amount, row);
      add(cf, 'timing', -amount, null);
    }
  }

  // What the surplus counted that cash didn't, per category and month.
  for (const c of Object.values(byCat)) {
    if (!c.nonExpense && qualifying.has(c.catKey)) {
      const net = c.pos + c.neg;
      // Surplus took pos as income and |net| as spending; cash moved by net.
      const extra = c.pos - Math.abs(net) - net;
      if (Math.abs(extra) >= 0.005) {
        per[c.key].refundsTwice -= extra;
        for (const r of c.posRows) items.refundsTwice.push({ ...r, effect: -r.amount });
      }
    } else if (c.neg) {
      per[c.key].uncounted += c.neg;
      for (const r of c.negRows) items.uncounted.push({ ...r, effect: r.amount });
    }
  }

  // Moves between counted accounts cancel; what's left moved the position.
  const paired = pairInternalMoves(moves);
  let internalCount = 0;
  let internalVolume = 0;
  for (const m of moves) {
    if (paired.has(m)) { internalCount++; if (m.amount > 0) internalVolume += m.amount; continue; }
    add(m.key, m.group, m.amount, m);
  }

  // Accounts that started or stopped updating inside the period move the
  // position in one jump with no transaction behind it.
  const firstDay = new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, 1);
  const [ty, tm] = to.split('-').map(Number);
  const lastDay = new Date(ty, tm, 0);
  const asPosition = (a, b) => (a.kind === 'debt' ? -Math.abs(b) : b);
  for (const a of pos.accounts) {
    if (!a.included || !a.snaps?.length) continue;
    const first = a.snaps[0];
    const last = a.snaps[a.snaps.length - 1];
    const drop = new Date(last.date.getTime() + (STALE_DAYS + 1) * DAY);
    const name = `${a.name}${a.last4 && !a.name.includes(a.last4) ? ` …${a.last4}` : ''}`;
    const category = a.kind === 'debt' ? 'Card' : 'Cash';
    if (first.date >= firstDay && first.date <= lastDay && first.balance) {
      add(monthKeyOfDate(first.date), 'accounts', round2(asPosition(a, first.balance)),
        { date: first.date, description: `Started updating, owing or holding ${Math.abs(first.balance).toFixed(2)}`, account: name, category, amount: asPosition(a, first.balance) });
    }
    if (drop >= firstDay && drop <= lastDay && drop <= today && last.balance) {
      add(monthKeyOfDate(drop), 'accounts', round2(-asPosition(a, last.balance)),
        { date: drop, description: `Stopped updating ${last.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}; its last balance drops out`, account: name, category, amount: -asPosition(a, last.balance) });
    }
  }

  // A replaced card: the old one keeps reporting a frozen balance after a new
  // card has started, so that debt is counted on both until the old one goes
  // stale. Flag it where the overlap touches the period.
  const overlaps = [];
  const debts = pos.accounts.filter(a => a.included && a.kind === 'debt' && a.snaps?.length);
  for (const old of debts) {
    if (!old.stale) continue;
    const last = old.snaps[old.snaps.length - 1];
    if (!last.balance) continue;
    // When did its balance last change? Frozen from then on.
    let frozenSince = last.date;
    for (let i = old.snaps.length - 2; i >= 0; i--) {
      if (Math.abs(old.snaps[i].balance - last.balance) >= 1) break;
      frozenSince = old.snaps[i].date;
    }
    // Frozen for days, not just one last snapshot — a card still moving
    // (being paid down) is just a card that stopped syncing.
    if ((last.date - frozenSince) / DAY < 5) continue;
    // The new card started while (or just before) the old one was frozen.
    const replacements = debts.filter(n => n !== old && n.snaps[0].date >= new Date(frozenSince.getTime() - 3 * DAY) && n.snaps[0].date <= last.date);
    if (!replacements.length) continue;
    const overlapFrom = replacements.reduce((m, n) => (n.snaps[0].date < m ? n.snaps[0].date : m), last.date);
    const overlapTo = new Date(last.date.getTime() + (STALE_DAYS + 1) * DAY);
    if (overlapTo < firstDay || overlapFrom > lastDay) continue;
    const nameOf = a => `${a.name}${a.last4 && !a.name.includes(a.last4) ? ` …${a.last4}` : ''}`;
    overlaps.push({
      key: old.key,
      old: nameOf(old),
      replacedBy: replacements.map(nameOf),
      balance: round2(Math.abs(last.balance)),
      frozenSince, from: overlapFrom, lastUpdate: last.date, droppedOut: overlapTo,
    });
  }

  const named = ['refundsTwice', 'uncounted', 'outsideIncome', 'outsideSpending', 'timing', 'investing', 'transfers', 'cardPayments'];
  const months = keys.map(key => {
    const p = per[key];
    const surplus = round2(totals[key]?.net || 0);
    const before = posByKey[prevKey(key)]?.net;
    const after = posByKey[key]?.net;
    const actual = before == null || after == null ? null : round2(after - before);
    p.other = p.counted - (surplus + named.reduce((s, id) => s + p[id], 0));
    p.unexplained = actual == null ? 0 : actual - p.counted - p.accounts;
    const lines = Object.fromEntries(LINE_ORDER.map(id => [id, round2(p[id])]));
    const top = Object.entries(lines).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    return { key, surplus, actual, gap: actual == null ? null : round2(actual - surplus), lines, top: top && Math.abs(top[1]) >= 1 ? top[0] : null };
  });

  const surplus = round2(months.reduce((s, m) => s + m.surplus, 0));
  const end = posByKey[to];
  const actualChange = round2(end.net - startPos.net);
  const countedTotal = round2(keys.reduce((s, k) => s + per[k].counted, 0));
  const sum = id => round2(keys.reduce((s, k) => s + per[k][id], 0));
  const topItems = (list, n = 8) => [...list].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)).slice(0, n);

  const lines = LINE_ORDER.map(id => ({
    id,
    ...LINE_TEXT[id],
    amount: id === 'unexplained' ? round2(actualChange - countedTotal - sum('accounts')) : sum(id),
    items: topItems(items[id]),
    count: items[id].length,
  }));

  return {
    from, to,
    start: { key: startPos.key, net: startPos.net, cash: startPos.cash, debt: startPos.debt, asOf: startPos.asOf },
    end: { key: end.key, net: end.net, cash: end.cash, debt: end.debt, asOf: end.asOf },
    surplus,
    income: round2(keys.reduce((s, k) => s + (totals[k]?.income || 0), 0)),
    spending: round2(keys.reduce((s, k) => s + (totals[k]?.expenses || 0), 0)),
    actualChange,
    explainedChange: countedTotal,
    lines,
    internal: { count: internalCount, volume: round2(internalVolume) },
    overlaps,
    months,
  };
}
