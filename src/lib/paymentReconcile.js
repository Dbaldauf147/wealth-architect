/* What the card payment was expected to be, what it actually was, and which
   charges make up each number.

   The two disagree for a structural reason. The reminder email projects
   "charges since your last payment" (see cardSchedule.js, which says so in its
   own header). A card issuer bills a *statement period*, which closed days or
   weeks before the payment leaves your account. So the estimate and the bill
   are measuring two different windows, and a payment that covers a window the
   estimate never looked at comes in higher — sometimes much higher.

   We don't receive statement-close events, so the close date is recovered
   rather than read: charges are accumulated forward in date order and the day
   the running total equals the payment is the day the statement closed. A
   payment that reconciles this way comes with the exact charges behind it; one
   that doesn't is reported as unreconciled rather than fudged, because an
   export headed "the charges that add up to this" has to actually add up.

   Pure: no React, no DOM, no network, and every "now" arrives as an argument.

   When the card's statement closing day is known (set on the Transactions
   page, or estimated by statementWindows.js), that wins over all of the
   above: the statement a payment paid is simply the cycle ending on the close
   at least 20 days before it. Run-matching is kept for cards with no closing
   day. On a real ledger it rarely matches — one double payment or a 33¢ fee
   that never reached the sheet breaks the chain for every later statement —
   which is why the closing day comes first.
*/
import { cyclePaidBy } from './closeDates.js';

/* A bare "2026-08-15" is parsed as UTC midnight by `new Date`, which in any
   western timezone renders and exports as the 14th. The dates here end up in a
   spreadsheet the user reconciles against a statement, so they're read as local
   calendar days and parsed as such. */
function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  const s = String(v);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10)) && s.length <= 10;
  const d = dateOnly ? new Date(`${s.slice(0, 10)}T00:00:00`) : new Date(s);
  return isNaN(d) ? null : d;
}

/** Local-calendar day key, so a statement boundary is a day and not an instant. */
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Float sums leave cents like 603.6500000000001 behind; money comparisons and
 *  exported cells both want the rounded value. */
function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

// Mirrors cardSchedule.js — the payment leg is categorised, not inferred from
// the sign, so a big refund never reads as a payment.
function isCreditCardPayment(t) {
  const cat = (t.category || '').toLowerCase();
  return cat === 'credit card payment' || cat === 'credit card payments';
}

/** The card's payment events (the inflow leg that pays it down), oldest first. */
export function paymentsOf(transactions) {
  return (transactions || [])
    .filter(t => isCreditCardPayment(t) && Number(t.amount) > 0)
    .map(t => ({ ...t, _date: parseDate(t.date), amount: Number(t.amount) }))
    .filter(p => p._date)
    .sort((a, b) => a._date - b._date);
}

/** Everything that isn't a payment, oldest first. Refunds stay in: they're part
 *  of what the statement nets out to, and dropping them would stop the window
 *  ever reconciling on a month with a return in it. */
export function chargesOf(transactions) {
  return (transactions || [])
    .filter(t => !isCreditCardPayment(t) && Number(t.amount) !== 0)
    .map(t => ({ ...t, _date: parseDate(t.date), amount: Number(t.amount) }))
    .filter(t => t._date)
    .sort((a, b) => a._date - b._date);
}

/** Amount owed by a set of charges. Charges are negative and refunds positive,
 *  so flipping the sign gives what you owe on them. */
export function owedFor(charges) {
  return round2((charges || []).reduce((s, t) => s + -Number(t.amount), 0));
}

/** Group charges into whole days, because a statement closes on a day and not
 *  between two charges that share one. */
function groupByDay(charges) {
  const days = [];
  for (const c of charges) {
    const key = dayKey(c._date);
    const last = days[days.length - 1];
    if (last && last.key === key) last.charges.push(c);
    else days.push({ key, date: c._date, charges: [c] });
  }
  for (const d of days) d.sum = owedFor(d.charges);
  return days;
}

/** Find a run of whole days whose charges sum to `target`.
 *
 *  Anchored first: a run starting at the beginning of the unconsumed charges is
 *  the tidy case — each statement picking up exactly where the last one left
 *  off. Real ledgers aren't that tidy. A card that was already open when the
 *  sheet starts, a statement paid at something other than the full balance, a
 *  fee that never reached the ledger — any of these break the chain, and once
 *  broken every later payment inherits the break.
 *
 *  So when the anchored run misses, any run of days is considered, preferring
 *  the one ending latest (the statement closest to the payment) and, among
 *  those, the longest. An exact-to-the-cent match on a real amount is not
 *  something arbitrary charges do by accident, so a hit here is worth having;
 *  `anchored` records which kind it was, and the charges skipped before an
 *  unanchored run are reported rather than silently dropped.
 */
function findDayWindow(days, target, tolerance) {
  const n = days.length;
  if (n === 0) return null;
  // prefix[i] = owed across days[0..i-1]
  const prefix = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = round2(prefix[i] + days[i].sum);

  // Anchored: starts at the first unconsumed day.
  for (let j = 0; j < n; j++) {
    if (Math.abs(round2(prefix[j + 1] - prefix[0]) - target) <= tolerance) {
      return { start: 0, end: j, anchored: true };
    }
  }
  // Otherwise the latest-ending run wins, and the longest among those.
  for (let j = n - 1; j >= 0; j--) {
    for (let i = 0; i <= j; i++) {
      if (Math.abs(round2(prefix[j + 1] - prefix[i]) - target) <= tolerance) {
        return { start: i, end: j, anchored: false };
      }
    }
  }
  return null;
}

/** Walk each payment in turn and find the run of charges that sums to it.
 *
 *  Windows chain where they can: statement periods are contiguous, so each
 *  payment's window starts where the previous one ended. That's what makes the
 *  result explanatory — if one payment's window reaches back further than the
 *  estimate's did, the charges it swept up are visible.
 *
 *  Unmatched payments still report the charges they'd have covered, flagged
 *  `matched: false` so nothing downstream presents an approximation as exact.
 */
export function reconcilePayments({ payments, charges, tolerance = 0.01 }) {
  const pays = payments || [];
  const chs = charges || [];
  const out = [];
  let cursor = 0;

  for (const payment of pays) {
    const target = round2(payment.amount);

    // Candidates: everything unconsumed that predates the payment. A charge on
    // the payment's own day can't have been on the statement it pays.
    const candidates = [];
    let scan = cursor;
    while (scan < chs.length && chs[scan]._date < payment._date) {
      candidates.push(chs[scan]);
      scan += 1;
    }

    const days = groupByDay(candidates);
    const hit = findDayWindow(days, target, tolerance);

    if (hit) {
      const window = [];
      for (let i = hit.start; i <= hit.end; i++) window.push(...days[i].charges);
      const skipped = [];
      for (let i = 0; i < hit.start; i++) skipped.push(...days[i].charges);
      out.push({
        payment,
        charges: window,
        total: owedFor(window),
        matched: true,
        anchored: hit.anchored,
        skipped,
        closeDate: days[hit.end].date,
        openDate: days[hit.start].date,
      });
      // Consume through the end of the matched run; anything before it was
      // skipped and can't belong to a later statement either.
      cursor += days.slice(0, hit.end + 1).reduce((s, d) => s + d.charges.length, 0);
    } else {
      out.push({
        payment,
        charges: candidates,
        total: owedFor(candidates),
        matched: false,
        anchored: false,
        skipped: [],
        closeDate: null,
        openDate: candidates.length ? candidates[0]._date : null,
      });
      cursor = scan;
    }
  }

  return out;
}

/** The statement a payment paid, from the card's closing day: the charges
 *  in the cycle, what they total, and how far that is from the payment.
 *
 *  `matched` keeps its meaning from run-matching — the charges sum to the
 *  payment to the cent — so the UI and the export treat both alike. `near`
 *  is the useful middle ground: within a couple of dollars, which is interest
 *  or a fee the sheet never saw rather than the wrong window. */
export function statementForPayment({ payment, charges, closeDay, tolerance = 0.01 }) {
  const { openDate, closeDate } = cyclePaidBy(payment._date, closeDay);
  const end = new Date(closeDate.getFullYear(), closeDate.getMonth(), closeDate.getDate() + 1);
  const window = (charges || []).filter(c => c._date >= openDate && c._date < end);
  const total = owedFor(window);
  const drift = round2(payment.amount - total);
  return {
    payment,
    charges: window,
    total,
    drift,
    matched: Math.abs(drift) <= tolerance,
    near: Math.abs(drift) <= Math.max(2, payment.amount * 0.005),
    anchored: true,
    skipped: [],
    openDate,
    closeDate,
    basis: 'closeDay',
  };
}

/** One explanation per payment: the statement cycle when the closing day is
 *  known, run-matching otherwise. Same order as `payments`. */
function explainPayments({ payments, charges, tolerance, closeDay }) {
  if (closeDay) return payments.map(payment => statementForPayment({ payment, charges, closeDay, tolerance }));
  return reconcilePayments({ payments, charges, tolerance })
    .map(r => ({ ...r, drift: round2(r.payment.amount - r.total), near: r.matched, basis: 'runMatch' }));
}

/** Rebuild the figure the reminder email would have carried for one payment.
 *
 *  The email projects charges since the previous payment, as of the day before
 *  the payment lands — that's the window cardSchedule.js uses, reproduced here
 *  against a payment that has since happened.
 *
 *  It is a reconstruction from today's ledger, not the sent number: a charge
 *  that arrived in the sheet after the email went out is counted here and
 *  wasn't counted there. Callers that hold the recorded figure should prefer
 *  it and use this only as the fallback.
 *
 *  Deliberately still "since the previous payment", even though cardSchedule no
 *  longer projects that way. This reproduces what the email SAID, and every
 *  payment it can be asked about predates that change — emails sent afterwards
 *  record their own figure, so the reconstruction is only ever reached for the
 *  older rows. Updating it to the statement window would make it describe a
 *  number those emails never contained.
 */
export function reconstructExpected({ payment, prevPayment, charges }) {
  if (!payment) return null;
  // The email goes out the day before, so the cutoff is the end of the day
  // before the payment.
  const cutoff = new Date(payment._date.getFullYear(), payment._date.getMonth(), payment._date.getDate());
  const start = prevPayment ? prevPayment._date : null;
  const window = (charges || []).filter(t => {
    if (start && t._date <= start) return false;
    return t._date < cutoff;
  });
  return {
    amount: owedFor(window),
    charges: window,
    windowStart: start,
    windowEnd: cutoff,
    source: 'reconstructed',
  };
}

/** Expected vs actual for a card's most recent payment, with the charges behind
 *  each number.
 *
 *  `recorded` is what the reminder email actually sent, when we have it —
 *  `{ amount, charges?, sentAt? }`. Present, it wins and the source reads
 *  'emailed'; absent, the reconstruction stands in and says so.
 */
export function comparePaymentForCard({ transactions, recorded = null, tolerance = 0.01, closeDay = null }) {
  const payments = paymentsOf(transactions);
  const charges = chargesOf(transactions);
  if (payments.length === 0) {
    return { actual: null, expected: null, variance: null, reconciliation: [] };
  }

  const reconciliation = explainPayments({ payments, charges, tolerance, closeDay });
  const last = reconciliation[reconciliation.length - 1];
  const prevPayment = payments.length > 1 ? payments[payments.length - 2] : null;

  const actual = {
    date: last.payment._date,
    amount: round2(last.payment.amount),
    charges: last.charges,
    total: last.total,
    matched: last.matched,
    near: last.near,
    drift: last.drift,
    basis: last.basis,
    anchored: last.anchored,
    skipped: last.skipped,
    openDate: last.openDate,
    closeDate: last.closeDate,
  };

  let expected = reconstructExpected({ payment: last.payment, prevPayment, charges });
  if (recorded && Number.isFinite(Number(recorded.amount))) {
    expected = {
      amount: round2(recorded.amount),
      // The recorded charge list is what the email counted. Falling back to the
      // reconstructed list would hand back an export that doesn't sum to the
      // figure beside it, so an amount without its lines says so instead.
      charges: Array.isArray(recorded.charges) && recorded.charges.length
        ? recorded.charges.map(t => ({ ...t, _date: parseDate(t.date), amount: Number(t.amount) })).filter(t => t._date)
        : [],
      windowStart: expected ? expected.windowStart : null,
      windowEnd: expected ? expected.windowEnd : null,
      source: 'emailed',
      sentAt: recorded.sentAt || null,
    };
  }

  return {
    actual,
    expected,
    variance: expected ? round2(actual.amount - expected.amount) : null,
    reconciliation,
  };
}

/** Every payment on a card, newest first, each with what it was expected to be
 *  and what it turned out to be.
 *
 *  The per-card row on the schedule answers "what happened last time"; this
 *  answers "does it always do that". A card whose actual runs above its
 *  estimate every month is telling you the estimate's window is wrong, which is
 *  a different problem from one month going badly.
 *
 *  `recorded` is the list of reminder records for this card; each payment picks
 *  up the one matching its own date, so a history built after the records start
 *  accumulating gets the sent figure for recent rows and a reconstruction for
 *  older ones.
 */
export function buildPaymentHistory({ transactions, recorded = [], tolerance = 0.01, closeDay = null }) {
  const payments = paymentsOf(transactions);
  const charges = chargesOf(transactions);
  if (payments.length === 0) return [];

  const reconciliation = explainPayments({ payments, charges, tolerance, closeDay });
  const byDate = new Map();
  for (const r of recorded || []) {
    if (r && r.dateKey) byDate.set(r.dateKey, r);
  }

  const rows = reconciliation.map((r, i) => {
    const prevPayment = i > 0 ? payments[i - 1] : null;
    const key = dayKey(r.payment._date);
    const rec = byDate.get(key) || null;

    let expected = reconstructExpected({ payment: r.payment, prevPayment, charges });
    if (rec && Number.isFinite(Number(rec.amount))) {
      expected = {
        amount: round2(rec.amount),
        charges: Array.isArray(rec.charges) && rec.charges.length
          ? rec.charges.map(t => ({ ...t, _date: parseDate(t.date), amount: Number(t.amount) })).filter(t => t._date)
          : [],
        windowStart: expected ? expected.windowStart : null,
        windowEnd: expected ? expected.windowEnd : null,
        source: 'emailed',
        sentAt: rec.sentAt || null,
        // What the ledger says the email would have counted, for the audit
        // when the record carries an amount but not its lines.
        reconstructedCharges: expected ? expected.charges : [],
      };
    }

    return {
      dateKey: key,
      date: r.payment._date,
      actual: {
        date: r.payment._date,
        amount: round2(r.payment.amount),
        charges: r.charges,
        total: r.total,
        matched: r.matched,
        near: r.near,
        drift: r.drift,
        basis: r.basis,
        anchored: r.anchored,
        skipped: r.skipped,
        closeDate: r.closeDate,
        openDate: r.openDate,
      },
      expected,
      variance: expected ? round2(round2(r.payment.amount) - expected.amount) : null,
    };
  });

  rows.reverse(); // newest first — the one you're asking about is the recent one
  return rows;
}

/* ── Prediction audit ──────────────────────────────────────────────────────
   Which charges the estimate got wrong for one payment, and why.

   The estimate is "charges since the previous payment, up to the day before
   this one"; the payment is the statement that closed weeks earlier. Lining
   the two charge lists up shows exactly where they part company, and each
   difference has a cause that can be read off its date:

     missed    on the statement, not in the estimate
     extra     in the estimate, not on the statement
     changed   in both, at different amounts (a pending charge that posted
               for more — usually a tip — or an edit after the email)

   Whatever the lines don't account for is the residual: interest, a fee, a
   carried balance or a partial payment, none of which is a charge either side
   could have counted.

   `impact` is signed like the row's variance: positive when the item made the
   real payment bigger than the estimate. Items plus residual add back up to
   the variance, so nothing is left unexplained. */

function chargeKey(t) {
  if (t.transactionId) return `id:${t.transactionId}|${round2(t.amount)}`;
  return `${dayKey(t._date)}|${round2(t.amount)}|${String(t.description || '').trim().toLowerCase()}`;
}

/** Same charge on both sides, ignoring amount — used only to tell "changed"
 *  from an unrelated missed/extra pair. */
function looseKey(t) {
  if (t.transactionId) return `id:${t.transactionId}`;
  return `${dayKey(t._date)}|${String(t.description || '').trim().toLowerCase()}`;
}

function longDay(d) {
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '?';
}

function money(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(n || 0));
}

function missedReason(c, { expected, actual }) {
  const start = expected.windowStart;
  if (start && c._date <= start) {
    return `Dated ${longDay(c._date)}, on or before the previous payment (${longDay(start)}). `
      + 'The estimate only counts charges after the last payment, but the card billed it on the statement '
      + `that closed ${longDay(actual.closeDate)} — so this payment covered it and the estimate didn't.`;
  }
  if (expected.source === 'emailed') {
    const sent = expected.sentAt ? ` (sent ${longDay(new Date(expected.sentAt))})` : '';
    return `Inside the estimate's window but not in the emailed list${sent} — `
      + 'it most likely reached the sheet after the reminder went out.';
  }
  return "Inside the estimate's window but not counted by it.";
}

function extraReason(c, { actual }) {
  if (actual.closeDate && c._date > actual.closeDate) {
    return `Dated ${longDay(c._date)}, after the statement closed on ${longDay(actual.closeDate)}. `
      + "It's on next month's bill, but the estimate counted everything up to the day before the payment.";
  }
  if (actual.openDate && c._date < actual.openDate) {
    return `Dated ${longDay(c._date)}, before this statement opened (${longDay(actual.openDate)}) — `
      + 'it was billed and paid on the previous statement.';
  }
  return "Within the statement's dates but no longer on this card in the ledger — "
    + 'recategorised, moved to another account or deleted after the estimate was made.';
}

/** Audit one Payment History row. See the block comment above. */
export function auditPrediction(row) {
  const { expected, actual } = row || {};
  if (!expected || !actual) {
    return { status: 'unknown', items: [], residual: 0, residualReason: null, note: 'No estimate to compare against.' };
  }
  if (actual.basis !== 'closeDay' && !actual.matched) {
    return {
      status: 'unknown',
      items: [],
      residual: 0,
      residualReason: null,
      note: "The statement behind this payment couldn't be found — no closing day is set and no run of charges sums to it. "
        + "Set the closing day from the Transactions page's Statement column to audit it.",
    };
  }

  let expCharges = expected.charges || [];
  let note = null;
  if (expCharges.length === 0 && (expected.reconstructedCharges || []).length) {
    expCharges = expected.reconstructedCharges;
    note = "The emailed figure didn't keep its charge list, so the estimate's charges are rebuilt from the ledger.";
  }

  // Multiset difference on the exact key: what's left on each side is the
  // disagreement.
  const pool = new Map();
  for (const c of actual.charges || []) {
    const k = chargeKey(c);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(c);
  }
  const extra = [];
  for (const c of expCharges) {
    const bucket = pool.get(chargeKey(c));
    if (bucket && bucket.length) bucket.shift();
    else extra.push(c);
  }
  const missed = [...pool.values()].flat();

  // A leftover on each side that's the same charge at a new amount is one
  // "changed" item, not a missed and an extra.
  const missedByLoose = new Map();
  for (const c of missed) {
    const k = looseKey(c);
    if (!missedByLoose.has(k)) missedByLoose.set(k, []);
    missedByLoose.get(k).push(c);
  }
  const paired = new Set();
  const items = [];
  const ctx = { expected, actual };
  for (const c of extra) {
    const twin = (missedByLoose.get(looseKey(c)) || []).shift();
    if (twin) {
      paired.add(twin);
      items.push({
        kind: 'changed',
        charge: twin,
        impact: round2(c.amount - twin.amount),
        reason: `The estimate counted it at ${money(c.amount)}; it posted at ${money(twin.amount)}. `
          + 'A pending charge that settled for a different amount (a tip, a hotel or fuel hold) or an edit after the estimate.',
      });
    } else {
      items.push({ kind: 'extra', charge: c, impact: round2(c.amount), reason: extraReason(c, ctx) });
    }
  }
  for (const c of missed) {
    if (paired.has(c)) continue;
    items.push({ kind: 'missed', charge: c, impact: round2(-c.amount), reason: missedReason(c, ctx) });
  }
  items.sort((a, b) => a.charge._date - b.charge._date);

  const explained = round2(items.reduce((s, i) => s + i.impact, 0));
  const residual = round2(round2(actual.amount - expected.amount) - explained);
  const material = Math.abs(residual) >= 1;
  const ownLines = owedFor(expCharges);
  return {
    status: items.length === 0 && !material ? 'ok' : 'miss',
    items,
    explained,
    residual: material ? residual : 0,
    residualReason: material
      ? `The payment was ${money(actual.amount)} but the statement's charges total ${money(actual.total)}`
        + (Math.abs(ownLines - expected.amount) >= 1 ? `, and the estimate's own lines total ${money(ownLines)} against its ${money(expected.amount)}` : '')
        + '. That part is interest, a fee, a balance carried from an earlier month or a partial or extra payment — '
        + 'not a charge the estimate could have counted.'
      : null,
    note,
  };
}

/** Sheets for the .xlsx export behind one of the two figures.
 *
 *  Shaped for src/lib/xlsx.js — `[{ name, rows: [[...]] }]`, header row first.
 *  The last row is the total, so the file answers the question it was opened
 *  for: do these lines add up to that number.
 */
export function buildChargeSheets({ cardName, kind, figure, charges, meta = {} }) {
  const rows = [['Date', 'Description', 'Category', 'Account', 'Amount', 'Running total']];
  let running = 0;
  for (const t of charges || []) {
    running += -Number(t.amount);
    rows.push([
      dayKey(t._date),
      t.description || '',
      t.category || '',
      t.account || '',
      round2(-Number(t.amount)),
      round2(running),
    ]);
  }
  rows.push(['', '', '', 'Total', round2(running), '']);

  const summary = [
    ['Card', cardName || ''],
    [kind === 'expected' ? 'Expected payment' : 'Actual payment', round2(figure)],
    ['Charges listed', (charges || []).length],
    ['Charges total', round2(running)],
    ['Ties out', Math.abs(round2(running) - round2(figure)) <= 0.01 ? 'Yes' : 'No'],
  ];
  for (const [k, v] of Object.entries(meta)) {
    if (v != null && v !== '') summary.push([k, v]);
  }

  return [
    { name: 'Summary', rows: summary },
    { name: kind === 'expected' ? 'Expected charges' : 'Actual charges', rows },
  ];
}
