/* Combining several people's trades into one household view.

   Each person's lots are built from their own trades first and only then
   put together. Building lots from the pooled trades would let one person's
   sell close another person's buy of the same ticker, which is wrong for
   both the gains and the holding periods. */

const byKey = (key) => (a, b) => (a[key] ?? 0) - (b[key] ?? 0);

/** Several buildLots() results as one. */
export function mergeLotSets(sets) {
  const parts = (sets || []).filter(Boolean);
  const excluded = new Map();
  for (const p of parts) {
    for (const e of p.excludedSymbols || []) {
      const codes = excluded.get(e.symbol) || new Set();
      for (const c of e.codes || []) codes.add(c);
      excluded.set(e.symbol, codes);
    }
  }
  return {
    closed: parts.flatMap(p => p.closed || []).sort(byKey('sellT')),
    open: parts.flatMap(p => p.open || []).sort(byKey('buyT')),
    unmatchedSells: parts.flatMap(p => p.unmatchedSells || []),
    appliedSplits: parts.flatMap(p => p.appliedSplits || []),
    reorgGroups: parts.flatMap(p => p.reorgGroups || []),
    excludedSymbols: [...excluded.entries()]
      .map(([symbol, codes]) => ({ symbol, codes: [...codes].sort() }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };
}

/** Several stored trade sets as one, for everything that reads the ledger
 *  rather than the lots: cash transfers, dividends, the quote list. */
export function mergeStoredTrades(sets) {
  const parts = (sets || []).filter(s => s && Array.isArray(s.trades) && s.trades.length);
  if (!parts.length) return null;
  const cat = (k) => parts.flatMap(p => p[k] || []);
  return {
    trades: cat('trades'),
    corporateActions: cat('corporateActions'),
    income: cat('income'),
    transfers: cat('transfers'),
    otherCash: cat('otherCash'),
    source: 'household',
  };
}
