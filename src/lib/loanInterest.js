/* Interest charges from the ledger, and tagging them to the short-term loan.
   Pure functions — no React — so the page stays presentational and this is
   testable on its own.

   A charge tagged to the loan becomes a payment in its log carrying the
   charge's `transactionId`, so deleting that payment puts the charge back in
   the queue. A charge that isn't the loan's (card interest, margin interest)
   is ignored by id on the loan, so it stops being offered. Both live on the
   loan object, which already syncs across devices as one unit. */

/** Stable key for a transaction: its sheet ID, or the same fallback the rest
 *  of the app uses when a row has none. */
export function txnKey(t) {
  return t.transactionId || `${t.date}|${t.description}|${t.amount}`;
}

/** Money out, categorized as interest (category or subcategory). Interest
 *  *earned* is money in, so the sign alone keeps it out. */
export function isInterestCharge(t) {
  if (!t || !((Number(t.amount) || 0) < 0)) return false;
  return /interest/i.test(t.category || '') || /interest/i.test(t.subcategory || '');
}

/** 'YYYY-MM-DD' for a sheet date ('9/20/2026', '2026-09-20', …), in local
 *  time so a date never slides a day west of UTC. '' if unparseable. */
export function toISODate(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The loan payment a tagged charge becomes. */
export function paymentFromTransaction(t) {
  return {
    date: toISODate(t.date),
    amount: Math.abs(Number(t.amount) || 0),
    note: t.description || '',
    transactionId: txnKey(t),
  };
}

/**
 * Interest charges still waiting for a decision, newest first.
 *
 * @param transactions   categorized transactions
 * @param loan           the shortTermLoan object (payments, ignoredTransactionIds, startDate)
 * @param includeEarlier also offer charges dated before the loan started
 * @returns { pending, ignored, earlierCount }
 *   pending      charges neither tagged nor ignored (inside the date window)
 *   ignored      charges the user ignored, so they can be restored
 *   earlierCount pending charges hidden because they predate the loan
 */
export function loanInterestQueue({ transactions, loan, includeEarlier = false }) {
  const linked = new Set((loan?.payments || []).map(p => p.transactionId).filter(Boolean));
  const ignoredIds = new Set(loan?.ignoredTransactionIds || []);
  const start = loan?.startDate || '';

  const pending = [];
  const ignored = [];
  let earlierCount = 0;
  for (const t of transactions || []) {
    if (!isInterestCharge(t)) continue;
    const key = txnKey(t);
    if (linked.has(key)) continue;
    const row = { ...t, key, iso: toISODate(t.date) };
    if (ignoredIds.has(key)) { ignored.push(row); continue; }
    if (!includeEarlier && start && row.iso && row.iso < start) { earlierCount += 1; continue; }
    pending.push(row);
  }
  const newestFirst = (a, b) => b.iso.localeCompare(a.iso) || String(a.description).localeCompare(String(b.description));
  pending.sort(newestFirst);
  ignored.sort(newestFirst);
  return { pending, ignored, earlierCount };
}

/**
 * Reconcile this device's copy of the loan with the synced one, at load.
 *
 * Taking either copy whole is how tags went missing: a browser holding an
 * older loan won the merge, then wrote it back over the cloud copy — erasing
 * every charge tagged on another device since. Instead:
 *
 *   - Each edit stamps the loan with `updatedAt`. When both copies carry one,
 *     the newer copy's terms win, and when the cloud copy is the newer one it
 *     wins outright, so a payment deleted on another device stays deleted.
 *   - Otherwise (older loans that predate the stamp, or this device holding
 *     edits the cloud hasn't seen) payments and ignored charges are unioned:
 *     nothing tagged anywhere is lost. A payment is the same one on both sides
 *     when it shares an id, or a tagged transaction.
 *
 * Either side may be null; null and null is null.
 */
export function mergeLoan(local, remote) {
  if (!local) return remote || null;
  if (!remote) return local;
  const lt = Date.parse(local.updatedAt || '') || 0;
  const rt = Date.parse(remote.updatedAt || '') || 0;
  if (rt && rt >= lt) return remote;

  const newer = lt > rt ? local : remote;
  const older = newer === local ? remote : local;
  const payments = [...(newer.payments || [])];
  const ids = new Set(payments.map(p => p.id).filter(Boolean));
  const txns = new Set(payments.map(p => p.transactionId).filter(Boolean));
  for (const p of older.payments || []) {
    if ((p.id && ids.has(p.id)) || (p.transactionId && txns.has(p.transactionId))) continue;
    payments.push(p);
    if (p.id) ids.add(p.id);
    if (p.transactionId) txns.add(p.transactionId);
  }
  // A charge tagged on either side isn't ignored, whatever the other side says.
  const ignored = [...new Set([...(newer.ignoredTransactionIds || []), ...(older.ignoredTransactionIds || [])])]
    .filter(id => !txns.has(id));
  // Balances typed in on either side are kept, the newer side winning a date.
  const balances = new Map();
  for (const e of [...(older.balanceHistory || []), ...(newer.balanceHistory || [])]) if (e?.date) balances.set(e.date, e);
  // Ledger rows are unioned by id, the newer side winning a row.
  const ledger = new Map();
  for (const e of [...(older.ledger || []), ...(newer.ledger || [])]) if (e?.id) ledger.set(e.id, e);
  const out = { ...older, ...newer, payments };
  if (ledger.size) out.ledger = [...ledger.values()];
  if (balances.size) out.balanceHistory = [...balances.values()].sort((x, y) => x.date.localeCompare(y.date));
  if (ignored.length || newer.ignoredTransactionIds || older.ignoredTransactionIds) out.ignoredTransactionIds = ignored;
  return out;
}

/** Whole days from one 'YYYY-MM-DD' to another, counted in UTC so a DST
 *  change never turns a day into 23 or 25 hours. NaN if either is bad. */
function isoDayDiff(fromISO, toISO) {
  const parse = s => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  };
  return Math.round((parse(toISO) - parse(fromISO)) / 86400000);
}

/** The loan's daily rate as a fraction (1% per day → 0.01). */
export function dailyRateOf(loan) {
  const pct = Number(loan?.rate) || 0;
  return loan?.rateType === 'apr' ? pct / 100 / 365 : pct / 100;
}

/**
 * The balance each interest payment implies, and so what's left on the loan.
 *
 * Interest for a period is balance × daily rate × days, so a payment that
 * covers the days since the one before it (or since the loan started, for
 * the first) gives back the balance it was charged on:
 *
 *     balance = interest ÷ (daily rate × days)
 *
 * As principal is paid down the charges shrink, and the latest one says what
 * is still owed. Payments on the same day are one charge split in pieces, so
 * they're summed. A period with no days (or no rate) can't imply anything and
 * carries `balance: null`; the next payment measures from its date anyway.
 *
 * @returns {
 *   periods   [{ date, from, days, interest, balance }] oldest first
 *   latest    the newest period with a balance, or null
 *   remaining latest.balance, or null when nothing implies one yet
 *   paidDown  principal − remaining, or null
 * }
 */
export function impliedBalances(loan) {
  const rate = dailyRateOf(loan);
  const principal = Number(loan?.principal) || 0;

  const byDate = new Map();
  for (const p of loan?.payments || []) {
    if (!p?.date) continue;
    byDate.set(p.date, (byDate.get(p.date) || 0) + (Number(p.amount) || 0));
  }

  const periods = [];
  let from = loan?.startDate || '';
  for (const date of [...byDate.keys()].sort()) {
    const interest = byDate.get(date);
    const days = from ? isoDayDiff(from, date) : NaN;
    const balance = rate > 0 && days > 0 && interest > 0 ? interest / (rate * days) : null;
    periods.push({ date, from, days: Number.isFinite(days) ? days : null, interest, balance });
    from = date;
  }

  const latest = [...periods].reverse().find(p => p.balance != null) || null;
  const remaining = latest ? latest.balance : null;
  return { periods, latest, remaining, paidDown: remaining == null ? null : principal - remaining };
}

/**
 * Every known balance on the loan, oldest first, and so what's left now.
 *
 * Three sources, each a point { date, balance, source }:
 *   'start'   the principal on the start date
 *   'payment' the balance an interest payment implies (see impliedBalances)
 *   'ledger'  what's owed after a new loan or a payment toward it (loanLedger)
 *   'entered' a balance the user typed in from a statement (loan.balanceHistory)
 *
 * On the same date an entered balance beats the ledger — it's the lender's
 * number — the ledger beats an implied one, and all of them beat the start.
 *
 * @returns { points, current, borrowed, paidDown }
 *   current   the newest point, or null
 *   borrowed  original principal + every new loan
 *   paidDown  borrowed − current.balance, or null
 */
export function balanceTimeline(loan) {
  const rank = { start: 0, payment: 1, ledger: 2, entered: 3 };
  const byDate = new Map();
  const put = pt => {
    if (!pt.date || !Number.isFinite(pt.balance)) return;
    const had = byDate.get(pt.date);
    if (!had || rank[pt.source] >= rank[had.source]) byDate.set(pt.date, pt);
  };

  const principal = Number(loan?.principal) || 0;
  if (principal > 0 && loan?.startDate) put({ date: loan.startDate, balance: principal, source: 'start' });
  for (const p of impliedBalances(loan).periods) {
    if (p.balance != null) put({ date: p.date, balance: p.balance, source: 'payment', interest: p.interest, days: p.days, from: p.from });
  }
  const ledger = loanLedger(loan);
  for (const r of ledger.rows) {
    if (!r.original) put({ date: r.date, balance: r.balance, source: 'ledger' });
  }
  for (const e of loan?.balanceHistory || []) {
    const amt = Number(e?.amount);
    if (e?.date && Number.isFinite(amt) && amt >= 0) put({ date: e.date, balance: amt, source: 'entered' });
  }

  const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const current = points.length ? points[points.length - 1] : null;
  const borrowed = ledger.borrowed;
  return { points, current, borrowed, paidDown: current && borrowed > 0 ? borrowed - current.balance : null };
}

/** Interest paid by date, oldest first, with a running total. */
export function interestPaidSeries(loan) {
  const byDate = new Map();
  for (const p of loan?.payments || []) {
    if (!p?.date) continue;
    byDate.set(p.date, (byDate.get(p.date) || 0) + (Number(p.amount) || 0));
  }
  let total = 0;
  return [...byDate.keys()].sort().map(date => {
    total += byDate.get(date);
    return { date, amount: byDate.get(date), total };
  });
}

/** balanceHistory with one entry set for its date (replacing any there), or
 *  removed when amount is null. Newest first isn't assumed — it's sorted. */
export function withBalanceEntry(history, date, amount) {
  const rest = (history || []).filter(e => e.date !== date);
  if (amount != null) rest.push({ date, amount: Number(amount) });
  return rest.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The loan's ledger: money borrowed and principal paid back.
 *
 * The original loan (principal on the start date) is the first row; the rest
 * are loan.ledger entries { id, date, type: 'loan' | 'payment', amount,
 * label, note } — 'loan' for a new loan or draw taken out, 'payment' for
 * money paid toward the balance. Interest payments live in loan.payments and
 * aren't part of this.
 *
 * @returns {
 *   rows      oldest first, each with `balance` — what was owed after it
 *   borrowed  original principal + every new loan
 *   repaid    every payment toward the loan
 *   owed      borrowed − repaid
 * }
 */
export function loanLedger(loan) {
  const rows = [];
  const principal = Number(loan?.principal) || 0;
  if (principal > 0) {
    rows.push({ id: 'original', date: loan.startDate || '', type: 'loan', amount: principal, label: loan.name || 'Original loan', original: true });
  }
  for (const e of loan?.ledger || []) {
    const amount = Number(e?.amount) || 0;
    if (!(amount > 0) || (e.type !== 'loan' && e.type !== 'payment')) continue;
    rows.push({ ...e, amount });
  }
  // Oldest first; on the same day the original loan comes first, then new
  // loans before payments, so a balance never dips below zero mid-day.
  const order = r => (r.original ? 0 : r.type === 'loan' ? 1 : 2);
  rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') || order(a) - order(b) || String(a.id).localeCompare(String(b.id)));

  let balance = 0, borrowed = 0, repaid = 0;
  for (const r of rows) {
    if (r.type === 'loan') { balance += r.amount; borrowed += r.amount; } else { balance -= r.amount; repaid += r.amount; }
    r.balance = balance;
  }
  return { rows, borrowed, repaid, owed: borrowed - repaid };
}

/* ── Transactions that link to the loan on their own ──────────────────────
   A transaction whose subcategory is "Loan Taken" or "Loan Payment" belongs
   on the ledger without anyone tagging it: "Loan Taken" is a new loan, "Loan
   Payment" a payment toward the balance. They're derived from the ledger of
   transactions each render rather than copied onto the loan, so recategorizing
   one moves it on or off the page by itself. Unlinking one adds its key to
   loan.ignoredTransactionIds (the same set the interest queue uses), which
   already syncs with the loan. */

/** 'loan' | 'payment' for a transaction that links by subcategory, else null. */
export function loanLinkType(t) {
  const sub = String(t?.subcategory || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (sub === 'loan taken' || sub === 'loans taken') return 'loan';
  if (sub === 'loan payment' || sub === 'loan payments') return 'payment';
  return null;
}

/**
 * The transactions that link to the loan by subcategory.
 *
 * Only those dated on or after the loan's start count — earlier ones are
 * counted but not linked, since they'd be a different loan. A "Loan Taken" on
 * the start date for the principal is the original loan itself, so it's
 * reported as `original` instead of being added a second time.
 *
 * @returns {
 *   entries    ledger entries, { id, date, type, amount, label, note, transactionId, linked: true }
 *   unlinked   matching transactions the user unlinked, so they can be restored
 *   original   the transaction behind the original loan, or null
 *   earlierCount matching transactions before the start date
 * }
 */
export function linkedLoanTransactions({ transactions, loan }) {
  const out = { entries: [], unlinked: [], original: null, earlierCount: 0 };
  if (!loan) return out;
  const ignoredIds = new Set(loan.ignoredTransactionIds || []);
  // Entries typed in by hand that name a transaction win over linking it
  // again; linked entries already folded in (withLinkedTransactions) don't count.
  const manual = new Set((loan.ledger || []).filter(e => !e.linked).map(e => e.transactionId).filter(Boolean));
  const start = loan.startDate || '';
  const principal = Number(loan.principal) || 0;

  for (const t of transactions || []) {
    const type = loanLinkType(t);
    if (!type) continue;
    const amount = Math.abs(Number(t.amount) || 0);
    if (!(amount > 0)) continue;
    const key = txnKey(t);
    if (manual.has(key)) continue;
    const date = toISODate(t.date);
    const row = {
      id: `txn:${key}`, date, type, amount,
      label: t.account || '', note: t.description || '',
      transactionId: key, linked: true,
    };
    if (ignoredIds.has(key)) { out.unlinked.push(row); continue; }
    if (start && date && date < start) { out.earlierCount += 1; continue; }
    if (!out.original && type === 'loan' && date === start && Math.abs(amount - principal) < 0.005) {
      out.original = row;
      continue;
    }
    out.entries.push(row);
  }
  out.unlinked.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

/** The loan with its linked transactions folded into the ledger — what the
 *  page shows and every balance figure is worked out from. */
export function withLinkedTransactions(loan, transactions) {
  if (!loan) return loan;
  const { entries } = linkedLoanTransactions({ transactions, loan });
  if (!entries.length) return loan;
  return { ...loan, ledger: [...(loan.ledger || []).filter(e => !e.linked), ...entries] };
}

/**
 * The balance over time as separate series, so the chart can draw the
 * estimate from interest and the count from transactions as their own lines
 * rather than one line hopping between them.
 *
 * @returns {
 *   implied  [{ date, balance, interest, days }] — the starting principal,
 *            then what each interest payment implies (impliedBalances)
 *   ledger   [{ date, balance }] — owed after each day's loans and payments
 *            (loanLedger), one point per date
 *   entered  [{ date, balance }] — balances typed in from a statement
 * }
 */
export function balanceSeries(loan) {
  const principal = Number(loan?.principal) || 0;
  const start = loan?.startDate || '';

  const implied = [];
  if (principal > 0 && start) implied.push({ date: start, balance: principal, start: true });
  for (const p of impliedBalances(loan).periods) {
    if (p.balance == null || !p.date) continue;
    if (implied.length && implied[implied.length - 1].date === p.date) implied.pop();
    implied.push({ date: p.date, balance: p.balance, interest: p.interest, days: p.days });
  }
  implied.sort((a, b) => a.date.localeCompare(b.date));

  const byDate = new Map();
  for (const r of loanLedger(loan).rows) if (r.date) byDate.set(r.date, r.balance);
  const ledger = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, balance]) => ({ date, balance }));

  const entered = (loan?.balanceHistory || [])
    .map(e => ({ date: e?.date, balance: Number(e?.amount) }))
    .filter(e => e.date && Number.isFinite(e.balance) && e.balance >= 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  return { implied, ledger, entered };
}
