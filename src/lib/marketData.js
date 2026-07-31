// Client access to /api/market-data, with the same stale-while-revalidate
// shape the sheet data uses: hand back whatever is on disk immediately, then
// refresh in the background. A 20-year daily series is ~120KB of JSON, so
// re-fetching it on every page visit would be the slowest thing on the tab.

const SERIES_CACHE_PREFIX = 'marketSeries:v1:';
const QUOTE_CACHE_KEY = 'marketQuotes:v1';
const SERIES_TTL_MS = 12 * 60 * 60 * 1000; // closes settle once a day
const QUOTE_TTL_MS = 30 * 60 * 1000;

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch { return null; }
}

function writeCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* quota — the cache is an optimization, not a requirement */ }
}

/**
 * Daily closes for one symbol.
 *
 * Returns { payload, stale } where `payload` is the API response shape
 * ({ symbol, source, totalReturn, points, warning? }). When a cached copy
 * exists it is returned immediately with `stale: true` if past its TTL, and
 * `onFresh` fires later with the refreshed payload.
 */
export async function fetchSeries(symbol, start, { onFresh } = {}) {
  const key = `${SERIES_CACHE_PREFIX}${symbol}:${start}`;
  const cached = readCache(key);
  const age = cached?.fetchedAt ? Date.now() - cached.fetchedAt : Infinity;

  const refresh = async () => {
    const url = `/api/market-data?series=${encodeURIComponent(symbol)}&start=${encodeURIComponent(start)}`;
    const res = await fetch(url);
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error || `Market data request failed (${res.status})`);
    if (!Array.isArray(json?.points) || !json.points.length) {
      throw new Error(`No price history returned for ${symbol}`);
    }
    writeCache(key, { fetchedAt: Date.now(), payload: json });
    return json;
  };

  if (cached?.payload && age < SERIES_TTL_MS) {
    return { payload: cached.payload, stale: false };
  }

  if (cached?.payload) {
    // Serve the stale copy now, reconcile in the background. A failed
    // background refresh is not worth surfacing — the user has real data.
    refresh().then(fresh => onFresh?.(fresh)).catch(() => {});
    return { payload: cached.payload, stale: true };
  }

  return { payload: await refresh(), stale: false };
}

/**
 * Latest close for each symbol. Returns a map of symbol → { price, asOf } or
 * { error }. Cached per symbol so a re-import only fetches what's new.
 */
export async function fetchQuotes(symbols) {
  const wanted = [...new Set((symbols || []).map(s => String(s).trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) return {};

  const cache = readCache(QUOTE_CACHE_KEY) || {};
  const now = Date.now();
  const out = {};
  const missing = [];

  for (const symbol of wanted) {
    const hit = cache[symbol];
    // Don't let a cached failure stick around — a delisting lookup can
    // succeed on the next try.
    if (hit && hit.fetchedAt && now - hit.fetchedAt < QUOTE_TTL_MS && !hit.quote?.error) {
      out[symbol] = hit.quote;
    } else {
      missing.push(symbol);
    }
  }

  if (missing.length) {
    // The endpoint caps at 60 symbols per call; chunk so a wide portfolio
    // still resolves.
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50);
      try {
        const res = await fetch(`/api/market-data?quotes=${encodeURIComponent(chunk.join(','))}`);
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || `Quote request failed (${res.status})`);
        for (const [symbol, quote] of Object.entries(json.quotes || {})) {
          out[symbol] = quote;
          cache[symbol] = { fetchedAt: now, quote };
        }
      } catch (err) {
        for (const symbol of chunk) out[symbol] = { error: err.message };
      }
    }
    writeCache(QUOTE_CACHE_KEY, cache);
  }

  return out;
}
