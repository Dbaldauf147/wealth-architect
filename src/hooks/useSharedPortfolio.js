import { useCallback, useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';

/* Someone else's imported Robinhood trades, e.g. Joanne's.

   Kept in its own Firestore doc, `portfolios/<id>`, rather than in
   config/default: it is a separate person's account and must never merge
   into yours, and a second full trade history would crowd that doc toward
   Firestore's 1 MB limit. A localStorage copy makes the page load instantly
   and survive being offline; Firestore wins whenever it answers. */

const cacheKey = (id) => `portfolio:${id}:v1`;

function readCache(id) {
  try { return JSON.parse(localStorage.getItem(cacheKey(id))) || null; }
  catch { return null; }
}

function writeCache(id, value) {
  try {
    if (value) localStorage.setItem(cacheKey(id), JSON.stringify(value));
    else localStorage.removeItem(cacheKey(id));
  } catch { /* private mode or full: Firestore still has it */ }
}

export function useSharedPortfolio(id) {
  const [trades, setTrades] = useState(() => readCache(id));
  const [error, setError] = useState(null);

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'portfolios', id),
      (snap) => {
        const data = snap.exists() ? snap.data()?.robinhoodTrades || null : null;
        setTrades(data);
        writeCache(id, data);
        setError(null);
      },
      (err) => setError(err.message),
    );
    return unsub;
  }, [id]);

  const save = useCallback((payload) => {
    const next = payload && Array.isArray(payload.trades) && payload.trades.length ? payload : null;
    setTrades(next);
    writeCache(id, next);
    const ref = doc(db, 'portfolios', id);
    // A JSON round trip drops `undefined`, which Firestore refuses.
    const write = next
      ? setDoc(ref, { robinhoodTrades: JSON.parse(JSON.stringify(next)), updatedAt: new Date().toISOString() })
      : deleteDoc(ref);
    write.catch(err => setError(`Couldn't save to the cloud: ${err.message}`));
  }, [id]);

  return { robinhoodTrades: trades, setRobinhoodTrades: save, error };
}
