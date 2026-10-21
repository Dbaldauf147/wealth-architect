import { useEffect, useMemo, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { payouts } from '../lib/commissions';

/* The Prospect Tracker's commissions, read through /api/commissions.

   Read live — on load, and again whenever the sheet re-syncs (Force Sync, a
   return to the tab) — with the last good answer kept in localStorage so a
   page paints at once and a failed read leaves numbers on screen. Every page
   that asks shares one request.

   Returns { loading, error, updatedAt, commissions, payouts }. */

const CACHE_KEY = 'commissionsCache:v1';

function loadCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return raw && Array.isArray(raw.commissions) ? raw : null;
  } catch { return null; }
}

let inflight = null;
let inflightFor = null;
function fetchCommissions(stamp) {
  if (inflight && inflightFor === stamp) return inflight;
  inflightFor = stamp;
  inflight = fetch('/api/commissions', { cache: 'no-store' })
    .then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `The tracker answered ${res.status}`);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ updatedAt: data.updatedAt, commissions: data.commissions })); } catch { /* quota */ }
      return data;
    });
  return inflight;
}

export function useCommissions() {
  const { lastSync, privacyMode } = useData();
  const [state, setState] = useState(() => {
    const cached = loadCache();
    return { loading: !cached, error: null, updatedAt: cached?.updatedAt || null, commissions: cached?.commissions || [] };
  });
  const stamp = lastSync ? new Date(lastSync).getTime() : 0;

  useEffect(() => {
    if (privacyMode) return undefined;
    let cancelled = false;
    fetchCommissions(stamp)
      .then(data => { if (!cancelled) setState({ loading: false, error: null, updatedAt: data.updatedAt, commissions: data.commissions || [] }); })
      .catch(err => { if (!cancelled) setState(s => ({ ...s, loading: false, error: err.message || String(err) })); });
    return () => { cancelled = true; };
  }, [stamp, privacyMode]);

  return useMemo(() => (privacyMode
    ? { loading: false, error: null, updatedAt: null, commissions: [], payouts: [] }
    : { ...state, payouts: payouts(state.commissions) }), [state, privacyMode]);
}
