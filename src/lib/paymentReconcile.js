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
*/

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

/** Walk each payment in turn and find the run of charges that sums to it.
 *
 *  Windows chain: statement periods are contiguous and don't overlap, so each
 *  payment's window starts where the previous one ended. That's also what makes
 *  the result explanatory — if one payment's window reaches back further than
 *  the estimate's did, the charges it swept up are visible.
 *
 *  A window may only end on a day boundary, because a statement does. Without
 *  that, a run could stop halfway through a day and "reconcile" on a total no
 *  statement could ever have shown.
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

    let running = 0;
    let matchEnd = -1;
    let closeDate = null;
    for (let i = 0; i < candidates.length; i++) {
      running += -Number(candidates[i].amount);
      const lastOfDay = i === candidates.length - 1
        || dayKey(candidates[i + 1]._date) !== dayKey(candidates[i]._date);
      if (lastOfDay && Math.abs(round2(running) - target) <= tolerance) {
        matchEnd = i;
        closeDate = candidates[i]._date;
        break;
      }
    }

    if (matchEnd >= 0) {
      const window = candidates.slice(0, matchEnd + 1);
      out.push({
        payment,
        charges: window,
        total: owedFor(window),
        matched: true,
        closeDate,
      });
      cursor += matchEnd + 1;
    } else {
      out.push({
        payment,
        charges: candidates,
        total: owedFor(candidates),
        matched: false,
        closeDate: null,
      });
      cursor = scan;
    }
  }

  return out;
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
export function comparePaymentForCard({ transactions, recorded = null, tolerance = 0.01 }) {
  const payments = paymentsOf(transactions);
  const charges = chargesOf(transactions);
  if (payments.length === 0) {
    return { actual: null, expected: null, variance: null, reconciliation: [] };
  }

  const reconciliation = reconcilePayments({ payments, charges, tolerance });
  const last = reconciliation[reconciliation.length - 1];
  const prevPayment = payments.length > 1 ? payments[payments.length - 2] : null;

  const actual = {
    date: last.payment._date,
    amount: round2(last.payment.amount),
    charges: last.charges,
    total: last.total,
    matched: last.matched,
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
