/* Splitwise, reduced to the two questions worth asking of it: what have I been
   charged with, and who is up on whom.

   Pure and React-free, like weeklySummary and cardPromos. The API route hands
   over Splitwise's raw JSON; everything that decides what a number means
   happens here, where it can be tested without a network. */

const CENT = 0.005;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function personName(user) {
  if (!user) return 'Someone';
  const name = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  return name || user.email || 'Someone';
}

/** Splitwise sends dates as ISO datetimes; the ledger works in local days. */
export function expenseDay(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayNumber(d) {
  return Math.floor(d.getTime() / 86_400_000 - d.getTimezoneOffset() / 1440);
}

/**
 * One raw Splitwise expense, from the point of view of the current user.
 *
 * `net` is what the expense did to your position: positive means the group
 * owes you (you fronted more than your share), negative means you owe. A
 * `payment` is a settle-up transfer rather than a charge — it moves the
 * balance without anybody buying anything, so it is kept but flagged, since
 * counting it as spending would double every settled dinner.
 */
export function normalizeExpense(raw, currentUserId) {
  if (!raw || raw.deleted_at) return null;
  const mine = (raw.users || []).find(u => Number(u.user_id) === Number(currentUserId));
  // An expense you are not a party to has nothing to say about your money.
  if (!mine) return null;

  const others = (raw.users || [])
    .filter(u => Number(u.user_id) !== Number(currentUserId))
    .map(u => ({
      id: Number(u.user_id),
      name: personName(u.user),
      paid: num(u.paid_share),
      owed: num(u.owed_share),
      net: num(u.net_balance),
    }));

  return {
    id: Number(raw.id),
    date: raw.date || null,
    description: raw.description || 'Untitled',
    details: raw.details || '',
    cost: num(raw.cost),
    currency: raw.currency_code || 'USD',
    category: raw.category?.name || '',
    groupId: raw.group_id == null ? null : Number(raw.group_id),
    isSettlement: !!raw.payment,
    youPaid: num(mine.paid_share),
    yourShare: num(mine.owed_share),
    net: num(mine.net_balance),
    others,
    createdBy: personName(raw.created_by),
    updatedAt: raw.updated_at || null,
  };
}

/** Newest first, deleted rows and expenses you aren't part of dropped. */
export function normalizeExpenses(rawExpenses, currentUserId) {
  const out = [];
  for (const raw of rawExpenses || []) {
    const e = normalizeExpense(raw, currentUserId);
    if (e) out.push(e);
  }
  out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return out;
}

/**
 * Who is up on whom.
 *
 * Totals come from the friend list, not the groups: Splitwise's per-friend
 * balance is already the net across every group plus anything one-to-one, so
 * adding the groups on top would count the same debt twice. Groups are carried
 * through only as a breakdown.
 */
export function summarizeBalances({ friends = [], groups = [], defaultCurrency = 'USD' } = {}) {
  const byPerson = [];
  const byCurrency = new Map();

  for (const f of friends || []) {
    for (const b of f.balance || []) {
      const amount = num(b.amount);
      if (Math.abs(amount) < CENT) continue;
      const currency = b.currency_code || defaultCurrency;
      byPerson.push({
        id: Number(f.id),
        name: personName(f),
        amount,          // positive: they owe you. negative: you owe them.
        currency,
      });
      const bucket = byCurrency.get(currency) || { currency, owedToYou: 0, youOwe: 0 };
      if (amount > 0) bucket.owedToYou += amount;
      else bucket.youOwe += -amount;
      byCurrency.set(currency, bucket);
    }
  }

  // Biggest positions first, whichever direction they run in.
  byPerson.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const groupRows = [];
  for (const g of groups || []) {
    const mine = [];
    for (const m of g.members || []) {
      for (const b of m.balance || []) {
        const amount = num(b.amount);
        if (Math.abs(amount) < CENT) continue;
        mine.push({ name: personName(m), amount, currency: b.currency_code || defaultCurrency });
      }
    }
    if (!mine.length) continue;
    groupRows.push({ id: Number(g.id), name: g.name || 'Group', members: mine });
  }

  const home = byCurrency.get(defaultCurrency) || { currency: defaultCurrency, owedToYou: 0, youOwe: 0 };
  const others = [...byCurrency.values()].filter(c => c.currency !== defaultCurrency);

  return {
    currency: defaultCurrency,
    owedToYou: home.owedToYou,
    youOwe: home.youOwe,
    net: home.owedToYou - home.youOwe,
    byPerson,
    byCurrency: [...byCurrency.values()],
    otherCurrencies: others,
    groups: groupRows,
  };
}

/**
 * Pair each Splitwise expense with the bank charge behind it.
 *
 * Only expenses you actually fronted money for can have a charge: if you paid
 * nothing, nothing left your account. The charge is matched against
 * `youPaid` rather than the expense total, because when two people split the
 * bill at the register your card was only hit for your half.
 *
 * Matching is greedy over the closest pairs first, and a transaction can only
 * be claimed once — two $40 dinners in the same week must not both point at
 * the same charge.
 */
export function attachTransactionMatches(expenses, transactions, { windowDays = 5, tolerance = 0.02 } = {}) {
  const candidates = [];
  for (const t of transactions || []) {
    const amount = num(t.amount);
    if (amount >= 0) continue;             // money in is not a bill you paid
    const d = expenseDay(t.date);
    if (!d) continue;
    candidates.push({ txn: t, day: dayNumber(d), spend: Math.abs(amount) });
  }

  const pairs = [];
  expenses.forEach((e, index) => {
    if (e.isSettlement) return;            // a settle-up is a transfer, not a purchase
    if (e.youPaid <= 0) return;
    const d = expenseDay(e.date);
    if (!d) return;
    const day = dayNumber(d);
    for (const c of candidates) {
      const dayDiff = Math.abs(c.day - day);
      if (dayDiff > windowDays) continue;
      const amountDiff = Math.abs(c.spend - e.youPaid);
      if (amountDiff > tolerance) continue;
      pairs.push({ index, candidate: c, dayDiff, amountDiff });
    }
  });

  // Closest on amount wins, then closest on date — an exact cents match a week
  // later is better evidence than a near-miss the same day.
  pairs.sort((a, b) => (a.amountDiff - b.amountDiff) || (a.dayDiff - b.dayDiff));

  const takenExpense = new Set();
  const takenTxn = new Set();
  const matchFor = new Map();
  for (const p of pairs) {
    if (takenExpense.has(p.index)) continue;
    const key = p.candidate.txn.transactionId
      || `${p.candidate.txn.date}|${p.candidate.txn.description}|${p.candidate.txn.amount}`;
    if (takenTxn.has(key)) continue;
    takenExpense.add(p.index);
    takenTxn.add(key);
    matchFor.set(p.index, {
      transactionId: p.candidate.txn.transactionId || null,
      date: p.candidate.txn.date,
      description: p.candidate.txn.description || '',
      account: p.candidate.txn.account || '',
      amount: num(p.candidate.txn.amount),
      daysApart: p.dayDiff,
      exact: p.amountDiff < CENT,
    });
  }

  return expenses.map((e, i) => ({ ...e, match: matchFor.get(i) || null }));
}

/** Headline numbers for the expense list itself, over whatever window was
 *  fetched: what you fronted, what was actually yours, and what that left
 *  outstanding from these charges alone. */
export function summarizeExpenses(expenses) {
  let youPaid = 0;
  let yourShare = 0;
  let net = 0;
  let settlements = 0;
  let charges = 0;
  for (const e of expenses || []) {
    if (e.isSettlement) { settlements += 1; continue; }
    charges += 1;
    youPaid += e.youPaid;
    yourShare += e.yourShare;
    net += e.net;
  }
  return { youPaid, yourShare, net, charges, settlements, count: (expenses || []).length };
}
