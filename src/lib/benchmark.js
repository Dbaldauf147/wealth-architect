// Benchmark math over a daily index series.
//
// Everything here is pure and works on the shape returned by
// /api/market-data: `points` as [[epochSeconds, close], …] ascending.
// Dates are handled as UTC throughout — a trade dated 2024-03-14 must resolve
// to the same index level whether the browser is in Denver or Berlin.

export const MS_DAY = 24 * 60 * 60 * 1000;

/** Parse 'YYYY-MM-DD' to a UTC-noon timestamp (noon dodges DST/rounding). */
export function utcDay(iso) {
  const t = Date.parse(`${iso}T12:00:00Z`);
  return Number.isFinite(t) ? t : NaN;
}

/** Format a timestamp back to 'YYYY-MM-DD' in UTC. */
export function toISODate(t) {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Wrap raw points in a lookup structure.
 *
 * `closeAt(t)` returns the last close at or before `t` — the level you could
 * actually have transacted at. Before the series starts it returns null;
 * after it ends it returns the final close (so "held to today" works even if
 * the feed is a day stale).
 */
export function makeSeries(points) {
  const clean = (points || [])
    .filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > 0)
    .map(p => [p[0] * 1000, p[1]])
    .sort((a, b) => a[0] - b[0]);

  const times = new Float64Array(clean.length);
  const closes = new Float64Array(clean.length);
  for (let i = 0; i < clean.length; i++) {
    times[i] = clean[i][0];
    closes[i] = clean[i][1];
  }

  // Largest index whose time is <= t, or -1 when t precedes the series.
  //
  // The non-finite guard is load-bearing: without it a NaN or undefined
  // timestamp fails every `<=` in the search, collapses to index 0, and
  // returns the *first* close in the series as though the position had been
  // held since inception. That reads as a plausible number, so it can't be
  // caught by eye — it has to be refused here.
  function indexAt(t) {
    if (!times.length || !Number.isFinite(t) || t < times[0]) return -1;
    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function closeAt(t) {
    const i = indexAt(t);
    return i === -1 ? null : closes[i];
  }

  return {
    times,
    closes,
    length: times.length,
    firstT: times.length ? times[0] : NaN,
    lastT: times.length ? times[times.length - 1] : NaN,
    firstClose: closes.length ? closes[0] : NaN,
    lastClose: closes.length ? closes[closes.length - 1] : NaN,
    indexAt,
    closeAt,
  };
}

/** Simple (cumulative) return between two dates, or null if unresolvable. */
export function returnBetween(series, fromT, toT) {
  const a = series.closeAt(fromT);
  const b = series.closeAt(toT);
  if (!a || !b) return null;
  return b / a - 1;
}

/** Annualized (compound) return between two dates. */
export function annualized(totalRet, fromT, toT) {
  if (totalRet == null) return null;
  const years = (toT - fromT) / (365.25 * MS_DAY);
  if (years <= 0) return null;
  // Under ~a month, annualizing is arithmetic noise — say nothing instead.
  if (years < 1 / 12) return null;
  return Math.pow(1 + totalRet, 1 / years) - 1;
}

/** Annualized return between two dates, straight from the series. */
export function cagr(series, fromT, toT) {
  return annualized(returnBetween(series, fromT, toT), fromT, toT);
}

/**
 * Calendar-year returns. A year is measured from the last close of the prior
 * year to the last close of the year itself, so the first year in the series
 * (which has no prior close) and the current year (incomplete) are flagged
 * rather than silently presented as full years.
 */
export function calendarYearReturns(series) {
  if (!series.length) return [];
  const lastByYear = new Map();
  for (let i = 0; i < series.length; i++) {
    lastByYear.set(new Date(series.times[i]).getUTCFullYear(), i);
  }
  const years = [...lastByYear.keys()].sort((a, b) => a - b);
  const nowYear = new Date(series.lastT).getUTCFullYear();
  const out = [];
  for (let k = 0; k < years.length; k++) {
    const year = years[k];
    const endIdx = lastByYear.get(year);
    const prevIdx = k === 0 ? null : lastByYear.get(years[k - 1]);
    // Without a prior year-end close we'd be measuring from whenever the
    // series happens to start — not a calendar-year return.
    if (prevIdx == null) { out.push({ year, ret: null, partial: true }); continue; }
    out.push({
      year,
      ret: series.closes[endIdx] / series.closes[prevIdx] - 1,
      partial: year === nowYear,
    });
  }
  return out;
}

/** UTC month-start timestamps from `fromT` through `toT`, inclusive of fromT. */
function monthAnchors(fromT, toT) {
  const out = [fromT];
  const d = new Date(fromT);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  for (;;) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    const t = Date.UTC(y, m, 1, 12, 0, 0);
    if (t > toT) break;
    out.push(t);
  }
  return out;
}

/**
 * Rolling `years`-long windows stepped monthly. Answers "what did a typical
 * N-year hold return", which is a fairer read than any single start date.
 */
export function rollingReturns(series, years) {
  if (!series.length) return null;
  const spanMs = years * 365.25 * MS_DAY;
  const lastStart = series.lastT - spanMs;
  if (lastStart < series.firstT) return null;

  const samples = [];
  for (const startT of monthAnchors(series.firstT, lastStart)) {
    const endT = startT + spanMs;
    const ret = returnBetween(series, startT, endT);
    if (ret == null) continue;
    samples.push({ startT, endT, ret, annual: Math.pow(1 + ret, 1 / years) - 1 });
  }
  if (!samples.length) return null;

  const annuals = samples.map(s => s.annual).sort((a, b) => a - b);
  const best = samples.reduce((a, b) => (b.annual > a.annual ? b : a));
  const worst = samples.reduce((a, b) => (b.annual < a.annual ? b : a));
  const mid = annuals.length >> 1;

  return {
    years,
    count: samples.length,
    avg: annuals.reduce((s, v) => s + v, 0) / annuals.length,
    median: annuals.length % 2 ? annuals[mid] : (annuals[mid - 1] + annuals[mid]) / 2,
    best,
    worst,
    positivePct: samples.filter(s => s.ret > 0).length / samples.length,
  };
}

/**
 * Simulate investing in the index: `initial` up front at `fromT`, then
 * `monthly` on the 1st of every following month (or the next trading day).
 * Returns one sample per month so the result charts directly.
 */
export function growthPath(series, { initial = 0, monthly = 0, fromT, toT }) {
  if (!series.length) return [];
  const start = Math.max(fromT, series.firstT);
  const end = Math.min(toT, series.lastT);
  if (!(end > start)) return [];

  let units = 0;
  let contributed = 0;
  const path = [];

  for (const t of monthAnchors(start, end)) {
    const close = series.closeAt(t);
    if (!close) continue;
    const cash = t === start ? initial : monthly;
    if (cash > 0) {
      units += cash / close;
      contributed += cash;
    }
    path.push({ t, value: units * close, contributed });
  }

  // Close out on the final observation so the headline number is current.
  if (path.length && path[path.length - 1].t < end) {
    path.push({ t: end, value: units * series.closeAt(end), contributed });
  }
  return path;
}

/** Deepest peak-to-trough decline in the series, on closing values. */
export function maxDrawdown(series) {
  if (!series.length) return null;
  let peak = series.closes[0];
  let peakT = series.times[0];
  let worst = 0;
  let worstPeakT = peakT;
  let worstTroughT = peakT;
  for (let i = 1; i < series.length; i++) {
    const c = series.closes[i];
    if (c > peak) { peak = c; peakT = series.times[i]; continue; }
    const dd = c / peak - 1;
    if (dd < worst) { worst = dd; worstPeakT = peakT; worstTroughT = series.times[i]; }
  }
  return { drawdown: worst, peakT: worstPeakT, troughT: worstTroughT };
}

/**
 * Money-weighted annualized return (XIRR) for dated cash flows.
 * `flows` is [{ t, amount }] with negatives for money in, positives for money
 * out (including a final positive flow for the ending market value).
 *
 * Solved by bisection rather than Newton — slower but it cannot diverge on
 * the irregular, sign-flipping flows a real trade log produces.
 */
export function xirr(flows) {
  const rows = (flows || []).filter(f => Number.isFinite(f.t) && Number.isFinite(f.amount) && f.amount !== 0);
  if (rows.length < 2) return null;
  if (!rows.some(f => f.amount < 0) || !rows.some(f => f.amount > 0)) return null;

  const t0 = Math.min(...rows.map(f => f.t));
  const npv = (rate) => rows.reduce((sum, f) => {
    const years = (f.t - t0) / (365.25 * MS_DAY);
    return sum + f.amount / Math.pow(1 + rate, years);
  }, 0);

  // -99.9% to +1000%/yr brackets any plausible result; outside it we'd be
  // reporting a number no one should act on.
  let lo = -0.999;
  let hi = 10;
  let fLo = npv(lo);
  let fHi = npv(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (!Number.isFinite(fMid)) return null;
    if (Math.abs(fMid) < 1e-7 || hi - lo < 1e-9) return mid;
    if (fLo * fMid <= 0) { hi = mid; fHi = fMid; }
    else { lo = mid; fLo = fMid; }
  }
  return (lo + hi) / 2;
}
