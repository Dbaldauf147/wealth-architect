// Parse a Robinhood activity export (or a comparable broker CSV / Excel
// paste) into normalized trades, then match them into FIFO lots.
//
// Robinhood's "Reports and statements → Activity" export has these columns:
//   Activity Date, Process Date, Settle Date, Instrument, Description,
//   Trans Code, Quantity, Price, Amount
// Other brokers name things differently and an Excel paste can be reordered
// entirely, so parsing is split into three steps the UI can drive:
//   readTable(text)          → { header, rows }
//   guessMapping(header)     → { date: 0, symbol: 3, … }   (user-overridable)
//   parseRows(rows, mapping) → { trades, corporateActions, skipped }

import { utcDay } from './benchmark.js';

// Trans Code → normalized side. Everything absent from these sets is either a
// corporate action (below) or a non-trade row: dividends, transfers, fees.
const BUY_CODES = new Set(['buy']);
const SELL_CODES = new Set(['sell']);

// Options legs. The lot engine can't mix these with shares of the same
// underlying without corrupting the cost basis, so they're excluded and
// counted — see `skipped.options`.
const OPTION_CODES = new Set(['bto', 'stc', 'sto', 'btc', 'oexp', 'oasgn', 'oca', 'ocx']);

// Forward/reverse splits. These change the share count with no cash and no
// change in total basis, so they can be applied exactly.
const SPLIT_CODES = new Set(['spl']);

// Share exchanges, spin-offs, mergers and conversions. These move basis
// between tickers using fair-market values we don't have, so any symbol
// touched by one is dropped from the comparison rather than guessed at.
const REORG_CODES = new Set(['sxch', 'soff', 'mrgs', 'mrgc', 'spr', 'spo', 'conv', 'rsplit']);

/** RFC4180-ish parser: handles quoted fields, embedded commas and newlines. */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field); field = '';
      // Drop blank lines rather than emitting phantom rows.
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }

  row.push(field);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
}

/** Pick the delimiter from the header line — an Excel paste arrives as TSV. */
function detectDelimiter(text) {
  const firstBreak = text.indexOf('\n');
  const head = firstBreak === -1 ? text : text.slice(0, firstBreak);
  const tabs = (head.match(/\t/g) || []).length;
  const commas = (head.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

/** Split raw pasted text into a header row and data rows. */
export function readTable(text) {
  // Strip a UTF-8 BOM — Excel adds one when saving CSV.
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return { header: [], rows: [], delimiter: ',' };
  const delimiter = detectDelimiter(raw);
  const all = parseDelimited(raw, delimiter);
  return { header: all[0] || [], rows: all.slice(1), delimiter };
}

/** '$1,234.56' / '($1,234.56)' / '-1234.56' → number. Parens mean negative. */
function parseMoney(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s);
  s = s.replace(/[()$,\s]/g, '');
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// Corporate-action quantities carry suffixes ('46S' means 46 shares out), so
// they need a looser read than a cash amount.
function parseLooseQuantity(raw) {
  const m = String(raw || '').match(/-?\d*\.?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** 'M/D/YYYY', 'YYYY-MM-DD' and 'M/D/YY' → 'YYYY-MM-DD'. */
function parseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  }

  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    let year = Number(us[3]);
    // Two-digit years: brokerage exports don't predate 2000.
    if (year < 100) year += 2000;
    return `${year}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`;
  }

  return null;
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/** The fields the lot engine needs, in the order the mapping UI shows them. */
export const FIELDS = [
  { key: 'date', label: 'Date', required: true, hint: 'Activity Date' },
  { key: 'symbol', label: 'Ticker', required: true, hint: 'Instrument' },
  { key: 'side', label: 'Action', required: true, hint: 'Trans Code' },
  { key: 'quantity', label: 'Quantity', required: true, hint: 'Quantity' },
  { key: 'amount', label: 'Amount', required: false, hint: 'Amount — preferred, it includes fees' },
  { key: 'price', label: 'Price', required: false, hint: 'Price — used only if Amount is blank' },
];

// First matching alias wins, so more specific names come first.
const COLUMN_ALIASES = {
  date: ['activitydate', 'tradedate', 'date', 'rundate', 'settledate', 'processdate'],
  symbol: ['instrument', 'symbol', 'ticker'],
  side: ['transcode', 'action', 'side', 'type', 'activity', 'transactiontype'],
  quantity: ['quantity', 'shares', 'qty', 'sharequantity'],
  price: ['price', 'shareprice', 'averageprice', 'priceshare'],
  amount: ['amount', 'netamount', 'total', 'value'],
};

/** Best-guess column indices for a header row. Missing fields are null. */
export function guessMapping(header) {
  const normalized = (header || []).map(norm);
  const mapping = {};
  for (const { key } of FIELDS) {
    mapping[key] = null;
    for (const alias of COLUMN_ALIASES[key]) {
      const idx = normalized.indexOf(alias);
      if (idx !== -1) { mapping[key] = idx; break; }
    }
  }
  return mapping;
}

/** Which required fields a mapping is still missing. */
export function missingFields(mapping) {
  return FIELDS.filter(f => f.required && (mapping?.[f.key] == null))
    .map(f => f.label);
}

/** Normalize a Trans Code into 'buy' | 'sell' | 'option' | 'split' | 'reorg' | null. */
function classify(raw) {
  const code = norm(raw);
  if (!code) return null;
  if (BUY_CODES.has(code)) return 'buy';
  if (SELL_CODES.has(code)) return 'sell';
  if (OPTION_CODES.has(code)) return 'option';
  if (SPLIT_CODES.has(code)) return 'split';
  if (REORG_CODES.has(code)) return 'reorg';
  // Other brokers spell it out.
  if (/^(buy|bought|purchase|buytoopen)/.test(code)) return 'buy';
  if (/^(sell|sold|selltoclose)/.test(code)) return 'sell';
  return null;
}

/**
 * Turn data rows into normalized trades using an explicit column mapping.
 *
 * Returns { trades, corporateActions, skipped }. `trades` is
 * [{ date, t, symbol, side, quantity, price, amount }] sorted oldest-first;
 * `skipped` accounts for every row that didn't become one.
 */
export function parseRows(rows, mapping) {
  const trades = [];
  const corporateActions = [];
  const skipped = { options: 0, nonTrade: 0, unparseable: 0, zeroQuantity: 0 };
  const nonTradeCodes = new Map();

  for (const row of rows || []) {
    const at = (field) => {
      const idx = mapping?.[field];
      return idx == null ? '' : (row[idx] ?? '');
    };

    const kind = classify(at('side'));

    if (kind === 'option') { skipped.options++; continue; }

    if (kind === 'split' || kind === 'reorg') {
      const date = parseDate(at('date'));
      const symbol = String(at('symbol') || '').trim().toUpperCase();
      if (date && symbol) {
        corporateActions.push({
          kind,
          code: String(at('side') || '').trim().toUpperCase(),
          date,
          t: utcDay(date),
          symbol,
          quantity: parseLooseQuantity(at('quantity')),
        });
        continue;
      }
      // A reorg row with no ticker (e.g. the cash side of an account
      // conversion) carries no position information — treat it as a
      // non-trade so the totals still add up.
      skipped.nonTrade++;
      const code = String(at('side') || '').trim();
      if (code) nonTradeCodes.set(code, (nonTradeCodes.get(code) || 0) + 1);
      continue;
    }

    if (!kind) {
      skipped.nonTrade++;
      const code = String(at('side') || '').trim();
      if (code) nonTradeCodes.set(code, (nonTradeCodes.get(code) || 0) + 1);
      continue;
    }

    const date = parseDate(at('date'));
    const symbol = String(at('symbol') || '').trim().toUpperCase();
    const quantity = Math.abs(parseMoney(at('quantity')) ?? NaN);
    const price = parseMoney(at('price'));
    const amount = parseMoney(at('amount'));

    if (!date || !symbol || !Number.isFinite(quantity)) { skipped.unparseable++; continue; }
    if (quantity === 0) { skipped.zeroQuantity++; continue; }

    // Amount is the true cash moved (it already carries fees), so prefer it
    // over quantity × price when the column exists.
    const cash = Number.isFinite(amount) && amount !== 0
      ? Math.abs(amount)
      : (Number.isFinite(price) ? quantity * price : NaN);
    if (!Number.isFinite(cash) || cash <= 0) { skipped.unparseable++; continue; }

    trades.push({
      date,
      t: utcDay(date),
      symbol,
      side: kind,
      quantity,
      price: Number.isFinite(price) && price > 0 ? price : cash / quantity,
      amount: cash,
    });
  }

  sortTrades(trades);
  corporateActions.sort((a, b) => a.t - b.t);

  return {
    trades,
    corporateActions,
    skipped: { ...skipped, nonTradeCodes: [...nonTradeCodes.entries()].sort((a, b) => b[1] - a[1]) },
  };
}

/** Oldest first; a buy settles before a sell on the same day so FIFO works. */
export function sortTrades(trades) {
  return trades.sort((a, b) => a.t - b.t || (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1));
}

/**
 * One-shot parse for the simple path: read, guess the mapping, parse.
 * The staged import UI calls readTable / guessMapping / parseRows directly so
 * the user can correct the mapping first.
 */
export function parseTradesCsv(text) {
  const { header, rows } = readTable(text);
  if (!rows.length) {
    return { trades: [], corporateActions: [], skipped: {}, header, mapping: {}, errors: ['No data rows found below the header.'] };
  }

  const mapping = guessMapping(header);
  const missing = missingFields(mapping);
  if (missing.length) {
    return {
      trades: [], corporateActions: [], skipped: {}, header, mapping,
      errors: [`Couldn't find these columns: ${missing.join(', ')}.`],
    };
  }

  const parsed = parseRows(rows, mapping);
  return {
    ...parsed,
    header,
    mapping,
    errors: parsed.trades.length ? [] : ['No buy or sell rows were found.'],
  };
}

// ── Merging imports ─────────────────────────────────────────────────────

/**
 * Identity of a trade for duplicate detection. Deliberately excludes any
 * import metadata so the same row re-exported later still matches.
 */
export function tradeKey(t) {
  return [
    t.date,
    t.symbol,
    t.side,
    Number(t.quantity).toFixed(6),
    Number(t.amount).toFixed(2),
  ].join('|');
}

/**
 * Merge an incoming import into existing history.
 *
 * Matching is by *multiset*, not by set: two genuinely separate fills of the
 * same size on the same day (which Robinhood does emit — a $229 Alibaba buy
 * can appear twice in one order) are two distinct trades. Counting
 * occurrences means re-importing an overlapping date range drops exactly the
 * rows already held and keeps the rest, while a first-time import of two
 * identical fills keeps both.
 */
export function mergeTrades(existing, incoming) {
  const counts = new Map();
  for (const t of existing || []) {
    const k = tradeKey(t);
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  const added = [];
  const duplicates = [];
  for (const t of incoming || []) {
    const k = tradeKey(t);
    const remaining = counts.get(k) || 0;
    if (remaining > 0) { counts.set(k, remaining - 1); duplicates.push(t); }
    else added.push(t);
  }

  return { merged: sortTrades([...(existing || []), ...added]), added, duplicates };
}

/** Union of corporate actions, keyed so a re-import doesn't double-count. */
export function mergeCorporateActions(existing, incoming) {
  const byKey = new Map();
  for (const a of [...(existing || []), ...(incoming || [])]) {
    if (!a || !a.symbol || !a.date) continue;
    byKey.set(`${a.date}|${a.symbol}|${a.code}|${a.quantity}`, a);
  }
  return [...byKey.values()].sort((a, b) => a.t - b.t);
}

// ── FIFO lot matching ───────────────────────────────────────────────────

/** Every ticker that appears in a buy or sell row. */
export function tradedSymbols(trades) {
  return [...new Set((trades || []).map(t => t.symbol).filter(Boolean))].sort();
}

/**
 * FIFO-match buys against sells, per symbol, applying splits along the way.
 *
 * `apiSplits` maps symbol → [{ date, ratio }] from the price feed and is the
 * authoritative source: a split that happens after the export's end date is
 * invisible to the file, and missing one silently multiplies the share count
 * (a 6:1 makes a position look like it lost 83%). The file's own SPL rows are
 * used only for symbols the feed knows nothing about.
 *
 * Returns { closed, open, unmatchedSells, excludedSymbols, appliedSplits }.
 *
 * Sells that exceed the shares on hand — normal when the export doesn't reach
 * back far enough to include the opening buy — are reported rather than
 * guessed at, because inventing a cost basis would distort every return.
 *
 * Symbols touched by a share exchange, spin-off or merger are dropped
 * entirely: those move cost basis between tickers using fair-market values
 * the export doesn't contain, so any number we produced would be fiction.
 */
export function buildLots(trades, corporateActions, apiSplits) {
  const actions = corporateActions || [];
  const feed = apiSplits || {};

  // Any symbol involved in a reorg is untrustworthy — both the ticker that
  // went away and the one that appeared.
  const excluded = new Map();
  for (const a of actions) {
    if (a.kind !== 'reorg') continue;
    if (!excluded.has(a.symbol)) excluded.set(a.symbol, new Set());
    excluded.get(a.symbol).add(a.code);
  }

  // Feed splits win; fall back to the file's SPL rows only where the feed
  // returned nothing for that symbol, so the two can never double-count.
  const splitsBySymbol = new Map();
  for (const symbol of tradedSymbols(trades)) {
    if (excluded.has(symbol)) continue;
    const fromFeed = feed[symbol];
    if (Array.isArray(fromFeed) && fromFeed.length) {
      splitsBySymbol.set(symbol, fromFeed
        .filter(s => Number.isFinite(s.ratio) && s.ratio > 0 && s.date)
        .map(s => ({ symbol, date: s.date, t: utcDay(s.date), ratio: s.ratio, source: 'feed' })));
    } else if (!(symbol in feed)) {
      const fromFile = actions.filter(a => a.kind === 'split' && a.symbol === symbol);
      if (fromFile.length) splitsBySymbol.set(symbol, fromFile.map(a => ({ ...a, source: 'file' })));
    }
  }

  const books = new Map();
  const bookFor = (symbol) => {
    if (!books.has(symbol)) books.set(symbol, { symbol, queue: [], closed: [], unmatched: [] });
    return books.get(symbol);
  };

  // Interleave trades and splits in date order so a split only ever rescales
  // the lots that were actually open when it happened.
  const events = [];
  for (const t of trades || []) {
    if (excluded.has(t.symbol)) continue;
    events.push({ t: t.t, order: t.side === 'buy' ? 0 : 1, kind: 'trade', trade: t });
  }
  for (const list of splitsBySymbol.values()) {
    // Splits settle before the day's trading for our purposes, so a same-day
    // buy is already in post-split shares and must not be rescaled.
    for (const a of list) events.push({ t: a.t, order: -1, kind: 'split', action: a });
  }
  events.sort((a, b) => a.t - b.t || a.order - b.order);

  const appliedSplits = [];

  for (const ev of events) {
    if (ev.kind === 'split') {
      const action = ev.action;
      const book = bookFor(action.symbol);
      const held = book.queue.reduce((s, l) => s + l.remaining, 0);
      // Nothing held on the split date means nothing to rescale — a split
      // before the first buy is already priced into what was bought.
      if (!(held > 0)) continue;

      const factor = action.source === 'feed'
        ? action.ratio
        // The file reports shares *added*, not a ratio or a new total.
        : (Number.isFinite(action.quantity) && action.quantity !== 0
          ? (held + action.quantity) / held
          : null);
      if (!Number.isFinite(factor) || factor <= 0 || factor === 1) continue;

      for (const lot of book.queue) {
        lot.remaining *= factor;
        lot.quantity *= factor;
        // Total basis is unchanged by a split — only basis per share moves.
        lot.unitCost /= factor;
      }
      appliedSplits.push({
        symbol: action.symbol,
        date: action.date,
        factor,
        source: action.source,
        sharesBefore: held,
        sharesAfter: held * factor,
      });
      continue;
    }

    const trade = ev.trade;
    const book = bookFor(trade.symbol);

    if (trade.side === 'buy') {
      book.queue.push({
        quantity: trade.quantity,
        remaining: trade.quantity,
        // Per-share cash including fees, so partial fills split cleanly.
        unitCost: trade.amount / trade.quantity,
        buyT: trade.t,
        buyDate: trade.date,
      });
      continue;
    }

    let toSell = trade.quantity;
    const unitProceeds = trade.amount / trade.quantity;

    while (toSell > 1e-9 && book.queue.length) {
      const lot = book.queue[0];
      const matched = Math.min(lot.remaining, toSell);
      book.closed.push({
        symbol: trade.symbol,
        quantity: matched,
        buyT: lot.buyT,
        buyDate: lot.buyDate,
        sellT: trade.t,
        sellDate: trade.date,
        costBasis: matched * lot.unitCost,
        proceeds: matched * unitProceeds,
      });
      lot.remaining -= matched;
      toSell -= matched;
      if (lot.remaining <= 1e-9) book.queue.shift();
    }

    if (toSell > 1e-9) {
      book.unmatched.push({
        symbol: trade.symbol,
        date: trade.date,
        t: trade.t,
        quantity: toSell,
        proceeds: toSell * unitProceeds,
      });
    }
  }

  const closed = [];
  const open = [];
  const unmatchedSells = [];

  for (const book of books.values()) {
    closed.push(...book.closed);
    unmatchedSells.push(...book.unmatched);
    for (const lot of book.queue) {
      if (lot.remaining <= 1e-9) continue;
      open.push({
        symbol: book.symbol,
        quantity: lot.remaining,
        buyT: lot.buyT,
        buyDate: lot.buyDate,
        costBasis: lot.remaining * lot.unitCost,
      });
    }
  }

  closed.sort((a, b) => a.sellT - b.sellT);
  open.sort((a, b) => a.buyT - b.buyT);

  return {
    closed,
    open,
    unmatchedSells,
    appliedSplits,
    excludedSymbols: [...excluded.entries()].map(([symbol, codes]) => ({
      symbol,
      codes: [...codes].sort(),
    })).sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };
}
