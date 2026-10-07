// The Eating Out page's line to Prep Day (the meal-planning app, which keeps
// the list of restaurants). Prep Day is a separate app on a separate Firebase
// project, so — as with Rally — the contract is an HTTP call and nothing else.
//
// This is a server route rather than a fetch from the page for one reason: the
// shared secret Prep Day checks must never be in a browser bundle. The page
// calls here with no credential; this adds the secret and forwards.
//
// GET  /api/prepday          → { places, visits } from Prep Day's /api/wealth-sync
// POST /api/prepday { ops }  → logs or removes visits there; see that route
//
// Env:
//   PREPDAY_SYNC_SECRET  Shared secret, must match Prep Day's WEALTH_SYNC_SECRET
//   PREPDAY_API_URL      Optional; defaults to https://prep-day.com

const MAX_OPS = 200;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.PREPDAY_SYNC_SECRET;
  const base = (process.env.PREPDAY_API_URL || 'https://prep-day.com').replace(/\/+$/, '');
  if (!secret) {
    // Said plainly, so the page can tell "not set up" from "Prep Day is down".
    return res.status(503).json({ error: 'Prep Day is not connected yet. Set PREPDAY_SYNC_SECRET.' });
  }

  let body;
  if (req.method === 'POST') {
    const ops = Array.isArray(req.body?.ops) ? req.body.ops : null;
    if (!ops || !ops.length) return res.status(400).json({ error: 'ops must be a non-empty array' });
    if (ops.length > MAX_OPS) return res.status(400).json({ error: `At most ${MAX_OPS} ops per request` });
    body = JSON.stringify({ ops });
  }

  try {
    const upstream = await fetch(`${base}/api/wealth-sync`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'x-wealth-sync-secret': secret },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) || `Prep Day answered ${upstream.status}` }; }
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Could not reach Prep Day: ${err?.message || err}` });
  }
}
