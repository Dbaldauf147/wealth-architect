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

// Cash a position throws off, and the costs levied against it. Both are real
// return on the money invested, so leaving them out while benchmarking
// against a *total return* index quietly penalises every dividend payer.
// Amounts keep the sign the export gives them: CDIV is positive, DTAX and the
// ADR fees arrive parenthesised and so parse negative.
const INCOME_CODES = new Set(['cdiv', 'sdiv', 'mdiv', 'scap', 'lcap', 'cil']);
const INCOME_COST_CODES = new Set(['dtax', 'dfee', 'afee']);

// Money crossing the account boundary. These are the only flows that are
// genuinely *yours* — everything else (dividends, sale proceeds, fees) is the
// account moving its own money around. Benchmarking against external cash is
// the one framing that can't double-count a dividend which later funded a
// purchase. Robinhood spells cancellations as ordinary ACH rows with a
// negative amount, so no special handling is needed: the signed sum is right.
const TRANSFER_CODES = new Set(['ach', 'rtp', 'wire', 'dcf', 'iact']);

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

/** Normalize a Trans Code into a row kind, or null for anything unrecognised. */
function classify(raw) {
  const code = norm(raw);
  if (!code) return null;
  if (BUY_CODES.has(code)) return 'buy';
  if (SELL_CODES.has(code)) return 'sell';
  if (OPTION_CODES.has(code)) return 'option';
  if (SPLIT_CODES.has(code)) return 'split';
  if (REORG_CODES.has(code)) return 'reorg';
  if (INCOME_CODES.has(code) || INCOME_COST_CODES.has(code)) return 'income';
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
  const income = [];
  const transfers = [];
  const otherCash = [];
  const skipped = { options: 0, nonTrade: 0, unparseable: 0, zeroQuantity: 0, accountLevelIncome: 0 };
  const nonTradeCodes = new Map();

  for (const row of rows || []) {
    const at = (field) => {
      const idx = mapping?.[field];
      return idx == null ? '' : (row[idx] ?? '');
    };

    const kind = classify(at('side'));

    if (kind === 'option') { skipped.options++; continue; }

    if (kind === 'income') {
      const date = parseDate(at('date'));
      const symbol = String(at('symbol') || '').trim().toUpperCase();
      const amount = parseMoney(at('amount'));
      if (date && symbol && Number.isFinite(amount) && amount !== 0) {
        income.push({
          date,
          t: utcDay(date),
          symbol,
          code: String(at('side') || '').trim().toUpperCase(),
          amount,
        });
        continue;
      }
      // Interest and the like with no ticker can't be attributed to a
      // position, so they're counted but not credited to any return.
      skipped.accountLevelIncome++;
      continue;
    }

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
          // The raw cell matters: a trailing 'S' ("46S") marks shares
          // surrendered rather than received, which is the only thing
          // distinguishing the two sides of a share exchange.
          quantityRaw: String(at('quantity') || '').trim(),
        });
        continue;
      }
      // A reorg row with no ticker is the cash side of an account conversion.
      // It carries no position information but does move money, so it belongs
      // in the ledger or the cash balance won't reconcile.
      const code = String(at('side') || '').trim();
      const amount = parseMoney(at('amount'));
      if (date && Number.isFinite(amount) && amount !== 0) {
        otherCash.push({ date, t: utcDay(date), code: code.toUpperCase(), amount });
        continue;
      }
      skipped.nonTrade++;
      if (code) nonTradeCodes.set(code, (nonTradeCodes.get(code) || 0) + 1);
      continue;
    }

    if (!kind) {
      // Cash rows that aren't trades still matter: transfers define what you
      // actually put in, and fees/promos are needed to reconcile the cash
      // balance that forms part of the portfolio's ending value.
      const date = parseDate(at('date'));
      const amount = parseMoney(at('amount'));
      const code = String(at('side') || '').trim();
      if (date && Number.isFinite(amount) && amount !== 0) {
        const entry = { date, t: utcDay(date), code: code.toUpperCase(), amount };
        if (TRANSFER_CODES.has(norm(code))) transfers.push(entry);
        else otherCash.push(entry);
        continue;
      }
      skipped.nonTrade++;
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
  income.sort((a, b) => a.t - b.t);
  transfers.sort((a, b) => a.t - b.t);
  otherCash.sort((a, b) => a.t - b.t);

  return {
    trades,
    corporateActions,
    income,
    transfers,
    otherCash,
    // Objects, not [code, count] pairs: this is persisted to Firestore, which
    // rejects an array whose elements are arrays — and rejects the *whole*
    // document, so one nested array here silently kills every synced setting.
    skipped: {
      ...skipped,
      nonTradeCodes: [...nonTradeCodes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => ({ code, count })),
    },
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

/**
 * Merge dividend rows, by multiset like trades — a ticker really can pay two
 * identical amounts on one date (Alibaba does exactly this, an ordinary and a
 * special dividend of the same size), so a set would silently drop one.
 */
export function mergeIncome(existing, incoming) {
  const key = (r) => `${r.date}|${r.symbol}|${r.code}|${Number(r.amount).toFixed(4)}`;
  const counts = new Map();
  for (const r of existing || []) {
    const k = key(r);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const added = [];
  for (const r of incoming || []) {
    const k = key(r);
    const remaining = counts.get(k) || 0;
    if (remaining > 0) { counts.set(k, remaining - 1); continue; }
    added.push(r);
  }
  return [...(existing || []), ...added].sort((a, b) => a.t - b.t);
}

/**
 * Merge dated cash rows (transfers, fees) by multiset — two identical $5 Gold
 * fees in one month are two real charges, not a duplicate.
 */
export function mergeCashRows(existing, incoming) {
  const key = (r) => `${r.date}|${r.code}|${Number(r.amount).toFixed(2)}`;
  const counts = new Map();
  for (const r of existing || []) {
    const k = key(r);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const added = [];
  for (const r of incoming || []) {
    const k = key(r);
    const remaining = counts.get(k) || 0;
    if (remaining > 0) { counts.set(k, remaining - 1); continue; }
    added.push(r);
  }
  return [...(existing || []), ...added].sort((a, b) => a.t - b.t);
}

/** Restore the derived `t` on dated cash rows read back from storage. */
export function hydrateCashRows(rows) {
  return (rows || []).map(r => (
    Number.isFinite(r?.t) ? r : { ...r, t: utcDay(r?.date) }
  ));
}

/** Restore the derived `t` on income rows read back from storage. */
export function hydrateIncome(rows) {
  return (rows || []).map(r => (
    Number.isFinite(r?.t) ? r : { ...r, t: utcDay(r?.date) }
  ));
}

/**
 * Attribute each dividend to the lots that were actually holding the stock
 * when it paid, split pro-rata by cost basis.
 *
 * Exact per-share attribution would need the share count as of each pay date,
 * which splits make fiddly; cost basis among the lots open on that date is a
 * stable proxy and, more importantly, makes lot-level income sum exactly to
 * the ticker and portfolio totals.
 *
 * Returns a Map keyed by lot object, plus what couldn't be placed — a
 * dividend paid when the file shows no open lot (the position was bought
 * before the export's start) is reported rather than folded in somewhere
 * convenient.
 */
export function allocateIncome(lots, income) {
  const byLot = new Map();
  const bySymbol = new Map();

  for (const lot of [...(lots?.closed || []), ...(lots?.open || [])]) {
    byLot.set(lot, 0);
    // A basket lot answers to every ticker in the group — both the ones it
    // still holds and the one it was originally bought as, since dividends
    // were paid under each name at different times.
    const keys = lot.basket
      ? new Set([...Object.keys(lot.basket), ...(lot.basketMembers || [])])
      : new Set([lot.symbol]);
    for (const key of keys) {
      if (!bySymbol.has(key)) bySymbol.set(key, []);
      bySymbol.get(key).push(lot);
    }
  }

  let allocated = 0;
  let unallocated = 0;
  const unallocatedSymbols = new Set();
  // Dated cash flows for the money-weighted return — a dividend paid in 2021
  // is worth more than the same dollars paid today.
  const flows = [];

  for (const row of hydrateIncome(income)) {
    if (!Number.isFinite(row.t) || !Number.isFinite(row.amount) || row.amount === 0) continue;

    // A lot holds the stock from its buy date until it is sold; open lots
    // never stop holding.
    const holders = (bySymbol.get(row.symbol) || []).filter(lot => (
      lot.buyT <= row.t && (lot.sellT == null || row.t <= lot.sellT)
    ));
    const basis = holders.reduce((s, l) => s + l.costBasis, 0);

    if (!holders.length || !(basis > 0)) {
      unallocated += row.amount;
      unallocatedSymbols.add(row.symbol);
      continue;
    }

    for (const lot of holders) {
      byLot.set(lot, byLot.get(lot) + row.amount * (lot.costBasis / basis));
    }
    allocated += row.amount;
    flows.push({ t: row.t, amount: row.amount });
  }

  return {
    byLot,
    flows,
    allocated,
    unallocated,
    unallocatedSymbols: [...unallocatedSymbols].sort(),
  };
}

// ── FIFO lot matching ───────────────────────────────────────────────────

/** Every ticker that appears in a buy or sell row. */
export function tradedSymbols(trades) {
  return [...new Set((trades || []).map(t => t.symbol).filter(Boolean))].sort();
}

/**
 * Restore the derived `t` timestamp on trades read back from storage.
 *
 * `t` is deliberately not persisted — it's recoverable from `date` and would
 * only bloat the synced document. Everything downstream sorts and prices on
 * it, so stored trades must pass through here before use.
 */
export function hydrateTrades(trades) {
  return (trades || []).map(t => (
    Number.isFinite(t?.t) ? t : { ...t, t: utcDay(t?.date) }
  ));
}

/** Same, for corporate actions read back from storage. */
export function hydrateActions(actions) {
  return (actions || []).map(a => (
    Number.isFinite(a?.t) ? a : { ...a, t: utcDay(a?.date) }
  ));
}

/**
 * Reconstruct positions that survived a share exchange, spin-off or merger.
 *
 * A reorg moves cost basis between tickers using fair-market values the export
 * doesn't carry, so the basis can't be *split* across the resulting tickers.
 * But it doesn't need to be: what went in is known from the purchase rows, and
 * what came out is the whole basket of resulting shares. Held together as one
 * position, the comparison is exact — only the per-ticker breakdown is lost.
 *
 * Share counts follow the export's own convention: a quantity ending in 'S'
 * ("46S") is shares surrendered, anything else is shares received.
 *
 * Returns one entry per group of tickers linked by a reorg date.
 */
export function resolveReorgGroups(trades, actions, feedSplits) {
  const reorgs = (actions || []).filter(a => a.kind === 'reorg');
  if (!reorgs.length) return [];

  // Tickers touched by reorg events on the same date belong together.
  const byDate = new Map();
  for (const a of reorgs) {
    if (!byDate.has(a.date)) byDate.set(a.date, new Set());
    byDate.get(a.date).add(a.symbol);
  }
  // A ticker appearing on two reorg dates merges those groups.
  const groupOf = new Map();
  const groups = [];
  for (const symbols of byDate.values()) {
    const existing = [...symbols].map(s => groupOf.get(s)).find(g => g != null);
    const target = existing ?? groups.push(new Set()) - 1;
    for (const s of symbols) {
      groups[target].add(s);
      groupOf.set(s, target);
    }
  }

  return groups.map((memberSet) => {
    const members = [...memberSet].sort();
    const memberTrades = (trades || []).filter(t => memberSet.has(t.symbol));
    const buys = memberTrades.filter(t => t.side === 'buy');
    const sells = memberTrades.filter(t => t.side === 'sell');

    const base = { members, shares: {}, lots: [], totalCost: 0 };

    if (!buys.length) {
      return { ...base, resolvable: false, reason: 'no purchase in this file to price it from' };
    }
    if (sells.length) {
      // Matching a sale to a basis that has itself been reallocated across
      // tickers is exactly the ambiguity this avoids.
      return { ...base, resolvable: false, reason: 'sold after the reorganisation, so the basis split matters' };
    }

    // Replay every event in order and carry the share counts through.
    const events = [];
    for (const t of memberTrades) events.push({ t: t.t, order: 0, trade: t });
    for (const a of reorgs) {
      if (memberSet.has(a.symbol)) events.push({ t: a.t, order: 1, action: a });
    }
    // Price feeds model a spin-off as a split-like price adjustment on the
    // reorganisation date (Yahoo reports Brookfield's 2022 exchange as
    // 1237:1000). The export's own SXCH/SOFF rows already move those shares,
    // so honouring both would count the reorganisation twice.
    const reorgDates = new Set(reorgs.filter(a => memberSet.has(a.symbol)).map(a => a.date));
    for (const symbol of members) {
      for (const s of (feedSplits?.[symbol] || [])) {
        if (reorgDates.has(s.date)) continue;
        const t = utcDay(s.date);
        if (Number.isFinite(t) && s.ratio > 0) events.push({ t, order: 2, split: { symbol, ratio: s.ratio } });
      }
    }
    events.sort((a, b) => a.t - b.t || a.order - b.order);

    const shares = {};
    for (const ev of events) {
      if (ev.trade) {
        shares[ev.trade.symbol] = (shares[ev.trade.symbol] || 0) + ev.trade.quantity;
      } else if (ev.action) {
        const qty = ev.action.quantity;
        if (!Number.isFinite(qty)) {
          return { ...base, resolvable: false, reason: `unreadable quantity on ${ev.action.code}` };
        }
        // Direction lives only in the raw cell's trailing 'S'. Without it a
        // surrender reads as a receipt and the position doubles instead of
        // moving, so an import that predates this field must be refused
        // rather than guessed at.
        if (ev.action.quantityRaw == null || ev.action.quantityRaw === '') {
          return {
            ...base,
            resolvable: false,
            reason: 'this import predates share-exchange direction tracking — re-import to include it',
          };
        }
        const surrendered = /s\s*$/i.test(ev.action.quantityRaw);
        shares[ev.action.symbol] = (shares[ev.action.symbol] || 0) + (surrendered ? -qty : qty);
      } else if (ev.split) {
        shares[ev.split.symbol] = (shares[ev.split.symbol] || 0) * ev.split.ratio;
      }
    }

    // Tiny negatives are float noise; a real negative means the replay is wrong.
    for (const [symbol, qty] of Object.entries(shares)) {
      if (qty < -1e-6) {
        return { ...base, resolvable: false, reason: `share count for ${symbol} went negative` };
      }
      if (Math.abs(qty) < 1e-9) delete shares[symbol];
    }
    if (!Object.keys(shares).length) {
      return { ...base, resolvable: false, reason: 'nothing left after the reorganisation' };
    }

    const totalCost = buys.reduce((s, t) => s + t.amount, 0);
    return {
      members,
      resolvable: true,
      reason: null,
      shares,
      label: Object.keys(shares).sort().join(' + '),
      lots: buys.map(t => ({ buyT: t.t, buyDate: t.date, costBasis: t.amount })),
      totalCost,
    };
  });
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
export function buildLots(rawTrades, corporateActions, apiSplits) {
  // Defensive: stored trades arrive without the derived timestamp, and a
  // missing one poisons both the event ordering and every price lookup.
  const trades = hydrateTrades(rawTrades).filter(t => Number.isFinite(t.t));
  const actions = hydrateActions(corporateActions);
  const feed = apiSplits || {};

  // Reorg tickers can't be measured individually, but a group whose purchases
  // are all in the file can be measured as a single combined position.
  const reorgGroups = resolveReorgGroups(trades, actions, feed);
  const excluded = new Map();
  for (const a of actions) {
    if (a.kind !== 'reorg') continue;
    const group = reorgGroups.find(g => g.members.includes(a.symbol));
    if (group?.resolvable) continue; // handled as a basket below
    if (!excluded.has(a.symbol)) excluded.set(a.symbol, new Set());
    excluded.get(a.symbol).add(a.code);
  }
  // A resolvable group's own trades are represented by its basket lots, so
  // they must not also flow through the per-symbol FIFO engine.
  const basketSymbols = new Set(
    reorgGroups.filter(g => g.resolvable).flatMap(g => g.members),
  );

  // Feed splits win; fall back to the file's SPL rows only where the feed
  // returned nothing for that symbol, so the two can never double-count.
  const splitsBySymbol = new Map();
  for (const symbol of tradedSymbols(trades)) {
    if (excluded.has(symbol) || basketSymbols.has(symbol)) continue;
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
    if (excluded.has(t.symbol) || basketSymbols.has(t.symbol)) continue;
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
        // Kept so the lot table can show what was actually bought on the day
        // alongside the split-adjusted figures.
        lot.splitFactor = (lot.splitFactor || 1) * factor;
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
        splitFactor: lot.splitFactor || 1,
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
        splitFactor: lot.splitFactor || 1,
      });
    }
  }

  // A resolvable reorg group becomes one open position per original purchase.
  // Each carries the whole resulting share basket plus its share of the cost,
  // so the group's value can be priced without splitting basis between tickers.
  for (const group of reorgGroups) {
    if (!group.resolvable || !(group.totalCost > 0)) continue;
    for (const lot of group.lots) {
      open.push({
        symbol: group.label,
        quantity: null,
        buyT: lot.buyT,
        buyDate: lot.buyDate,
        costBasis: lot.costBasis,
        basket: group.shares,
        basketWeight: lot.costBasis / group.totalCost,
        basketMembers: group.members,
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
    reorgGroups,
    excludedSymbols: [...excluded.entries()].map(([symbol, codes]) => ({
      symbol,
      codes: [...codes].sort(),
    })).sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };
}
