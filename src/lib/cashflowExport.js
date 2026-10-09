/* Builds the data for the Cash Flow "deep dive" Excel export and the on-page
 * bank-balance reconciliation. Pure (no React / DOM) so it can be unit-tested
 * and reused by both the export button and the reconciliation panel.
 *
 * The category buckets mirror CashFlowPage / weeklySummary so the exported
 * numbers reconcile with what the user sees on screen:
 *   - transfers and credit-card payments are money moving between the user's
 *     own accounts, not income or spending;
 *   - investments / retirement are tracked separately from spending;
 *   - "expenses" counts only categories whose net over the window is negative,
 *     with refunds netted in (|signed sum|), exactly like the page.
 */

import { buildCardSchedule } from './cardSchedule';
import { classifyAccount } from './cashPosition.js';

const NON_EXPENSE_CATS = new Set(['paycheck', 'income', 'tax refund/payment']);
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function lc(t) { return (t.category || '').toLowerCase(); }
const isTransfer = (c) => c === 'transfer';
const isCCPayment = (c) => c === 'credit card payment' || c === 'credit card payments';
const isInvesting = (c) => c === 'investments' || c === 'retirement';

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

export function monthKeyOf(dateLike) {
  const d = parseDate(dateLike);
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(key) {
  if (!key) return '';
  const [y, m] = key.split('-');
  return `${MONTH_SHORT[parseInt(m, 10) - 1]} ${y}`;
}

/** The YYYY-MM immediately before `key`. */
export function prevMonthKey(key) {
  if (!key) return null;
  const [y, m] = key.split('-').map(Number);
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, '0')}`;
}

/** True when a transaction is rent revenue. Income side (amount > 0) where the
 *  category/subcategory is "Rent", OR the description mentions rent (e.g. a Zelle
 *  payment "...for rent..." that imported without a Rent subcategory). The
 *  description test uses a whole-word match so it won't fire on "parent" etc.
 *  These get snapped to the nearest month (see below). */
export function isRentIncome(t) {
  if (!t || !(t.amount > 0)) return false;
  if ((t.subcategory || '').trim().toLowerCase() === 'rent') return true;
  if ((t.category || '').trim().toLowerCase() === 'rent') return true;
  const desc = `${t.description || ''} ${t.fullDescription || ''}`.toLowerCase();
  return /\brent\b/.test(desc);
}

/** Snap a date to the month whose 1st it falls closest to, returning a YYYY-MM
 *  key. If the date is closer to next month's 1st than to the current month's
 *  1st (i.e. it lands in the back half of the month), it rolls forward a month;
 *  an exact tie keeps the current month. */
function snapToNearestMonthKey(d) {
  const day = d.getDate();
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const distToCurrent = day - 1;            // days back to this month's 1st
  const distToNext = daysInMonth - day + 1; // days forward to next month's 1st
  let y = d.getFullYear();
  let m = d.getMonth() + 1; // 1-based
  if (distToNext < distToCurrent) {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** The month a transaction counts toward on the Cash Flow page. Rent revenue is
 *  snapped to the calendar month whose 1st it lands closest to (so late-month
 *  rent rolls into the next month); everything else uses its own month. */
export function cashFlowMonthKey(t) {
  const d = parseDate(t && t.date);
  if (!d) return null;
  if (isRentIncome(t)) return snapToNearestMonthKey(d);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function digitsMatch(rawAcctNum, suffix) {
  if (!rawAcctNum || !suffix) return false;
  return String(rawAcctNum).replace(/\D+/g, '').endsWith(suffix);
}

// ── Income, spending and investing, as every page counts them ────────────
//
// One definition, used by Cash Flow, Overshot, the cash bridge and the export:
//
//   • Moving your own money is neither income nor spending: transfers, card
//     payments, and anything to or from investments.
//   • Investing is recognised by category (Investments, Retirement) or, on a
//     cash account, by naming a brokerage (a "Transfer" to Robinhood is money
//     invested, not money gone). It's counted from the cash side only, so the
//     brokerage's matching deposit doesn't count it twice.
//   • Activity inside an investment or retirement account that isn't earning
//     or spending — buys, sells, reinvestments, the brokerage's side of a
//     transfer, anything left uncategorised there — is money moving too.
//     Dividends, interest and fees there still count.
//   • Refunds net against the category they're in. A category is spending when
//     it nets negative over the window; in a month where it nets positive (a
//     refund with nothing to refund against), that month's net is money in.
//   • Everything else that nets positive is income; a category that's mostly
//     income (Paycheck, Tax Refund/Payment) but nets negative in a month — a
//     tax payment — is spending that month.
//
// So income − spending is exactly what earning and spending did to your money,
// and surplus − invested is what was left to keep as cash.
//
// This replaced a version that added every positive amount to income *and*
// netted it out of its category's spending, which counted refunds twice (about
// $29k over a year on the live ledger) and never counted tax payments.

// The other side of a move is a brokerage or retirement provider.
export const BROKERAGE_NAME = /\b(robinhood|fidelity|vanguard|schwab|e\*?trade|merrill|wealthfront|betterment|coinbase|acorns|webull|treasury ?direct|m1 finance|interactive brokers)\b/i;
const RETIREMENT_NAME = /\b(ira|roth|401\s?\(?k\)?|403\s?\(?b\)?|retirement|savings plan)\b/i;
const describe = t => `${t.description || ''} ${t.fullDescription || ''}`;
const isCashAccount = t => classifyAccount(t.account, '') === 'cash';
const INSIDE_ACTIVITY = /\b(buy|bought|sell|sold|purchase|reinvest\w*|ach|withdrawal|deposit|transfer|journal|exchange)\b/i;

/** Activity inside an investment account that only moves money around in it
 *  (a $30k uncategorised fund conversion is not income). */
export function isInsideInvestments(t) {
  return classifyAccount(t.account, '') === 'other' && (!t.category || INSIDE_ACTIVITY.test(describe(t)));
}

/** Money going to (or coming back from) investments. */
export function isInvestingMove(t) {
  return isInvesting(lc(t)) || (isCashAccount(t) && BROKERAGE_NAME.test(describe(t)));
}

/** The cash side of money sent to investments: { invested, retirement }, where
 *  invested is positive for money sent and negative for money taken back, or
 *  null when the transaction isn't one. */
export function investingLeg(t) {
  if (!isInvestingMove(t) || !isCashAccount(t)) return null;
  return { invested: -t.amount, retirement: lc(t) === 'retirement' || RETIREMENT_NAME.test(describe(t)) };
}

/** Moving your own money: transfers, card payments, investing. */
export function isMoneyMove(t) {
  const c = lc(t);
  return isTransfer(c) || isCCPayment(c) || isInvestingMove(t) || isInsideInvestments(t);
}

/**
 * Per-month income, spending and investing for a window of month keys.
 * @returns {
 *   totals: { [key]: { income, expenses, net, invested, retirement, kept } },
 *   qualifying: Set of spending categories over the window,
 *   role: t => 'income' | 'expense' | 'move' | null   (null = outside the window)
 * }
 *   invested — cash sent to investments that month, net of money taken back
 *   retirement — the part of `invested` going to retirement accounts
 *   kept — net − invested: what earning and spending left as cash
 */
export function cashFlowBreakdown(transactions, monthKeys) {
  const keys = new Set(monthKeys);
  const signed = {};      // category → month → signed sum
  const invested = {};
  const retirement = {};
  for (const k of monthKeys) { invested[k] = 0; retirement[k] = 0; }

  for (const t of transactions || []) {
    if (!t.date || !t.amount) continue;
    const key = cashFlowMonthKey(t);
    if (!keys.has(key)) continue;
    if (isInvestingMove(t)) {
      const leg = investingLeg(t);
      if (leg) {
        invested[key] += leg.invested;
        if (leg.retirement) retirement[key] += leg.invested;
      }
      continue;
    }
    if (isMoneyMove(t)) continue;
    const cat = t.category || 'Uncategorized';
    (signed[cat] ||= {})[key] = (signed[cat][key] || 0) + t.amount;
  }

  const qualifying = new Set();
  for (const cat of Object.keys(signed)) {
    if (NON_EXPENSE_CATS.has(cat.toLowerCase())) continue;
    let net = 0;
    for (const k of monthKeys) net += signed[cat][k] || 0;
    if (net < 0 || (cat === 'Uncategorized' && net !== 0)) qualifying.add(cat);
  }

  const totals = {};
  for (const k of monthKeys) {
    let income = 0;
    let expenses = 0;
    for (const cat of Object.keys(signed)) {
      const v = signed[cat][k] || 0;
      if (v > 0) income += v; else expenses -= v;
    }
    const net = income - expenses;
    totals[k] = { income, expenses, net, invested: invested[k], retirement: retirement[k], kept: net - invested[k] };
  }

  const role = (t) => {
    if (!t?.date || !t.amount) return null;
    const key = cashFlowMonthKey(t);
    if (!keys.has(key)) return null;
    if (isMoneyMove(t)) return 'move';
    const v = signed[t.category || 'Uncategorized']?.[key] || 0;
    return v > 0 ? 'income' : 'expense';
  };

  return { totals, qualifying, role };
}

// Per-month income/expense totals (all accounts) for a set of month keys, as
// every page counts them. Returns { totals: { [key]: { income, expenses, net,
// invested, retirement, kept } }, qualifying }.
export function pageTotalsByMonth(transactions, monthKeys) {
  const { totals, qualifying } = cashFlowBreakdown(transactions, monthKeys);
  return { totals, qualifying };
}

/** Reconcile one month's tracked-account balance change against its
 *  transactions, and explain why it diverges from the Cash Flow Net column.
 *
 *  Returns a structured object the UI and the Excel sheet both consume. */
export function computeMonthReconciliation({ transactions, balanceHistory, monthKey, trackSuffix }) {
  const [y, m] = monthKey.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const monthEnd = new Date(y, m, 0, 23, 59, 59, 999);

  // Opening = latest tracked snapshot strictly before the month;
  // closing = latest tracked snapshot within the month.
  let opening = null;
  let closing = null;
  for (const row of balanceHistory || []) {
    if (!digitsMatch(row.accountNum, trackSuffix)) continue;
    const d = parseDate(row.date);
    if (!d) continue;
    const snap = { ts: d.getTime(), date: row.date, balance: row.balance, account: row.account };
    if (d < monthStart) {
      if (!opening || snap.ts > opening.ts) opening = snap;
    } else if (d <= monthEnd) {
      if (!closing || snap.ts >= closing.ts) closing = snap;
    }
  }

  // Bucket every tracked-account transaction in the month so the buckets sum
  // to the net movement on that account.
  const buckets = { inflows: 0, spending: 0, transfers: 0, ccPayments: 0, investing: 0 };
  let count = 0;
  for (const t of transactions || []) {
    if (!digitsMatch(t.accountNum, trackSuffix)) continue;
    if (monthKeyOf(t.date) !== monthKey) continue;
    if (t.amount === 0) continue;
    count++;
    const c = lc(t);
    if (isTransfer(c)) buckets.transfers += t.amount;
    else if (isCCPayment(c)) buckets.ccPayments += t.amount;
    else if (isInvesting(c)) buckets.investing += t.amount;
    else if (t.amount > 0) buckets.inflows += t.amount;
    else buckets.spending += t.amount;
  }
  const txnNet = buckets.inflows + buckets.spending + buckets.transfers + buckets.ccPayments + buckets.investing;

  const actualDelta = opening && closing ? closing.balance - opening.balance : null;
  const expectedClosing = opening ? opening.balance + txnNet : null;
  const residual = actualDelta != null ? actualDelta - txnNet : null;

  const { totals } = pageTotalsByMonth(transactions, [monthKey]);
  const cashFlowNet = totals[monthKey].net;

  return {
    monthKey,
    trackSuffix,
    opening,
    closing,
    buckets,
    txnNet,
    txnCount: count,
    actualDelta,
    expectedClosing,
    residual,
    cashFlowNet,
    cashFlowIncome: totals[monthKey].income,
    cashFlowExpenses: totals[monthKey].expenses,
    // The headline gap the user is chasing.
    netVsActual: actualDelta != null ? cashFlowNet - actualDelta : null,
  };
}

function dispName(name, accountGroups, accountNicknames) {
  return (accountGroups && accountGroups[name]) || (accountNicknames && accountNicknames[name]) || name;
}

/** Per-card "look back": every past credit-card payment and the charges it
 *  covered. A payment covers the charges in (previous payment, this payment],
 *  so charges before the first payment fold into that first cycle; charges
 *  after the most recent payment are omitted (those are the upcoming charges).
 *
 *  cardNames: account names to treat as cards (matched against t.account).
 *  Returns [{ card, payments:[{date,amount}], cycles:[{ date, amount,
 *  periodStart, chargeTotal, charges:[{...txn, _date, runningTotal}] }] }],
 *  cycles newest-first, charges within a cycle newest-first. Cards with no
 *  payment history are omitted. Pure — shared by the Cards page and the export. */
export function computeCardLookback({ transactions, cardNames }) {
  const nameSet = new Set((cardNames || []).map((n) => (n || '').trim()).filter(Boolean));
  if (!nameSet.size) return [];

  const byCard = new Map();
  for (const t of transactions || []) {
    const acct = (t.account || '').trim();
    if (!acct || !nameSet.has(acct)) continue;
    if (!byCard.has(acct)) byCard.set(acct, []);
    byCard.get(acct).push(t);
  }

  const out = [];
  for (const name of cardNames || []) {
    const acct = (name || '').trim();
    const txs = byCard.get(acct) || [];

    const payments = txs
      .filter((t) => isCCPayment(lc(t)) && t.amount > 0)
      .map((t) => ({ date: parseDate(t.date), amount: t.amount }))
      .filter((p) => p.date)
      .sort((a, b) => a.date - b.date);
    if (!payments.length) continue;

    const charges = txs
      .filter((t) => !isCCPayment(lc(t)))
      .map((t) => ({ ...t, _date: parseDate(t.date) }))
      .filter((t) => t._date);

    const cycles = payments
      .map((p, i) => {
        const start = i > 0 ? payments[i - 1].date : null;
        const end = p.date;
        const inCycle = charges
          .filter((c) => (!start || c._date > start) && c._date <= end)
          .sort((a, b) => a._date - b._date); // oldest first for the running total
        let total = 0;
        const withRunning = inCycle
          .map((t) => { total += -t.amount; return { ...t, runningTotal: total }; })
          .reverse(); // newest first for display
        const chargeTotal = inCycle.reduce((s, t) => s + -t.amount, 0);
        return { date: end, amount: p.amount, periodStart: start, charges: withRunning, chargeTotal };
      })
      .reverse(); // most recent payment first

    out.push({ card: name, payments, cycles });
  }
  return out;
}

// ── Sheet builders ────────────────────────────────────────────────────────
// Styled-cell helpers — `{ v, s }` where `s` is a STYLE name understood by the
// xlsx writer. Money/percent cells must hold numbers so they format natively.
const T = (v) => ({ v, s: 'title' });
const SEC = (v) => ({ v, s: 'section' });
const H = (v) => ({ v, s: 'header' });
const HR = (v) => ({ v, s: 'headerRight' });
const LB = (v) => ({ v, s: 'labelBold' });
const MU = (v) => ({ v, s: 'muted' });
const M = (v) => ({ v, s: 'money' });
const MB = (v) => ({ v, s: 'moneyBold' });
const MT = (v) => ({ v, s: 'moneyTotal' });
const TL = (v) => ({ v, s: 'totalLabel' });
const P = (v) => ({ v, s: 'pct' });
const headerRow = (labels, rightIdx = []) => labels.map((l, i) => (rightIdx.includes(i) ? HR(l) : H(l)));

function buildRawSheet(txns, notesById, title) {
  const rows = [[T(title)], []];
  rows.push(headerRow(['Date', 'Description', 'Category', 'Subcategory', 'Amount', 'Account', 'Account #', 'Institution', 'Month', 'Type', 'Notes', 'Transaction ID'], [4]));
  for (const t of txns) {
    const c = lc(t);
    const type = isTransfer(c) ? 'Transfer'
      : isCCPayment(c) ? 'CC Payment'
      : isInvesting(c) ? 'Investing'
      : t.amount > 0 ? 'Income' : 'Expense';
    rows.push([
      t.date || '',
      t.description || t.fullDescription || '',
      t.category || '',
      t.subcategory || '',
      M(t.amount),
      t.account || '',
      t.accountNum || '',
      t.institution || '',
      cashFlowMonthKey(t) || t.month || '',
      type,
      (t.transactionId && notesById[t.transactionId]) || '',
      t.transactionId || '',
    ]);
  }
  return { rows, cols: [12, 36, 16, 16, 14, 22, 12, 18, 10, 12, 28, 24] };
}

// Group txns by category → subcategory, returning a summary block followed by
// a flat detail table. `displayAbs` shows expense magnitudes as positive.
function buildGroupedSheet({ txns, title, displayAbs }) {
  const byCat = {};
  for (const t of txns) {
    const cat = t.category || 'Uncategorized';
    const sub = t.subcategory || '(none)';
    if (!byCat[cat]) byCat[cat] = { signed: 0, subs: {}, txns: [] };
    byCat[cat].signed += t.amount;
    byCat[cat].subs[sub] = (byCat[cat].subs[sub] || 0) + t.amount;
    byCat[cat].txns.push(t);
  }
  const disp = (v) => (displayAbs ? Math.abs(v) : v);

  const cats = Object.entries(byCat)
    .map(([name, v]) => ({ name, ...v, display: disp(v.signed) }))
    .sort((a, b) => b.display - a.display);
  const grand = cats.reduce((s, c) => s + c.display, 0);

  const rows = [[T(title)], []];
  rows.push([SEC('SUMMARY BY CATEGORY')]);
  rows.push(headerRow(['Category', 'Subcategory', 'Amount', '% of total'], [2, 3]));
  for (const c of cats) {
    rows.push([LB(c.name), '', MB(c.display), grand ? P(c.display / grand) : '']);
    const subs = Object.entries(c.subs)
      .map(([n, v]) => ({ n, v: disp(v) }))
      .sort((a, b) => b.v - a.v);
    for (const s of subs) rows.push(['', s.n, M(s.v), '']);
  }
  rows.push([TL('TOTAL'), '', MT(grand), grand ? P(1) : '']);
  rows.push([]);

  rows.push([SEC('DETAIL (raw transactions, signed amounts)')]);
  rows.push(headerRow(['Date', 'Description', 'Category', 'Subcategory', 'Amount', 'Account', 'Institution', 'Month'], [4]));
  const detail = txns.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  for (const t of detail) {
    rows.push([
      t.date || '',
      t.description || t.fullDescription || '',
      t.category || '',
      t.subcategory || '',
      M(t.amount),
      t.account || '',
      t.institution || '',
      cashFlowMonthKey(t) || t.month || '',
    ]);
  }
  return { rows, cols: [16, 34, 16, 16, 14, 24, 18, 10] };
}

function buildCardSheet(transactions, asOf, accountGroups, accountNicknames) {
  // Derive the card list from the inflow leg of CC payments (positive amount
  // on the card account). Requiring amount > 0 keeps the paying checking
  // account — which carries the negative outflow leg — out of the card list.
  const cardSet = new Set();
  for (const t of transactions || []) {
    if (isCCPayment(lc(t)) && t.amount > 0 && (t.account || '').trim()) cardSet.add(t.account.trim());
  }
  const cards = [...cardSet].map((name) => ({ name }));
  const schedule = buildCardSchedule({ cards, transactions, asOf });

  const rows = [[T('NEXT CREDIT CARD PAYMENT — CHARGES BY CARD')], []];
  rows.push([MU('These are the charges since each card\'s last payment, i.e. what the next payment is expected to cover.')], []);

  rows.push([SEC('SUMMARY')]);
  rows.push(headerRow(['Card', 'Last payment', 'Last amount', 'Cadence (days)', 'Next payment (est.)', 'Est. next amount', '# charges'], [2, 5, 6]));
  for (const s of schedule) {
    rows.push([
      LB(dispName(s.card, accountGroups, accountNicknames)),
      s.lastPayment ? s.lastPayment.date.toISOString().slice(0, 10) : '',
      s.lastPayment ? M(s.lastPayment.amount) : '',
      s.cadenceDays,
      s.nextPaymentDate ? s.nextPaymentDate.toISOString().slice(0, 10) : '',
      MB(s.estimatedNextAmount),
      s.nextPaymentCharges.length,
    ]);
  }
  rows.push([]);

  rows.push([SEC('CHARGES FEEDING THE NEXT PAYMENT (per card)')]);
  rows.push(headerRow(['Card', 'Date', 'Description', 'Category', 'Subcategory', 'Amount'], [5]));
  for (const s of schedule) {
    const label = dispName(s.card, accountGroups, accountNicknames);
    for (const t of s.nextPaymentCharges) {
      rows.push([
        label,
        t.date || '',
        t.description || t.fullDescription || '',
        t.category || '',
        t.subcategory || '',
        M(t.amount),
      ]);
    }
  }
  return { rows, cols: [24, 16, 30, 18, 18, 16, 12] };
}

function buildCardLookbackSheet(transactions, accountGroups, accountNicknames) {
  // Same card derivation as the Next-Payment sheet: the inflow leg of CC payments.
  const cardSet = new Set();
  for (const t of transactions || []) {
    if (isCCPayment(lc(t)) && t.amount > 0 && (t.account || '').trim()) cardSet.add(t.account.trim());
  }
  const lookback = computeCardLookback({ transactions, cardNames: [...cardSet] });

  const rows = [[T('CARD LOOK BACK — PAST PAYMENTS & THE CHARGES THEY COVERED')], []];
  rows.push([MU('Each payment covers the charges since the previous payment — (previous payment, this payment]. Charges are negative; refunds positive.')]);
  rows.push([]);

  if (!lookback.length) {
    rows.push([MU('No credit card payment history found.')]);
    return { rows, cols: [14, 40, 16, 16, 14, 14] };
  }

  for (const entry of lookback) {
    const label = dispName(entry.card, accountGroups, accountNicknames);
    const totalPaid = entry.payments.reduce((s, p) => s + p.amount, 0);
    rows.push([SEC(label)]);
    rows.push([LB(`${entry.payments.length} payment(s)`), '', '', TL('Total paid'), MT(totalPaid), '']);
    rows.push([]);

    for (const cyc of entry.cycles) {
      const dateStr = cyc.date.toISOString().slice(0, 10);
      rows.push([LB(`Payment ${dateStr}`), '', '', LB('Amount paid'), MB(cyc.amount), '']);
      if (cyc.charges.length) {
        rows.push(headerRow(['Date', 'Description', 'Category', 'Subcategory', 'Amount', 'Running Total'], [4, 5]));
        for (const t of cyc.charges) {
          rows.push([
            t.date || '',
            t.description || t.fullDescription || '',
            t.category || '',
            t.subcategory || '',
            M(t.amount),
            M(t.runningTotal),
          ]);
        }
        rows.push([TL('Charges covered'), '', '', '', MT(cyc.chargeTotal), '']);
      } else {
        rows.push([MU('No charges recorded for this payment.')]);
      }
      rows.push([]);
    }
    rows.push([]);
  }
  return { rows, cols: [14, 40, 16, 16, 14, 14] };
}

function buildReconciliationSheet(transactions, balanceHistory, monthKeys, trackSuffix) {
  const rows = [[T(`BANK BALANCE RECONCILIATION — account ending …${trackSuffix}`)], []];
  rows.push([MU('Why the bank balance change does not equal the Cash Flow "Net" column:')]);
  rows.push([MU('• "Net" is Income − Expenses across ALL accounts (including credit-card spending), and excludes transfers, card payments, investments and retirement.')]);
  rows.push([MU(`• The …${trackSuffix} balance only moves when money actually enters or leaves THAT account — including the excluded flows above, and NOT credit-card spending until the card is paid.`)]);
  rows.push([]);

  for (const key of monthKeys) {
    const r = computeMonthReconciliation({ transactions, balanceHistory, monthKey: key, trackSuffix });
    rows.push([SEC(monthLabel(key)), SEC('')]);
    rows.push([`Opening balance${r.opening ? ` (snapshot ${r.opening.date})` : ' (no prior snapshot)'}`, M(r.opening?.balance)]);
    rows.push(['  + Income / inflows to account', M(r.buckets.inflows)]);
    rows.push(['  − Spending from account', M(r.buckets.spending)]);
    rows.push(['  ± Transfers', M(r.buckets.transfers)]);
    rows.push(['  − Credit card payments', M(r.buckets.ccPayments)]);
    rows.push(['  − Investments / retirement', M(r.buckets.investing)]);
    rows.push([LB('  = Net movement on account (from transactions)'), MB(r.txnNet)]);
    rows.push([LB('Expected closing balance'), MB(r.expectedClosing)]);
    rows.push([LB(`Actual closing balance${r.closing ? ` (snapshot ${r.closing.date})` : ' (no snapshot)'}`), MB(r.closing?.balance)]);
    rows.push([MU('Unexplained difference (timing / unsynced transactions)'), M(r.residual)]);
    rows.push([]);
    rows.push([LB('Cash Flow Net (all accounts: Income − Expenses)'), MB(r.cashFlowNet)]);
    rows.push(['  Income (all accounts)', M(r.cashFlowIncome)]);
    rows.push(['  Expenses (all accounts)', M(r.cashFlowExpenses)]);
    rows.push([`…${trackSuffix} actual balance change`, M(r.actualDelta)]);
    rows.push([TL('Gap (Net − balance change)'), MT(r.netVsActual)]);
    rows.push([MU(`Reconciled mainly by → transfers ${fmtNum(r.buckets.transfers)}, card payments ${fmtNum(r.buckets.ccPayments)}, investing ${fmtNum(r.buckets.investing)}, plus spending on other accounts`)]);
    rows.push([]);
    rows.push([]);
  }
  return { rows, cols: [54, 18] };
}

function fmtNum(v) {
  if (v == null) return '—';
  const sign = v < 0 ? '-' : '+';
  return `${sign}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
}

/** Assemble the full set of sheets for the deep-dive workbook.
 *
 *  monthKeys: months to include (e.g. [prevMonth, selectedMonth]). Raw, Income
 *  and Expenses cover these months; the CC sheet covers the latest charges
 *  regardless of month (that is what the next payment will actually bill). */
export function buildDeepDiveSheets({
  transactions,
  balanceHistory,
  monthKeys,
  trackSuffix,
  notesById = {},
  accountGroups = {},
  accountNicknames = {},
  asOf = new Date(),
}) {
  const keySet = new Set(monthKeys);
  const inWindow = (transactions || []).filter((t) => keySet.has(cashFlowMonthKey(t)) && t.amount !== 0);

  // Same split as the page: each category-month is income or spending as a
  // whole, so a refund sits on the Expenses sheet netting its category down.
  const { role } = cashFlowBreakdown(transactions, monthKeys);
  const incomeTxns = inWindow.filter((t) => role(t) === 'income');
  const expenseTxns = inWindow.filter((t) => role(t) === 'expense');

  const windowLabel = monthKeys.map(monthLabel).join(' + ');

  return [
    { name: 'Reconciliation', ...buildReconciliationSheet(transactions, balanceHistory, monthKeys, trackSuffix) },
    { name: 'Income', ...buildGroupedSheet({ txns: incomeTxns, title: `INCOME — ${windowLabel}`, displayAbs: false }) },
    { name: 'Expenses', ...buildGroupedSheet({ txns: expenseTxns, title: `EXPENSES — ${windowLabel}`, displayAbs: true }) },
    { name: 'Next CC Payment by Card', ...buildCardSheet(transactions, asOf, accountGroups, accountNicknames) },
    { name: 'Card Look Back', ...buildCardLookbackSheet(transactions, accountGroups, accountNicknames) },
    { name: 'Raw', ...buildRawSheet(inWindow, notesById, `RAW TRANSACTIONS — ${windowLabel} (no exclusions)`) },
  ];
}
