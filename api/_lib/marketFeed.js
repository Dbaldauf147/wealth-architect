// Yahoo price access, shared by the /api/market-data route and the daily
// portfolio snapshot cron. Kept separate so the two can never drift into
// pricing the same position differently.

// Yahoo runs two interchangeable hosts; trying both absorbs single-host
// blips and rate limits.
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
// Yahoo 429s requests without a browser-ish UA.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

// ^SP500TR already reinvests dividends; individual equities and ETFs come
// back as Yahoo adjusted closes, which are dividend- and split-adjusted.
// Only bare price indices lack dividends.
export const PRICE_ONLY_INDICES = new Set(['^GSPC', '^DJI', '^IXIC', '^RUT']);

// ^SP500TR occasionally 404s on Yahoo; ^GSPC is the same index without
// dividend reinvestment, so it's a usable — if pessimistic — stand-in.
export const FALLBACK_SYMBOL = { '^SP500TR': '^GSPC' };

async function yahooChart(host, symbol, { period1, period2, interval = '1d', events = '' }) {
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?period1=${period1}&period2=${period2}&interval=${interval}`
    + '&includeAdjustedClose=true'
    + (events ? `&events=${encodeURIComponent(events)}` : '');
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const json = await res.json().catch(() => null);
  const result = json?.chart?.result?.[0];
  if (!result) {
    const msg = json?.chart?.error?.description || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const stamps = result.timestamp || [];
  // Adjusted close has dividends and splits baked in; raw close does not.
  // Both are needed: benchmark growth wants total return, while rebuilding a
  // position's market value wants the price actually quoted, with dividends
  // accounted for separately as the cash they were paid out as.
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  const raw = result.indicators?.quote?.[0]?.close;
  const closes = Array.isArray(adj) && adj.some(v => v != null) ? adj : raw;
  if (!Array.isArray(closes)) throw new Error('no closes in response');

  const points = [];
  const rawPoints = [];
  for (let i = 0; i < stamps.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) continue; // holidays / partial rows
    points.push([stamps[i], Number(c.toFixed(4))]);
    const r = Array.isArray(raw) ? raw[i] : null;
    if (r != null && Number.isFinite(r)) rawPoints.push([stamps[i], Number(r.toFixed(4))]);
  }
  if (!points.length) throw new Error('no usable closes');

  // Split events, oldest first. A holder's share count multiplies by
  // numerator/denominator on the split date, so a 6:1 turns 10 shares into 60.
  const splits = Object.values(result.events?.splits || {})
    .map(s => ({
      date: new Date(s.date * 1000).toISOString().slice(0, 10),
      ratio: s.denominator ? s.numerator / s.denominator : null,
    }))
    .filter(s => Number.isFinite(s.ratio) && s.ratio > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    points,
    rawPoints,
    splits,
    marketPrice: result.meta?.regularMarketPrice ?? null,
    // On monthly candles the last timestamp is the *start* of the current
    // month, which would label a live price as weeks old.
    marketTime: result.meta?.regularMarketTime ?? null,
  };
}

/** Try the symbol on every host before giving up on it. */
export async function fetchAcrossHosts(symbol, window) {
  const errors = [];
  for (const host of YAHOO_HOSTS) {
    try {
      return await yahooChart(host, symbol, window);
    } catch (err) {
      errors.push(`${symbol}@${host}: ${err.message}`);
    }
  }
  const err = new Error(errors.join('; '));
  err.attempts = errors;
  throw err;
}

/** Daily closes for one symbol, with the price-index fallback. */
export async function getSeries(symbol, startISO) {
  const startMs = Date.parse(`${startISO}T00:00:00Z`);
  const period1 = Math.floor((Number.isFinite(startMs) ? startMs : Date.UTC(2005, 0, 1)) / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const window = { period1, period2 };

  const attempts = [];
  try {
    const { points } = await fetchAcrossHosts(symbol, window);
    return { symbol, source: 'yahoo', totalReturn: !PRICE_ONLY_INDICES.has(symbol), points };
  } catch (err) {
    attempts.push(...(err.attempts || [err.message]));
  }

  const alt = FALLBACK_SYMBOL[symbol];
  if (alt) {
    try {
      const { points } = await fetchAcrossHosts(alt, window);
      return {
        symbol,
        resolvedSymbol: alt,
        source: 'yahoo',
        totalReturn: !PRICE_ONLY_INDICES.has(alt),
        warning: `${symbol} was unavailable — showing the ${alt} price index instead, which excludes dividends and so understates the benchmark by roughly 1.8%/yr.`,
        points,
      };
    } catch (err) {
      attempts.push(...(err.attempts || [err.message]));
    }
  }

  const error = new Error(`Could not load ${symbol} — ${attempts.join('; ')}`);
  error.statusCode = 502;
  throw error;
}

/**
 * Latest price, split history and monthly closes per symbol.
 *
 * Splits have to come from here rather than a broker file: one that happens
 * after an export's end date is invisible to the file and silently multiplies
 * the share count. Monthly candles keep the payload small while still carrying
 * every split event in the range.
 */
export async function getQuotes(symbols, sinceISO) {
  const sinceMs = Date.parse(`${sinceISO}T00:00:00Z`);
  const period1 = Math.floor((Number.isFinite(sinceMs) ? sinceMs : Date.UTC(2015, 0, 1)) / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const window = { period1, period2, interval: '1mo', events: 'split' };

  const entries = await Promise.all(symbols.map(async (symbol) => {
    try {
      const { points, rawPoints, splits, marketPrice, marketTime } = await fetchAcrossHosts(symbol, window);
      const [candleT, lastClose] = points[points.length - 1];
      // The last monthly candle is the current partial month, so its close is
      // today's price; regularMarketPrice is preferred when present.
      const price = Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : lastClose;
      const asOfT = Number.isFinite(marketTime) ? marketTime : candleT;
      return [symbol, {
        price: Number(price.toFixed(4)),
        asOf: new Date(asOfT * 1000).toISOString().slice(0, 10),
        splits,
        // Monthly quoted closes, so a position's market value can be rebuilt
        // through time. Raw rather than adjusted: dividends are tracked as the
        // cash they were actually paid out as, and counting them here too
        // would double them.
        points: rawPoints.length ? rawPoints : points,
      }];
    } catch (err) {
      // One bad ticker (a delisting, an options contract) shouldn't sink the
      // whole request — callers mark those positions as unpriced.
      return [symbol, { error: err.message }];
    }
  }));

  return Object.fromEntries(entries);
}
