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

const NON_EXPENSE_CATS = new Set(['paycheck', 'income', 'tax refund/payment']);
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function lc(t) { return (t.category || '').toLowerCase(); }
const isTransfer = (c) => c === 'transfer';
const isCCPayment = (c) => c === 'credit card payment' || c === 'credit card payments';
const isInvesting = (c) => c === 'investments' || c === 'retirement';
const isSpecial = (c) => isTransfer(c) || isCCPayment(c) || isInvesting(c);

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

function digitsMatch(rawAcctNum, suffix) {
  if (!rawAcctNum || !suffix) return false;
  return String(rawAcctNum).replace(/\D+/g, '').endsWith(suffix);
}

// Page-equivalent per-month income/expense totals (all accounts) for a set of
// month keys. Returns { [key]: { income, expenses, net } }.
function pageTotalsByMonth(transactions, monthKeys) {
  const keys = new Set(monthKeys);
  const expSignedByCat = {};
  const income = {};
  for (const k of monthKeys) income[k] = 0;

  for (const t of transactions || []) {
    if (!t.date || t.amount === 0) continue;
    const c = lc(t);
    if (isTransfer(c) || isCCPayment(c) || isInvesting(c)) continue;
    const key = monthKeyOf(t.date);
    if (!keys.has(key)) continue;
    if (t.amount > 0) income[key] += t.amount;
    if (NON_EXPENSE_CATS.has(c)) continue;
    const catKey = t.category || 'Uncategorized';
    if (!expSignedByCat[catKey]) expSignedByCat[catKey] = {};
    expSignedByCat[catKey][key] = (expSignedByCat[catKey][key] || 0) + t.amount;
  }

  const qualifying = new Set();
  for (const cat of Object.keys(expSignedByCat)) {
    let net = 0;
    for (const k of monthKeys) net += expSignedByCat[cat][k] || 0;
    if (net < 0 || (cat === 'Uncategorized' && net !== 0)) qualifying.add(cat);
  }

  const out = {};
  for (const k of monthKeys) {
    let expenses = 0;
    for (const cat of qualifying) expenses += Math.abs(expSignedByCat[cat]?.[k] || 0);
    out[k] = { income: income[k], expenses, net: income[k] - expenses };
  }
  return { totals: out, qualifying };
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

// ── Sheet builders ────────────────────────────────────────────────────────

function buildRawSheet(txns, notesById, title) {
  const rows = [[title]];
  rows.push(['Date', 'Description', 'Category', 'Subcategory', 'Amount', 'Account', 'Account #', 'Institution', 'Month', 'Type', 'Notes', 'Transaction ID']);
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
      t.amount,
      t.account || '',
      t.accountNum || '',
      t.institution || '',
      t.month || monthKeyOf(t.date) || '',
      type,
      (t.transactionId && notesById[t.transactionId]) || '',
      t.transactionId || '',
    ]);
  }
  return rows;
}

// Group txns by category → subcategory, returning a summary block followed by
// a flat detail table. `signedToDisplay` maps a category's signed net to the
// number shown (identity for income, abs for expenses).
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

  const rows = [[title], []];
  rows.push(['SUMMARY BY CATEGORY']);
  rows.push(['Category', 'Subcategory', 'Amount', '% of total']);
  for (const c of cats) {
    rows.push([c.name, '', c.display, grand ? c.display / grand : 0]);
    const subs = Object.entries(c.subs)
      .map(([n, v]) => ({ n, v: disp(v) }))
      .sort((a, b) => b.v - a.v);
    for (const s of subs) rows.push(['', s.n, s.v, '']);
  }
  rows.push(['TOTAL', '', grand, grand ? 1 : '']);
  rows.push([]);

  rows.push(['DETAIL (raw transactions, signed amounts)']);
  rows.push(['Date', 'Description', 'Category', 'Subcategory', 'Amount', 'Account', 'Institution', 'Month']);
  const detail = txns.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  for (const t of detail) {
    rows.push([
      t.date || '',
      t.description || t.fullDescription || '',
      t.category || '',
      t.subcategory || '',
      t.amount,
      t.account || '',
      t.institution || '',
      t.month || monthKeyOf(t.date) || '',
    ]);
  }
  return rows;
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

  const rows = [['NEXT CREDIT CARD PAYMENT — CHARGES BY CARD'], []];
  rows.push(['These are the charges since each card\'s last payment, i.e. what the next payment is expected to cover.'], []);

  rows.push(['SUMMARY']);
  rows.push(['Card', 'Last payment', 'Last amount', 'Cadence (days)', 'Next payment (est.)', 'Est. next amount', '# charges']);
  for (const s of schedule) {
    rows.push([
      dispName(s.card, accountGroups, accountNicknames),
      s.lastPayment ? s.lastPayment.date.toISOString().slice(0, 10) : '',
      s.lastPayment ? s.lastPayment.amount : '',
      s.cadenceDays,
      s.nextPaymentDate ? s.nextPaymentDate.toISOString().slice(0, 10) : '',
      s.estimatedNextAmount,
      s.chargesSinceLast.length,
    ]);
  }
  rows.push([]);

  rows.push(['CHARGES FEEDING THE NEXT PAYMENT (per card)']);
  rows.push(['Card', 'Date', 'Description', 'Category', 'Subcategory', 'Amount']);
  for (const s of schedule) {
    const label = dispName(s.card, accountGroups, accountNicknames);
    for (const t of s.chargesSinceLast) {
      rows.push([
        label,
        t.date || '',
        t.description || t.fullDescription || '',
        t.category || '',
        t.subcategory || '',
        t.amount,
      ]);
    }
  }
  return rows;
}

function money(v) {
  if (v == null) return '';
  return v;
}

function buildReconciliationSheet(transactions, balanceHistory, monthKeys, trackSuffix) {
  const rows = [[`BANK BALANCE RECONCILIATION — account ending …${trackSuffix}`], []];
  rows.push(['Why the bank balance change does not equal the Cash Flow "Net" column:']);
  rows.push(['• "Net" is Income − Expenses across ALL accounts (including credit-card spending), and excludes transfers, card payments, investments and retirement.']);
  rows.push([`• The …${trackSuffix} balance only moves when money actually enters or leaves THAT account — including the excluded flows above, and NOT credit-card spending until the card is paid.`]);
  rows.push([]);

  for (const key of monthKeys) {
    const r = computeMonthReconciliation({ transactions, balanceHistory, monthKey: key, trackSuffix });
    rows.push([`${monthLabel(key)}`]);
    rows.push([`Opening balance${r.opening ? ` (snapshot ${r.opening.date})` : ' (no prior snapshot)'}`, money(r.opening?.balance)]);
    rows.push(['  + Income / inflows to account', money(r.buckets.inflows)]);
    rows.push(['  − Spending from account', money(r.buckets.spending)]);
    rows.push(['  ± Transfers', money(r.buckets.transfers)]);
    rows.push(['  − Credit card payments', money(r.buckets.ccPayments)]);
    rows.push(['  − Investments / retirement', money(r.buckets.investing)]);
    rows.push(['  = Net movement on account (from transactions)', money(r.txnNet)]);
    rows.push([`Expected closing balance`, money(r.expectedClosing)]);
    rows.push([`Actual closing balance${r.closing ? ` (snapshot ${r.closing.date})` : ' (no snapshot)'}`, money(r.closing?.balance)]);
    rows.push(['Unexplained difference (timing / unsynced transactions)', money(r.residual)]);
    rows.push([]);
    rows.push(['Cash Flow Net (all accounts: Income − Expenses)', money(r.cashFlowNet)]);
    rows.push(['  Income (all accounts)', money(r.cashFlowIncome)]);
    rows.push(['  Expenses (all accounts)', money(r.cashFlowExpenses)]);
    rows.push([`…${trackSuffix} actual balance change`, money(r.actualDelta)]);
    rows.push(['Gap (Net − balance change)', money(r.netVsActual)]);
    rows.push(['Reconciled mainly by →', `transfers ${fmtNum(r.buckets.transfers)}, card payments ${fmtNum(r.buckets.ccPayments)}, investing ${fmtNum(r.buckets.investing)}, plus spending on other accounts`]);
    rows.push([]);
    rows.push([]);
  }
  return rows;
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
  const inWindow = (transactions || []).filter((t) => keySet.has(monthKeyOf(t.date)) && t.amount !== 0);

  const { qualifying } = pageTotalsByMonth(transactions, monthKeys);

  // Income: positive amounts, excluding the special (own-money) categories.
  const incomeTxns = inWindow.filter((t) => {
    const c = lc(t);
    return t.amount > 0 && !isSpecial(c);
  });

  // Expenses: transactions in qualifying expense categories (refunds included
  // so they net down the totals), excluding income-side categories.
  const expenseTxns = inWindow.filter((t) => {
    const c = lc(t);
    if (isSpecial(c) || NON_EXPENSE_CATS.has(c)) return false;
    return qualifying.has(t.category || 'Uncategorized');
  });

  const windowLabel = monthKeys.map(monthLabel).join(' + ');

  return [
    { name: 'Reconciliation', rows: buildReconciliationSheet(transactions, balanceHistory, monthKeys, trackSuffix) },
    { name: 'Income', rows: buildGroupedSheet({ txns: incomeTxns, title: `INCOME — ${windowLabel}`, displayAbs: false }) },
    { name: 'Expenses', rows: buildGroupedSheet({ txns: expenseTxns, title: `EXPENSES — ${windowLabel}`, displayAbs: true }) },
    { name: 'Next CC Payment by Card', rows: buildCardSheet(transactions, asOf, accountGroups, accountNicknames) },
    { name: 'Raw', rows: buildRawSheet(inWindow, notesById, `RAW TRANSACTIONS — ${windowLabel} (no exclusions)`) },
  ];
}
