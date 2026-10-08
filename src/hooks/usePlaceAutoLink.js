import { useEffect, useRef } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { txnKey } from '../lib/statementWindows';
import { autoLinkCandidates } from '../lib/placeMatch';

/* Remembered merchants match themselves.

   Once you've matched a charge from a merchant to a Prep Day place, every
   other charge from that merchant — earlier ones, and each new one as the sheet
   syncs it in — is matched to the same place and sent to Prep Day as a visit,
   without opening the Eating Out page. Mounted once, in App.

   Waits for the synced config before acting: on a fresh device placeLinks
   arrives from Firestore a moment after the transactions, and acting early
   would re-match a charge you'd deliberately unlinked on another device.
   Skipped in demo mode, where descriptions are scrambled.

   Each charge is tried at most once per page load, so a place deleted in Prep
   Day (which refuses the visit) can't cause a retry loop; and a "not
   connected" answer stops it until the next load. Prep Day keys visits by the
   charge, so two devices racing to send the same one still make one visit. */

const BATCH = 200;
const SETTLE_MS = 1500;

export function usePlaceAutoLink() {
  const { transactions, placeLinks, placeRules, privacyMode, loading, configHydrated } = useData();
  const { updatePlaceLinks } = useDataActions();
  const attempted = useRef(new Set());
  const running = useRef(false);
  const stopped = useRef(false);

  useEffect(() => {
    if (privacyMode || loading || !configHydrated || stopped.current) return undefined;
    const pending = autoLinkCandidates(transactions, placeLinks || {}, placeRules || {}, txnKey)
      .filter(c => !attempted.current.has(c.key));
    if (!pending.length) return undefined;

    // Let a burst of state changes (sync, a rule just saved) settle first.
    const timer = setTimeout(async () => {
      if (running.current) return;
      running.current = true;
      try {
        for (let i = 0; i < pending.length; i += BATCH) {
          const chunk = pending.slice(i, i + BATCH);
          for (const c of chunk) attempted.current.add(c.key);
          const res = await fetch('/api/prepday', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ops: chunk.map(c => ({ op: 'add', externalId: c.key, placeId: c.placeId, date: c.date, amount: c.amount, merchant: c.merchant })) }),
          });
          const data = await res.json().catch(() => ({}));
          if (!Array.isArray(data.results)) {
            if (res.status === 503) stopped.current = true;
            console.warn('Eating Out auto-match: Prep Day refused the batch:', data.error || res.status);
            return;
          }
          const ok = new Set(data.results.filter(r => r.ok).map(r => r.externalId));
          const links = {};
          for (const c of chunk) {
            if (ok.has(c.key)) links[c.key] = { placeId: c.placeId, placeName: c.placeName, sentAt: new Date().toISOString(), auto: true };
          }
          if (Object.keys(links).length) updatePlaceLinks(links);
        }
      } catch (err) {
        console.warn('Eating Out auto-match failed:', err);
      } finally {
        running.current = false;
      }
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [transactions, placeLinks, placeRules, privacyMode, loading, configHydrated, updatePlaceLinks]);
}
