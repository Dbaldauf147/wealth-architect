// Parse a Robinhood activity export (or a comparable broker CSV) into
// normalized trades, then match them into FIFO lots.
//
// Robinhood's "Reports and statements → Activity" CSV has these columns:
//   Activity Date, Process Date, Settle Date, Instrument, Description,
//   Trans Code, Quantity, Price, Amount
// Other brokers name things differently, so column detection is by heuristic
// and falls back gracefully.

import { utcDay } from './benchmark.js';

// Trans Code → normalized side. Everything absent from this map is a
// non-trade row (dividends, transfers, interest, fees) and gets skipped.
const BUY_CODES = new Set(['buy']);
const SELL_CODES = new Set(['sell']);
// Options legs. The lot engine can't mix these with shares of the same
// underlying without corrupting the cost basis, so they're excluded and
// counted — see `skipped.options`.
const OPTION_CODES = new Set(['bto', 'stc', 'sto', 'btc', 'oexp', 'oasgn', 'oca', 'ocx']);

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

/** Pick the delimiter from the header line — supports pasted spreadsheet TSV. */
function detectDelimiter(text) {
  const head = text.slice(0, text.indexOf('\n') + 1 || text.length);
  const tabs = (head.match(/\t/g) || []).length;
  const commas = (head.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
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

// First matching alias wins, so the more specific names come first.
const COLUMN_ALIASES = {
  date: ['activitydate', 'tradedate', 'date', 'rundate', 'settledate', 'processdate'],
  symbol: ['instrument', 'symbol', 'ticker'],
  side: ['transcode', 'action', 'side', 'type', 'activity', 'transactiontype'],
  quantity: ['quantity', 'shares', 'qty', 'sharequantity'],
  price: ['price', 'shareprice', 'averageprice', 'priceshare'],
  amount: ['amount', 'netamount', 'total', 'value'],
  description: ['description', 'name'],
};

function mapColumns(header) {
  const normalized = header.map(norm);
  const cols = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const idx = normalized.indexOf(alias);
      if (idx !== -1) { cols[field] = idx; break; }
    }
  }
  return cols;
}

/** Normalize a Trans Code / Action into 'buy' | 'sell' | 'option' | null. */
function classify(raw) {
  const code = norm(raw);
  if (!code) return null;
  if (BUY_CODES.has(code)) return 'buy';
  if (SELL_CODES.has(code)) return 'sell';
  if (OPTION_CODES.has(code)) return 'option';
  // Other brokers spell it out.
  if (/^(buy|bought|purchase|buytoopen)/.test(code)) return 'buy';
  if (/^(sell|sold|selltoclose)/.test(code)) return 'sell';
  return null;
}

/**
 * Parse a broker CSV into normalized trades.
 *
 * Returns { trades, skipped, errors, columns } where `trades` is
 * [{ date, t, symbol, side, quantity, price, amount, description }] sorted
 * oldest-first, and `skipped` explains everything that didn't become a trade
 * so the UI can account for every row in the file.
 */
export function parseTradesCsv(text) {
  const raw = String(text || '').trim();
  if (!raw) return { trades: [], skipped: {}, errors: ['The file is empty.'], columns: {} };

  const rows = parseDelimited(raw, detectDelimiter(raw));
  if (rows.length < 2) {
    return { trades: [], skipped: {}, errors: ['No data rows found below the header.'], columns: {} };
  }

  const cols = mapColumns(rows[0]);
  const missing = ['date', 'symbol', 'side', 'quantity'].filter(f => cols[f] == null);
  if (missing.length) {
    return {
      trades: [],
      skipped: {},
      columns: cols,
      errors: [
        `Couldn't find these columns in the header: ${missing.join(', ')}. `
        + `Expected a Robinhood activity export (Activity Date, Instrument, Trans Code, Quantity, Price, Amount).`,
      ],
    };
  }

  const trades = [];
  const skipped = { options: 0, nonTrade: 0, unparseable: 0, zeroQuantity: 0 };
  const nonTradeCodes = new Map();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const at = (field) => (cols[field] == null ? '' : row[cols[field]] ?? '');

    const side = classify(at('side'));
    if (side === 'option') { skipped.options++; continue; }
    if (!side) {
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
      side,
      quantity,
      price: Number.isFinite(price) && price > 0 ? price : cash / quantity,
      amount: cash,
      description: String(at('description') || '').trim(),
    });
  }

  trades.sort((a, b) => a.t - b.t || (a.side === 'buy' ? -1 : 1));

  const errors = [];
  if (!trades.length) errors.push('No buy or sell rows were found in this file.');

  return {
    trades,
    skipped: { ...skipped, nonTradeCodes: [...nonTradeCodes.entries()].sort((a, b) => b[1] - a[1]) },
    errors,
    columns: cols,
  };
}

/**
 * FIFO-match buys against sells, per symbol.
 *
 * Returns { bySymbol, closed, open, unmatchedSells } where a closed lot
 * records both ends of a round trip and an open lot is still held. Sells that
 * exceed the shares on hand — normal when the export doesn't reach back far
 * enough to include the opening buy — are reported rather than guessed at,
 * because inventing a cost basis would silently distort every return below.
 */
export function buildLots(trades) {
  const bySymbol = new Map();

  for (const trade of trades) {
    if (!bySymbol.has(trade.symbol)) {
      bySymbol.set(trade.symbol, { symbol: trade.symbol, queue: [], closed: [], unmatched: [] });
    }
    const book = bySymbol.get(trade.symbol);

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

  for (const book of bySymbol.values()) {
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

  return { bySymbol, closed, open, unmatchedSells };
}
