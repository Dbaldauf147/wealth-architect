/* Statement close-date arithmetic for a card that closes on day `day` of
   every month. Shared by statementWindows.js (which estimates the day and
   places transactions) and paymentReconcile.js (which explains payments), so
   both agree on what "the statement this payment paid" means.

   Pure, local-calendar dates throughout. */

// A statement is paid at least this many days after it closes (US law gives
// 21; autopay usually runs on the due date). Used to tell which close a
// payment was for.
export const MIN_CLOSE_TO_PAY_DAYS = 20;

/** Day `day` of the month (y, m), clamped so the 31st is the 30th in April. */
function closeIn(y, m, day) {
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, last));
}

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The first close on or after `date`. */
export function closeOnOrAfter(date, day) {
  const d = startOfDay(date);
  const here = closeIn(d.getFullYear(), d.getMonth(), day);
  return here >= d ? here : closeIn(d.getFullYear(), d.getMonth() + 1, day);
}

/** The close before `close`. */
export function previousClose(close, day) {
  return closeIn(close.getFullYear(), close.getMonth() - 1, day);
}

/** The close a payment on `date` was paying: the latest one at least
 *  MIN_CLOSE_TO_PAY_DAYS before it. */
export function closePaidBy(date, day) {
  const limit = startOfDay(date);
  limit.setDate(limit.getDate() - MIN_CLOSE_TO_PAY_DAYS);
  const here = closeIn(limit.getFullYear(), limit.getMonth(), day);
  return here <= limit ? here : closeIn(limit.getFullYear(), limit.getMonth() - 1, day);
}

/** The statement a payment on `date` paid: `{ openDate, closeDate }`, where
 *  openDate is the day after the previous close. Charges dated on either day
 *  inclusive belong to it. */
export function cyclePaidBy(date, day) {
  const closeDate = closePaidBy(date, day);
  const prev = previousClose(closeDate, day);
  return { openDate: new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + 1), closeDate };
}
