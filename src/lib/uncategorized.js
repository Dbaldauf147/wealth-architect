/* An uncategorized transaction over $20 within the last 30 days — what the
   Transactions page's header badge counts and its click-to-filter shows, and
   what the sidebar's red count on Transactions counts. One rule, so all three
   always agree on what "counts". */

export function uncatOver20RecentCutoff(now = new Date()) {
  const c = new Date(now);
  c.setDate(c.getDate() - 30);
  return c.getTime();
}

export function isUncatOver20Recent(t, cutoffMs) {
  if ((t.category || 'Uncategorized') !== 'Uncategorized') return false;
  if (Math.abs(t.amount) <= 20) return false;
  const d = new Date(t.date);
  return !isNaN(d) && d.getTime() >= cutoffMs;
}

export function countUncatOver20Recent(transactions, now = new Date()) {
  const cutoff = uncatOver20RecentCutoff(now);
  return (transactions || []).filter(t => isUncatOver20Recent(t, cutoff)).length;
}
