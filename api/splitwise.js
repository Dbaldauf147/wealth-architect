// Reads the Splitwise account behind SPLITWISE_API_KEY.
//
// A server route rather than a fetch from the page for the same reason as
// rally-expense.js: the credential must never reach a browser bundle. The page
// calls this with no credential at all.
//
// GET /api/splitwise?days=90
//   → { connected, user, friends, groups, expenses, asOf }
//
// The raw Splitwise JSON is passed through almost untouched — what any of it
// means is decided in src/lib/splitwise.js, so the page and the tests agree by
// construction.
//
// Env:
//   SPLITWISE_API_KEY  Personal API key from https://secure.splitwise.com/apps

const BASE = 'https://secure.splitwise.com/api/v3.0';
const PAGE_SIZE = 100;
const MAX_PAGES = 8;          // 800 expenses is far past what any view shows
const TIMEOUT_MS = 12_000;

async function call(path, key, params = {}) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok) {
    const err = new Error(
      data?.error
      || data?.errors?.base?.[0]
      // 401 here is a bad or revoked key, which is a configuration fault worth
      // naming — "Splitwise request failed" would send someone debugging the
      // network instead of the key.
      || (res.status === 401 ? 'Splitwise rejected the API key' : `Splitwise returned ${res.status}`),
    );
    err.statusCode = res.status === 401 ? 500 : 502;
    throw err;
  }
  return data || {};
}

/** get_expenses pages at 100; walk until Splitwise runs out or the cap hits. */
async function fetchExpenses(key, datedAfter) {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { expenses } = await call('get_expenses', key, {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      dated_after: datedAfter,
    });
    const batch = Array.isArray(expenses) ? expenses : [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return all;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.SPLITWISE_API_KEY;
  if (!key) {
    // Not an error the user can fix by retrying, so say what is actually
    // missing. The page renders this string verbatim.
    return res.status(200).json({
      connected: false,
      error: 'Splitwise is not connected yet. Add SPLITWISE_API_KEY to the deployment.',
    });
  }

  const days = Math.min(Math.max(Number(req.query?.days) || 90, 1), 730);
  const datedAfter = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    // The current user has to land first — every expense is read from that
    // user's point of view, and the friend balances are denominated in their
    // default currency.
    const { user } = await call('get_current_user', key);
    const [friendsRes, groupsRes, expenses] = await Promise.all([
      call('get_friends', key),
      call('get_groups', key),
      fetchExpenses(key, datedAfter),
    ]);

    // Splitwise rate-limits per account, and none of this moves minute to
    // minute. A short edge cache keeps a page refresh from spending quota.
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
    return res.status(200).json({
      connected: true,
      user: user || null,
      friends: friendsRes.friends || [],
      groups: groupsRes.groups || [],
      expenses,
      days,
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    if (timedOut) {
      return res.status(504).json({ connected: true, error: 'Splitwise took too long to respond' });
    }
    console.error('splitwise failed:', err);
    return res.status(err.statusCode || 502).json({
      connected: true,
      error: err.message || 'Could not reach Splitwise',
    });
  }
}
