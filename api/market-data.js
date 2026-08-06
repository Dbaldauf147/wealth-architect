// Market data proxy for the Stock Performance page.
//
// Two modes, both GET:
//   /api/market-data?series=^SP500TR&start=2005-01-01
//     → one symbol's daily closes, as [[epochSeconds, close], …]
//   /api/market-data?quotes=AAPL,MSFT&since=2020-01-01
//     → { quotes: { AAPL: { price, asOf, splits, points }, … } }
//   /api/market-data?cpi=2000
//     → monthly CPI-U from that year, same [[epochSeconds, level], …] shape
//
// This lives server-side purely because Yahoo doesn't send CORS headers; no
// API key is involved. The feed access itself is in _lib/marketFeed.js so the
// daily snapshot cron prices positions exactly the same way this route does.

import { getSeries, getQuotes } from './_lib/marketFeed.js';
import { getCpi } from './_lib/cpiFeed.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { series, quotes, cpi, start, since } = req.query || {};

  try {
    if (series) {
      const payload = await getSeries(String(series).toUpperCase(), String(start || '2005-01-01'));
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
      const payload = await getQuotes(symbols, String(since || '2015-01-01'));
      res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
      return res.status(200).json({ quotes: payload });
    }

    if (cpi) {
      const payload = await getCpi(Number(cpi) || 2000);
      // CPI moves once a month and the BLS API is rate-limited per IP, so this
      // wants a much longer edge cache than the price routes get.
      res.setHeader('Cache-Control', 'public, s-maxage=43200, stale-while-revalidate=604800');
      return res.status(200).json(payload);
    }

    return res.status(400).json({ error: 'Supply ?series=SYMBOL, ?quotes=A,B,C or ?cpi=YEAR' });
  } catch (err) {
    console.error('market-data failed:', err);
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
}
