/* Load-time merges for synced values that used to be taken whole.

   DataContext's hydration merge combines this device's localStorage with the
   Firestore config doc, then writes the result back when it differs. For a
   value taken as `local || remote`, that meant any device holding an older
   copy won, and its copy then overwrote the cloud — erasing whatever was
   changed elsewhere since. The short-term loan had this (see mergeLoan in
   loanInterest.js); so did these two.

   Pure: no React, no storage. */

const stamp = v => Date.parse(v || '') || 0;

/**
 * Card promotions: an ordered list of `{ id, ... }`, or null for "never set
 * up" (which falls back to the seed list — not the same as [], a user who
 * deleted them all).
 *
 * `localAt` / `remoteAt` are when each list was last edited. When the cloud's
 * stamp is the newer one it wins outright, so a promo deleted on another device
 * stays deleted. Otherwise — this device edited more recently, or neither side
 * has a stamp yet — the newer (or, unstamped, the cloud's) list is kept as is,
 * and promos only the other side has are appended, so nothing added anywhere
 * is lost.
 *
 * @returns {{ promos: object[]|null, at: string|null }}
 */
export function mergePromos(local, remote, localAt = null, remoteAt = null) {
  const at = stamp(localAt) >= stamp(remoteAt) ? (localAt || remoteAt || null) : remoteAt;
  if (!Array.isArray(local)) return { promos: Array.isArray(remote) ? remote : null, at: remoteAt || localAt || null };
  if (!Array.isArray(remote)) return { promos: local, at: localAt || remoteAt || null };
  const lt = stamp(localAt);
  const rt = stamp(remoteAt);
  if (rt && rt >= lt) return { promos: remote, at: remoteAt };

  const [newer, older] = lt > rt ? [local, remote] : [remote, local];
  const have = new Set(newer.map(p => p && p.id).filter(Boolean));
  const promos = [...newer];
  for (const p of older) {
    if (!p || !p.id || have.has(p.id)) continue;
    have.add(p.id);
    promos.push(p);
  }
  return { promos, at };
}

/**
 * Imported Robinhood trades: one payload per import, `{ trades, importedAt, ... }`,
 * or null. Imports replace each other rather than adding up, so the newer one
 * wins; with no stamp to go on, the cloud's copy does.
 */
export function mergeTrades(local, remote) {
  if (!local) return remote || null;
  if (!remote) return local;
  return stamp(local.importedAt) > stamp(remote.importedAt) ? local : remote;
}
