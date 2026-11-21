import { useCallback, useEffect, useRef, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

/* HSA activity pasted on the Cards page's HSA tab, plus the coverage settings.
   Read by the Cards page (for the Alerts badge) and handed to the HSA tab.

   Stored in its own doc, hsa/default, not config/default: it's a growing
   list of transactions, and keeping it apart means it can never be caught in
   that doc's merge rules. A localStorage copy makes it show instantly and
   survive being offline; Firestore wins whenever it answers. */

const REF = ['hsa', 'default'];
const CACHE = 'hsa:v1';
const EMPTY = { rows: [], coverage: 'self', catchUp: false };

function readCache() {
  try { return { ...EMPTY, ...(JSON.parse(localStorage.getItem(CACHE)) || {}) }; }
  catch { return EMPTY; }
}
function writeCache(v) {
  try { localStorage.setItem(CACHE, JSON.stringify(v)); } catch { /* Firestore still has it */ }
}

export function useHsa() {
  const [data, setData] = useState(readCache);
  const [error, setError] = useState(null);
  // What save() builds on — kept outside render so two quick edits in one
  // tick both land.
  const latest = useRef(data);

  useEffect(() => onSnapshot(
    doc(db, ...REF),
    (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      // Offline, the SDK answers from its (possibly empty) cache with "no such
      // doc"; adopting that would wipe the localStorage copy. Only the server
      // gets to say the doc is gone.
      if (!snap.exists() && snap.metadata.fromCache) return;
      const next = { ...EMPTY, ...(snap.exists() ? snap.data() : {}) };
      latest.current = next;
      setData(next);
      writeCache(next);
      setError(null);
    },
    (err) => setError(err.message),
  ), []);

  const save = useCallback((patch) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setData(next);
    writeCache(next);
    setDoc(doc(db, ...REF), { ...JSON.parse(JSON.stringify(next)), updatedAt: new Date().toISOString() })
      .catch(err => setError(`Couldn't save to the cloud: ${err.message}`));
  }, []);

  return { ...data, save, error };
}
