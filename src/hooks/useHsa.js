import { useSyncExternalStore } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

/* HSA activity pasted on the Cards page's HSA tab, plus the coverage settings.
   Read by the Cards page (handed to the HSA tab) and by the sidebar's Alerts
   badge and page.

   One module-level store shared by every caller, so a paste on the HSA tab
   moves the sidebar badge at once rather than when the server acknowledges
   the write (or never, offline). A single Firestore listener runs while
   anything is subscribed.

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

let snapshot = null; // { ...data, save, error } — replaced on every change
const listeners = new Set();
let unsubFirestore = null;

function emit(data, error) {
  snapshot = { ...data, save, error };
  for (const l of listeners) l();
}

function current() {
  if (!snapshot) snapshot = { ...readCache(), save, error: null };
  return snapshot;
}

function save(patch) {
  const { save: _s, error: _e, ...data } = current();
  const next = { ...data, ...patch };
  writeCache(next);
  emit(next, null);
  setDoc(doc(db, ...REF), { ...JSON.parse(JSON.stringify(next)), updatedAt: new Date().toISOString() })
    .catch(err => {
      const { save: _s2, error: _e2, ...latest } = current();
      emit(latest, `Couldn't save to the cloud: ${err.message}`);
    });
}

function subscribe(listener) {
  listeners.add(listener);
  if (!unsubFirestore) {
    unsubFirestore = onSnapshot(
      doc(db, ...REF),
      (snap) => {
        if (snap.metadata.hasPendingWrites) return;
        // Offline, the SDK answers from its (possibly empty) cache with "no
        // such doc"; adopting that would wipe the localStorage copy. Only the
        // server gets to say the doc is gone.
        if (!snap.exists() && snap.metadata.fromCache) return;
        const next = { ...EMPTY, ...(snap.exists() ? snap.data() : {}) };
        delete next.updatedAt;
        writeCache(next);
        emit(next, null);
      },
      (err) => {
        const { save: _s, error: _e, ...data } = current();
        emit(data, err.message);
      },
    );
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && unsubFirestore) { unsubFirestore(); unsubFirestore = null; }
  };
}

export function useHsa() {
  return useSyncExternalStore(subscribe, current);
}
