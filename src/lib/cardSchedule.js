/* Per-card payment schedule — projects each card's next CC payment date and
   surfaces the charges since the last payment that will roll into it.

   Approximation v1: we don't have statement-close events, only payment events.
   Treats "charges since last payment" as "charges in the next payment." Off by
   a few days for users who don't pay in full, accurate enough for users who do. */

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function isCreditCardPayment(t) {
  const cat = (t.category || '').toLowerCase();
  return cat === 'credit card payment' || cat === 'credit card payments';
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ordinalLabel(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function recurrenceLabel(pattern) {
  if (pattern.type === 'dom') {
    return `${pattern.exact ? 'the' : 'around the'} ${ordinalLabel(pattern.dom)} of the month`;
  }
  const ord = pattern.isLast ? 'last' : ordinalLabel(pattern.ordinal);
  return `${ord} ${WEEKDAYS[pattern.weekday]} of the month`;
}

/** Detect the monthly recurrence pattern of a card's payment dates. Returns
 *  `{ pattern, label }` or null when there's too little history or no
 *  consistent pattern, in which case the day-based cadence is the best we can
 *  say. The `label` is plain English ("2nd Monday of the month", "the 15th of
 *  the month"); the `pattern` drives the exact next-date projection.
 *
 *  Two candidate patterns are scored against the recent payments:
 *   • weekday-ordinal — same weekday in the same position (autopay on the
 *     "2nd Monday" lands on a different day-of-month each month but a fixed
 *     weekday position);
 *   • day-of-month — same calendar day, tolerating ±2 days of weekend/holiday
 *     drift (a "15th" autopay may post on the 16th or 17th).
 *  Whichever fits a clear majority of payments wins. */
function detectRecurrence(payments) {
  if (!payments || payments.length < 3) return null;

  // Look at the most recent payments so a changed schedule wins over old history.
  const recent = payments.slice(-6).map((p) => {
    const d = p.date;
    const dom = d.getDate();
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return {
      dom,
      weekday: d.getDay(),
      ordinal: Math.floor((dom - 1) / 7) + 1,
      isLast: dom + 7 > daysInMonth,
    };
  });
  const n = recent.length;

  // ── Weekday-ordinal pattern (e.g. "2nd Monday", "last Friday") ──
  const owCounts = new Map();
  for (const r of recent) {
    const key = `${r.weekday}|${r.isLast ? 'last' : r.ordinal}`;
    owCounts.set(key, (owCounts.get(key) || 0) + 1);
  }
  let owBest = null;
  let owBestCount = 0;
  for (const [key, count] of owCounts) {
    if (count > owBestCount) {
      owBestCount = count;
      owBest = key;
    }
  }
  const owScore = owBestCount / n;

  // ── Day-of-month pattern (e.g. "the 15th"), ±2 days of drift around the median ──
  const sortedDoms = recent.map((r) => r.dom).sort((a, b) => a - b);
  const medianDom = sortedDoms[Math.floor(n / 2)];
  const domMatches = recent.filter((r) => Math.abs(r.dom - medianDom) <= 2).length;
  const domScore = domMatches / n;

  const MIN_SCORE = 0.6; // a clear majority of payments must agree
  let pattern = null;
  if (owScore >= domScore && owScore >= MIN_SCORE) {
    const [weekday, pos] = owBest.split('|');
    pattern = {
      type: 'wday',
      weekday: Number(weekday),
      isLast: pos === 'last',
      ordinal: pos === 'last' ? null : Number(pos),
    };
  } else if (domScore >= MIN_SCORE) {
    // "the 15th" only when every recent payment is exactly that day; otherwise
    // "around the 15th" to signal the weekend/holiday drift we're tolerating.
    const exact = recent.every((r) => r.dom === medianDom);
    pattern = { type: 'dom', dom: medianDom, exact };
  }
  return pattern ? { pattern, label: recurrenceLabel(pattern) } : null;
}

/** The calendar date a recurrence pattern resolves to within a given month, or
 *  null when that month has no such occurrence (e.g. no 5th Monday). */
function occurrenceInMonth(pattern, year, month) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  if (pattern.type === 'dom') {
    // Clamp to the month's length so a "31st" pattern still lands in February.
    return new Date(year, month, Math.min(pattern.dom, daysInMonth));
  }
  if (pattern.isLast) {
    const lastDow = new Date(year, month, daysInMonth).getDay();
    const back = (lastDow - pattern.weekday + 7) % 7;
    return new Date(year, month, daysInMonth - back);
  }
  const firstDow = new Date(year, month, 1).getDay();
  const offset = (pattern.weekday - firstDow + 7) % 7;
  const day = 1 + offset + (pattern.ordinal - 1) * 7;
  return day > daysInMonth ? null : new Date(year, month, day);
}

/** Project the next payment date from a recurrence pattern: the earliest
 *  occurrence that falls strictly after the last payment and on or after
 *  `asOf`. Walks forward month by month (capped at 15 months as a safety net
 *  for patterns like a 5th-weekday that some months skip). */
function projectNextFromPattern(pattern, after, asOf) {
  const lowerBoundMs = Math.max(after.getTime(), asOf.getTime());
  const lb = new Date(lowerBoundMs);
  let year = lb.getFullYear();
  let month = lb.getMonth();
  for (let i = 0; i < 15; i++) {
    const d = occurrenceInMonth(pattern, year, month);
    if (d && d.getTime() > after.getTime() && d.getTime() >= asOf.getTime()) return d;
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return null;
}

/** Build per-card schedule entries.
 *
 *  cards: [{ name, color? }]
 *  transactions: full transaction list (the same shape produced by sheets.js)
 *  asOf: defaults to now
 *
 *  Returns one entry per card with the next projected payment, the charges
 *  feeding into it, and supporting metadata for the UI. */
export function buildCardSchedule({ cards, transactions, asOf = new Date() }) {
  // Midnight of `asOf` — recurrence occurrences are date-only (midnight), so
  // comparing against the start of today keeps a payment due today in play.
  const asOfMid = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());

  const txByCard = new Map();
  for (const t of transactions || []) {
    const acct = (t.account || '').trim();
    if (!acct) continue;
    if (!txByCard.has(acct)) txByCard.set(acct, []);
    txByCard.get(acct).push(t);
  }

  return (cards || []).map((card) => {
    const txs = txByCard.get(card.name) || [];

    // Payment events for this card: positive-amount CC-payment transactions on
    // the card account (the inflow leg of the transfer that pays the card down).
    const payments = txs
      .filter(t => isCreditCardPayment(t) && t.amount > 0)
      .map(t => ({ date: parseDate(t.date), amount: t.amount }))
      .filter(p => p.date)
      .sort((a, b) => a.date - b.date);

    const lastPayment = payments.length ? payments[payments.length - 1] : null;

    // Cadence in days — average gap between historical payments, default 30.
    let cadenceDays = 30;
    if (payments.length >= 2) {
      const totalDays = (payments[payments.length - 1].date - payments[0].date) / 86400000;
      cadenceDays = Math.max(1, Math.round(totalDays / (payments.length - 1)));
    }

    // Detect the recurrence pattern (e.g. "2nd Monday of the month") from the
    // payment history. When found, it projects the next date exactly; otherwise
    // we fall back to rolling the day-based cadence forward to on/after asOf.
    const recurrence = detectRecurrence(payments);

    let nextPaymentDate = null;
    if (lastPayment) {
      if (recurrence) {
        nextPaymentDate = projectNextFromPattern(recurrence.pattern, lastPayment.date, asOfMid);
      }
      if (!nextPaymentDate) {
        const intervalMs = cadenceDays * 86400000;
        nextPaymentDate = new Date(lastPayment.date.getTime() + intervalMs);
        while (nextPaymentDate < asOf) {
          nextPaymentDate = new Date(nextPaymentDate.getTime() + intervalMs);
        }
      }
    }

    const daysUntilNext = nextPaymentDate
      ? Math.max(0, Math.round((nextPaymentDate - asOf) / 86400000))
      : null;

    // Charges (and refunds) on the card since the last payment, newest first.
    // Excludes the CC-payment transactions themselves.
    const sinceDate = lastPayment ? lastPayment.date : null;
    const chargesSinceLast = txs
      .filter(t => {
        if (isCreditCardPayment(t)) return false;
        const d = parseDate(t.date);
        if (!d) return false;
        if (sinceDate && d <= sinceDate) return false;
        if (d > asOf) return false;
        return true;
      })
      .map(t => ({ ...t, _date: parseDate(t.date) }))
      .sort((a, b) => b._date - a._date);

    // Sum the charges. Charges are negative; refunds are positive. Flipping the
    // sign gives the net amount that'll be owed on the next payment.
    const estimatedNextAmount = chargesSinceLast.reduce((s, t) => s + -t.amount, 0);

    return {
      card: card.name,
      color: card.color || null,
      payments,
      lastPayment,
      cadenceDays,
      recurrence: recurrence ? recurrence.label : null,
      nextPaymentDate,
      daysUntilNext,
      chargesSinceLast,
      estimatedNextAmount,
    };
  });
}
