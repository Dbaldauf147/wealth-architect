// Reads the Commissions table out of the Prospect Tracker's Firestore and
// returns it parsed, so Income, Cash Flow and the Commissions page here show
// the same table you keep there — read live on each load, nothing copied.
//
// The tracker saves the table, as pasted sheet rows, in the owner's per-user
// mirror: userSettings/{uid}/localMirrors/commissions-list-override, a JSON
// string in `json`, or split across chunks/{0..n} as `s` when it's large.
//
// Access: the same service account the crons use (FIREBASE_SERVICE_ACCOUNT_JSON,
// project wealth-architecht) has been granted read-only Datastore Viewer on the
// tracker's project, so no second key is needed. TRACKER_SERVICE_ACCOUNT_JSON
// overrides it if that ever changes.
//
// Only what the pages use leaves this route: account, project, rate, window and
// the commission per month. Revenue columns and the deal (BFO) names stay in
// the tracker.
//
// Response: { ok, updatedAt, commissions: [...] }   (see lib/commissions)

import { parseCommissionRows } from '../src/lib/commissions.js';
import { trackerDb, readMirror } from './_lib/trackerCommissions.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const db = trackerDb();
    if (!db) return res.status(500).json({ error: 'Missing FIREBASE_SERVICE_ACCOUNT_JSON' });
    const mirror = await readMirror(db);
    if (!mirror) {
      return res.status(200).json({ ok: true, updatedAt: null, commissions: [], note: 'The tracker has no Commissions table saved yet' });
    }
    let rows = [];
    try { rows = mirror.json ? JSON.parse(mirror.json) : []; }
    catch { return res.status(502).json({ error: 'The tracker’s Commissions table could not be read' }); }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      updatedAt: mirror.updatedAt ? new Date(mirror.updatedAt).toISOString() : null,
      commissions: parseCommissionRows(rows),
    });
  } catch (err) {
    console.error('commissions failed:', err);
    const denied = err?.code === 7 || /PERMISSION_DENIED/i.test(String(err?.message));
    return res.status(denied ? 503 : 500).json({
      error: denied
        ? 'This site can’t read the Prospect Tracker yet (permission denied on its project)'
        : 'Could not read the Prospect Tracker',
    });
  }
}
