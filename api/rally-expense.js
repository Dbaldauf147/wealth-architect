// Hands a charge tagged "needs splitting" to Rally.
//
// This exists as a server route rather than a fetch from the page for one
// reason: the shared secret Rally authenticates with must never be in a
// browser bundle. The page posts the charge here with no credential at all;
// this function adds the secret and forwards it.
//
// Rally is a separate app on a separate Firebase project, so the contract
// between them is this HTTP call and nothing else — neither app holds the
// other's database credentials.
//
// Env:
//   RALLY_API_URL       Base URL of the Rally deployment, e.g. https://rally.example.com
//   RALLY_INGEST_SECRET Shared secret, must match Rally's copy

const MAX_NOTE = 500;

function clean(value, max = 300) {
  return String(value == null ? '' : value).slice(0, max);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const base = process.env.RALLY_API_URL;
  const secret = process.env.RALLY_INGEST_SECRET;
  if (!base || !secret) {
    // A misconfigured deployment should say so plainly — the phone shows this
    // string, and "Could not reach Rally" would send someone hunting a network
    // fault that isn't there.
    return res.status(503).json({
      error: 'Rally is not connected yet. Set RALLY_API_URL and RALLY_INGEST_SECRET.',
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const transactionId = clean(body.transactionId, 200);
  const amount = Number(body.amount);

  if (!transactionId) return res.status(400).json({ error: 'transactionId is required' });
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'amount must be a non-zero number' });
  }

  // Expenses are positive money out. A charge arrives negative from the sheet;
  // a refund or an income row is not a thing to split.
  if (amount > 0) {
    return res.status(400).json({ error: 'Only a charge can be split, not money coming in' });
  }

  const payload = {
    externalId: transactionId,
    source: 'wealth-architect',
    description: clean(body.description) || 'Untitled charge',
    fullDescription: clean(body.fullDescription, 500),
    amount: Math.abs(amount),
    date: clean(body.date, 40),
    account: clean(body.account, 120),
    category: clean(body.category, 120),
    subcategory: clean(body.subcategory, 120),
    note: clean(body.note, MAX_NOTE),
  };

  try {
    const upstream = await fetch(`${base.replace(/\/+$/, '')}/api/split-expenses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rally-ingest-secret': secret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12_000),
    });

    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }

    if (!upstream.ok) {
      // Don't echo Rally's status verbatim — a 401 from Rally is a
      // configuration fault here, not the caller's fault.
      return res.status(upstream.status === 401 ? 500 : 502).json({
        error: data.error || `Rally rejected the expense (${upstream.status})`,
      });
    }

    return res.status(200).json({ id: data.id || null, updated: !!data.updated });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return res.status(504).json({
      error: timedOut ? 'Rally took too long to respond' : `Could not reach Rally: ${err.message}`,
    });
  }
}
