// Market data proxy for the Stock Performance page.
//
// Two modes, both GET:
//   /api/market-data?series=^SP500TR&start=2005-01-01
//     → one symbol's daily closes, as [[epochSeconds, close], …]
//   /api/market-data?quotes=AAPL,MSFT
//     → { quotes: { AAPL: { price, asOf }, … } } — latest close per symbol
//
// This lives server-side purely because Yahoo doesn't send CORS headers; no
// API key is involved. The benchmark symbol is ^SP500TR, the S&P 500 *total
// return* index — it reinvests dividends, which is the honest comparison
// (the price index understates the benchmark by roughly 1.8%/yr). If that
// symbol is unavailable we degrade to the ^GSPC price index and flag
// `totalReturn: false` so the page can say dividends are missing rather than
// quietly making the user look better than they are.

// Yahoo runs two interchangeable hosts; trying both absorbs single-host
// blips and rate limits.
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
// Yahoo 429s requests without a browser-ish UA.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

// ^SP500TR already reinvests dividends; individual equities and ETFs come
// back as Yahoo adjusted closes, which are dividend- and split-adjusted.
// Only bare price indices lack dividends.
const PRICE_ONLY_INDICES = new Set(['^GSPC', '^DJI', '^IXIC', '^RUT']);

async function yahooChart(host, symbol, { period1, period2, interval = '1d' }) {
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?period1=${period1}&period2=${period2}&interval=${interval}`
    + '&includeAdjustedClose=true';
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const json = await res.json().catch(() => null);
  const result = json?.chart?.result?.[0];
  if (!result) {
    const msg = json?.chart?.error?.description || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const stamps = result.timestamp || [];
  // Prefer adjusted close so dividends and splits are already baked in.
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  const raw = result.indicators?.quote?.[0]?.close;
  const closes = Array.isArray(adj) && adj.some(v => v != null) ? adj : raw;
  if (!Array.isArray(closes)) throw new Error('no closes in response');

  const points = [];
  for (let i = 0; i < stamps.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) continue; // holidays / partial rows
    points.push([stamps[i], Number(c.toFixed(4))]);
  }
  if (!points.length) throw new Error('no usable closes');
  return points;
}

// Try the symbol on every host before giving up on it.
async function fetchAcrossHosts(symbol, window) {
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

// ^SP500TR occasionally 404s on Yahoo; ^GSPC is the same index without
// dividend reinvestment, so it's a usable — if pessimistic — stand-in.
const FALLBACK_SYMBOL = { '^SP500TR': '^GSPC' };

async function handleSeries(symbol, startISO) {
  const startMs = Date.parse(`${startISO}T00:00:00Z`);
  const period1 = Math.floor((Number.isFinite(startMs) ? startMs : Date.UTC(2005, 0, 1)) / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const window = { period1, period2 };

  const attempts = [];
  try {
    const points = await fetchAcrossHosts(symbol, window);
    return { symbol, source: 'yahoo', totalReturn: !PRICE_ONLY_INDICES.has(symbol), points };
  } catch (err) {
    attempts.push(...(err.attempts || [err.message]));
  }

  const alt = FALLBACK_SYMBOL[symbol];
  if (alt) {
    try {
      const points = await fetchAcrossHosts(alt, window);
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

async function handleQuotes(symbols) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - 21 * 24 * 60 * 60; // 3 weeks covers any holiday run
  const window = { period1, period2 };

  const entries = await Promise.all(symbols.map(async (symbol) => {
    try {
      const points = await fetchAcrossHosts(symbol, window);
      const [t, price] = points[points.length - 1];
      return [symbol, { price, asOf: new Date(t * 1000).toISOString().slice(0, 10) }];
    } catch (err) {
      // One bad ticker (a delisting, an options contract) shouldn't sink the
      // whole import — the page marks those positions as unpriced.
      return [symbol, { error: err.message }];
    }
  }));

  return Object.fromEntries(entries);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { series, quotes, start } = req.query || {};

  try {
    if (series) {
      const payload = await handleSeries(String(series).toUpperCase(), String(start || '2005-01-01'));
      // Daily closes move once a day; an hour at the CDN with a day of
      // stale-while-revalidate keeps this effectively free.
      res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
      return res.status(200).json(payload);
    }

    if (quotes) {
      const symbols = [...new Set(
        String(quotes).split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
      )].slice(0, 60); // guard against a pathological import
      if (!symbols.length) return res.status(400).json({ error: 'No symbols supplied' });
      const payload = await handleQuotes(symbols);
      res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
      return res.status(200).json({ quotes: payload });
    }

    return res.status(400).json({ error: 'Supply either ?series=SYMBOL or ?quotes=A,B,C' });
  } catch (err) {
    console.error('market-data failed:', err);
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
}
