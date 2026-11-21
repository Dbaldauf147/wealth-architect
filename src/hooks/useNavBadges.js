import { useEffect, useMemo, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { txnKey } from '../lib/statementWindows';
import { eatingOutRows } from '../lib/placeMatch';
import { countUncatOver20Recent } from '../lib/uncategorized';
import { useHsa } from './useHsa';
import { hsaAlerts } from '../lib/hsa';

// The Eating Out page opens on the last 3 months; the badge counts what it
// shows there, so the number matches the list you land on.
const EATING_OUT_MONTHS = 3;

/* Red counts on the sidebar: { transactions, eatingout, alerts }.

   transactions — uncategorized charges over $20 in the last 30 days, the same
   rule as the Transactions page's header badge.
   eatingout    — unmatched restaurant charges with a Prep Day place suggested
   for them. Needs Prep Day's place list, read once per load; while it's
   loading, or if Prep Day can't be reached, the count is 0 rather than a guess.
   Both are 0 in demo mode, where descriptions are scrambled.
   alerts       — how many items the Alerts page lists (same hsaAlerts rule);
   shown in demo mode too, since it reveals no amounts or descriptions. */
export function useNavBadges() {
  const { transactions, placeLinks, placeRules, privacyMode } = useData();
  const [places, setPlaces] = useState(null);
  const { rows: hsaRows } = useHsa();
  const alerts = useMemo(() => hsaAlerts(hsaRows, new Date()).length, [hsaRows]);

  useEffect(() => {
    if (privacyMode) return undefined;
    let cancelled = false;
    fetch('/api/prepday', { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : null))
      .then(data => { if (!cancelled && data) setPlaces(data.places || []); })
      .catch(() => { /* no badge rather than a broken sidebar */ });
    return () => { cancelled = true; };
  }, [privacyMode]);

  return useMemo(() => {
    if (privacyMode) return { transactions: 0, eatingout: 0, alerts };
    const suggested = places?.length
      ? eatingOutRows(transactions, { months: EATING_OUT_MONTHS, placeLinks, placeRules, places, keyOf: txnKey })
        .filter(r => !r.link && r.suggestion).length
      : 0;
    return { transactions: countUncatOver20Recent(transactions), eatingout: suggested, alerts };
  }, [transactions, placeLinks, placeRules, places, privacyMode, alerts]);
}
