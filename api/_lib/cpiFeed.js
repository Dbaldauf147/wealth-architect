// Consumer price data for the Stock Performance page's inflation comparison.
//
// CPI-U, US city average, all items, not seasonally adjusted — series
// CUUR0000SA0, the headline number the press calls "inflation" and the one the
// IRS indexes brackets against. Not seasonally adjusted on purpose: the
// question here is "what did a dollar from March 2019 buy", and the seasonal
// adjustment exists to smooth month-to-month noise for forecasters, not to
// restate the price level.
//
// The BLS public API v1 needs no key. It caps a request at ten years and
// twenty-five queries per day per IP, so the range is chunked and the route in
// front of this caches hard — a whole day of visits should cost three calls.

const BLS_URL = 'https://api.bls.gov/publicAPI/v1/timeseries/data/';
const SERIES_ID = 'CUUR0000SA0';
const MAX_SPAN_YEARS = 10;

/** One ten-year window. Returns [{ year, month, value }] unsorted. */
async function fetchWindow(startYear, endYear) {
  const res = await fetch(BLS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seriesid: [SERIES_ID],
      startyear: String(startYear),
      endyear: String(endYear),
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.status !== 'REQUEST_SUCCEEDED') {
    const detail = json?.message?.join('; ') || `HTTP ${res.status}`;
    throw new Error(`BLS ${startYear}–${endYear}: ${detail}`);
  }

  const rows = json?.Results?.series?.[0]?.data;
  if (!Array.isArray(rows)) throw new Error(`BLS ${startYear}–${endYear}: no series in response`);

  const out = [];
  for (const row of rows) {
    // M13 is the annual average, not a month; and a government shutdown can
    // leave a real month published as "-" with an explanatory footnote.
    if (!/^M(0[1-9]|1[0-2])$/.test(row.period || '')) continue;
    const value = Number(row.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push({
      year: Number(row.year),
      month: Number(row.period.slice(1)),
      value,
    });
  }
  return out;
}

/**
 * Monthly CPI from `startYear` to now, as [[epochSeconds, index], …] ascending.
 *
 * Each month is stamped at its own first instant so that a lookup of "the last
 * reading at or before this date" resolves a mid-March purchase to March's
 * price level rather than February's.
 */
export async function getCpi(startYear = 2000) {
  const thisYear = new Date().getUTCFullYear();
  const from = Math.min(Math.max(Number(startYear) || 2000, 1913), thisYear);

  const windows = [];
  for (let y = from; y <= thisYear; y += MAX_SPAN_YEARS) {
    windows.push([y, Math.min(y + MAX_SPAN_YEARS - 1, thisYear)]);
  }

  const chunks = await Promise.all(windows.map(([a, b]) => fetchWindow(a, b)));

  const byKey = new Map();
  for (const chunk of chunks) {
    for (const row of chunk) byKey.set(row.year * 100 + row.month, row);
  }

  const rows = [...byKey.values()].sort((a, b) => (a.year - b.year) || (a.month - b.month));
  if (!rows.length) {
    const err = new Error('BLS returned no usable CPI readings');
    err.statusCode = 502;
    throw err;
  }

  const points = rows.map(r => [
    Math.floor(Date.UTC(r.year, r.month - 1, 1) / 1000),
    Number(r.value.toFixed(3)),
  ]);
  const last = rows[rows.length - 1];

  // Months the BLS has not published (or could not, during the 2025 funding
  // lapse) simply aren't in the series. Say how many so the page can tell the
  // user its index is interpolated across a hole rather than silently smoothing.
  const expected = (last.year * 12 + last.month) - (rows[0].year * 12 + rows[0].month) + 1;

  return {
    series: SERIES_ID,
    source: 'bls',
    label: 'CPI-U, all items, US city average (NSA)',
    latest: { year: last.year, month: last.month, value: last.value },
    missingMonths: Math.max(0, expected - rows.length),
    points,
  };
}
