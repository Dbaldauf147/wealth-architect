// The Normal Range Tracker's definition of "normal", in one place.
//
// It used to compare the *calendar month so far* against the average of the
// three prior calendar months. That reads wrong for most of the month: on the
// 3rd you have three days of spending measured against thirty, so nearly
// everything shows as "under" until the month is nearly over, and the reading
// only becomes meaningful in the last few days.
//
// Now every window is a rolling 30 days. The current window is the last 30
// days, the baseline is the three 30-day windows before it, and none of them
// overlap — which matters, because simply swapping the current figure for a
// rolling one while leaving calendar-month baselines would have measured the
// last 30 days against a baseline that contained most of the same spending.
//
// Equal-length windows also remove the February-versus-January distortion the
// calendar version had built in.

export const WINDOW_DAYS = 30;
export const BASELINE_WINDOWS = 3;
export const CHART_WINDOWS = 6;

const MS_DAY = 24 * 60 * 60 * 1000;

/**
 * Read a value as the calendar day it names.
 *
 * 'YYYY-MM-DD' has to be built field by field: `new Date('2026-07-05')` parses
 * as UTC midnight, which in any timezone behind UTC reads back as the 4th and
 * pushes every transaction one day earlier — enough to drop a day off each
 * window and to move rows across window boundaries.
 */
function parseLocalDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value ?? '').trim();
  if (!s) return null;
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A date as a plain day count, so windows are measured in calendar days.
 *
 * Subtracting local timestamps and dividing by 86,400,000 looks equivalent but
 * isn't: a day containing a clock change is 23 or 25 hours, so the division
 * rounds the wrong way and a window straddling one comes out 29 or 31 days
 * long. Projecting the local Y/M/D through Date.UTC strips the offset, leaving
 * arithmetic that can't drift.
 */
function dayNumber(d) {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_DAY);
}

function dateFromDayNumber(n) {
  const utc = new Date(n * MS_DAY);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

/**
 * Which rolling window a date falls into, counting back from `asOf`.
 * 0 is the current window (the last `WINDOW_DAYS` days), 1 the one before it,
 * and so on. Returns null for anything older than `count` windows.
 */
export function windowIndexFor(date, asOf, count, windowDays = WINDOW_DAYS) {
  const d = parseLocalDate(date);
  if (!d) return null;
  const daysAgo = dayNumber(asOf) - dayNumber(d);
  // A future-dated row (a pending charge posted ahead) belongs to now.
  if (daysAgo < 0) return 0;
  const index = Math.floor(daysAgo / windowDays);
  return index < count ? index : null;
}

/**
 * Window descriptors, oldest first, so a chart can plot them left to right.
 * `isCurrent` marks the newest.
 */
export function rangeWindows(asOf = new Date(), count = CHART_WINDOWS, windowDays = WINDOW_DAYS) {
  const endDay = dayNumber(asOf);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const lastDay = endDay - i * windowDays;
    const firstDay = lastDay - (windowDays - 1);
    const end = dateFromDayNumber(lastDay);
    out.push({
      index: i,
      isCurrent: i === 0,
      startT: dateFromDayNumber(firstDay).getTime(),
      endT: end.getTime(),
      // Labelled by where the window ends, which is what a reader anchors on.
      label: end.toLocaleString('en-US', { month: 'short', day: 'numeric' }),
    });
  }
  return out;
}

/**
 * Total expense per rolling window for each key.
 *
 * `keyFor` returns the grouping key (a category, or a category+subcategory),
 * or null to skip the row. Income and refunds are excluded: this measures
 * spending, and a refund landing in one window would otherwise drag it below
 * range for reasons that have nothing to do with how much was spent.
 */
export function spendByWindow(transactions, { asOf = new Date(), count = CHART_WINDOWS, keyFor }) {
  const buckets = new Map();
  for (const t of transactions || []) {
    const amount = Number(t?.amount) || 0;
    if (amount >= 0) continue;
    if (!t.date) continue;
    const key = keyFor(t);
    if (key == null) continue;
    const index = windowIndexFor(t.date, asOf, count);
    if (index == null) continue;
    if (!buckets.has(key)) buckets.set(key, new Array(count).fill(0));
    buckets.get(key)[index] += Math.abs(amount);
  }
  return buckets;
}

/**
 * Turn one key's per-window totals into the range band and a verdict.
 *
 * `values[0]` is the current window. The baseline averages only windows that
 * had spend, so a category bought quarterly isn't judged against zeros it was
 * never going to fill.
 */
export function bandsFor(values, { baselineWindows = BASELINE_WINDOWS, tolerance = 0.25 } = {}) {
  const list = values || [];
  const current = list[0] || 0;
  const baseline = list.slice(1, 1 + baselineWindows).filter(v => v > 0);
  const avg = baseline.length ? baseline.reduce((s, v) => s + v, 0) / baseline.length : 0;
  const low = avg * (1 - tolerance);
  const high = avg * (1 + tolerance);

  let status = 'normal';
  if (avg === 0) status = 'no-data';
  else if (current === 0) status = 'no-spend';
  else if (current > high) status = 'over';
  else if (current < low) status = 'under';

  return { avg, low, high, current, baselineWindows: baseline.length, status };
}

/** Per-window totals paired with their descriptors, oldest first. */
export function seriesFor(values, windows) {
  return windows.map(w => ({
    label: w.label,
    isCurrent: w.isCurrent,
    value: (values || [])[w.index] || 0,
  }));
}

/** How the current window is described wherever this appears. */
export const WINDOW_LABEL = 'last 30 days';
export const BASELINE_LABEL = 'previous three 30-day periods';
