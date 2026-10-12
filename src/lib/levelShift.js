// Spotting a category whose spend has stepped up to a new, higher level that
// the Trends comparison has already swallowed into its baseline.
//
// The Trends page measures a recent window against the window just before it.
// That catches a rise while it is happening, but once the higher level has run
// long enough to reach into the baseline window too, both sides of the
// comparison sit at the new level and the rise stops being flagged. A new
// subscription reads as "new" for a few months and then as flat; rent that went
// up in the spring reads as normal by summer. Nothing has gone back down: the
// baseline has simply moved up to meet it.
//
// This looks for that step in each category's monthly series and reports it
// only when the step month falls inside or before the baseline window — the
// case the comparison can no longer see.

// A step has to clear the same bar the page uses for a flag.
export const STEP_MIN_ABS = 50;
export const STEP_MIN_PCT = 0.25;
// The new level must have held for at least this many months, and the old one
// must have been seen for at least this many before it.
export const MIN_POST = 3;
export const MIN_PRE = 3;
// How far back of the step to read the old level.
export const PRE_LOOKBACK = 12;
// Only steps this recent are "new". Older than this and the higher level is
// just how the category has been for a year.
export const MAX_AGE = 12;
// Share of the months since the step that must sit nearer the new level than
// the old one. Leaves room for one soft month (often the current, partial one).
export const SUSTAINED_SHARE = 2 / 3;

const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;

/**
 * Find the most pronounced lasting step up in a monthly series.
 *
 * @param {number[]} series  monthly spend, oldest first, ending at the latest month
 * @returns {{ index: number, before: number, after: number } | null}
 *   `index` is the first month at the new level; `before` and `after` are the
 *   average monthly spend either side of it.
 */
export function findStepUp(series) {
  const n = series.length;
  let best = null;
  for (let s = Math.max(MIN_PRE, n - MAX_AGE); s <= n - MIN_POST; s++) {
    const pre = series.slice(Math.max(0, s - PRE_LOOKBACK), s);
    const post = series.slice(s);
    const before = mean(pre);
    const after = mean(post);
    const rise = after - before;
    if (rise < STEP_MIN_ABS) continue;
    if (before > 0 && rise / before < STEP_MIN_PCT) continue;
    // A single big month after an ordinary run lifts the average without
    // being a new level; insist most months since the step are up there.
    const mid = before + rise / 2;
    const high = post.filter(v => v >= mid).length;
    if (high / post.length < SUSTAINED_SHARE) continue;
    // The step should land exactly at `s`: up there from that month, and not
    // already up there the month before (or it began earlier — possibly
    // before the window we look at).
    if (series[s] < mid || series[s - 1] >= mid) continue;
    if (!best || rise > best.after - best.before) best = { index: s, before, after };
  }
  return best;
}

/**
 * The step up, if any, that the baseline window has absorbed.
 *
 * @param {number[]} series      monthly spend, oldest first, ending at the latest month
 * @param {number}   recentLen   months in the recent window
 * @param {number}   baselineLen months in the baseline window
 * @returns {{ index: number, before: number, after: number, isNew: boolean, monthsInBaseline: number } | null}
 */
export function absorbedStepUp(series, recentLen, baselineLen) {
  const step = findStepUp(series);
  if (!step) return null;
  const n = series.length;
  const baselineStart = n - recentLen - baselineLen;
  const baselineEnd = n - recentLen; // exclusive
  // A step inside the recent window is still visible as a rise; only one at
  // or before the end of the baseline has been folded into it.
  if (step.index >= baselineEnd) return null;
  const monthsInBaseline = baselineEnd - Math.max(step.index, baselineStart);
  // "New" when there was effectively nothing being spent here before.
  const isNew = step.before < STEP_MIN_ABS / 5;
  return { ...step, isNew, monthsInBaseline };
}
