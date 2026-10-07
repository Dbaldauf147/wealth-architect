/* Audit a card statement against the ledger: what the sheet says should be on
   the statement ("expected") versus what the issuer actually billed.

   Two inputs, both reduced to the same line shape before they meet:

     • the statement — a CSV export (parseStatementCsv) or the text of a PDF
       statement (parseStatementText; the page does the PDF → text step), and
     • the ledger — the sheet's transactions for that card, inside the
       statement's period.

   Every line is { date: Date, description, amount } in the *ledger's* sign
   convention: a charge is negative, a payment or refund positive. Issuers print
   charges positive, so the parsers flip them on the way in and nothing
   downstream has to remember which side a number came from.

   Matching is deliberately forgiving about dates and strict about cents. The
   sheet's date and the statement's can disagree by a few days (transaction vs.
   posting date), but an amount that's off by a cent is a real difference — a
   tip added after the fact, a currency conversion — and is reported as one.

   Pure: no React, no DOM, no network. */

const DAY = 86400000;
// How far apart the sheet's date and the statement's can be and still be the
// same charge. Posting lag is usually 1–3 days; a weekend makes it 4.
const MATCH_DAYS = 4;
// A same-merchant pair this close together with different amounts is reported
// as "amount differs" rather than as one missing and one unexpected charge.
const NEAR_DAYS = 3;

const cents = n => Math.round(Number(n) * 100);
const round2 = n => Math.round(Number(n) * 100) / 100;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysApart = (a, b) => Math.abs(startOfDay(a) - startOfDay(b)) / DAY;

/** "$1,234.56", "(12.00)", "-12.00", "12.00-", "12.00 CR" → signed number, or null. */
export function parseMoney(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/\s*CR$/i.test(s)) { neg = true; s = s.replace(/\s*CR$/i, ''); }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  if (/^[-−–]/.test(s)) { neg = !neg; s = s.slice(1); }
  s = s.replace(/^\+/, '').replace(/[$,\s]/g, '');
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** "9/3/2026", "09/03/26", "2026-09-03" → local Date, or null. A date with no
 *  year takes `yearFor(month, day)` when given. */
export function parseDate(raw, yearFor) {
  const s = String(raw ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(new Date(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  let y = m[3] ? +m[3] : (yearFor ? yearFor(+m[1], +m[2]) : null);
  if (y == null) return null;
  if (y < 100) y += 2000;
  return valid(new Date(y, +m[1] - 1, +m[2]));
}
function valid(d) { return isNaN(d) ? null : d; }

// ── CSV ────────────────────────────────────────────────────────────────────

/** RFC-4180-ish: quoted fields, doubled quotes, CRLF. */
export function splitCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const text0 = String(text || '');
  const src = text0.charCodeAt(0) === 0xfeff ? text0.slice(1) : text0; // byte-order mark
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim())) rows.push(row);
  return rows;
}

const findCol = (headers, patterns) => {
  for (const p of patterns) {
    const i = headers.findIndex(h => p.test(h));
    if (i >= 0) return i;
  }
  return -1;
};

/**
 * A card's transaction export: Chase ("Transaction Date, Post Date,
 * Description, Category, Type, Amount, Memo"), Amex, Citi's Debit/Credit
 * columns, or anything with a date, a description and an amount.
 * @returns { lines, period: null, last4: null, warnings: string[] }
 */
export function parseStatementCsv(text) {
  const rows = splitCsv(text);
  const warnings = [];
  // The header is the first row naming both a date and an amount — some banks
  // put a few lines of account details above it.
  const hi = rows.findIndex(r => {
    const h = r.map(c => c.trim().toLowerCase());
    return h.some(c => /date/.test(c)) && h.some(c => /amount|debit|credit/.test(c));
  });
  if (hi < 0) return { lines: [], period: null, last4: null, warnings: ['No header row with a date and an amount column was found.'] };
  const headers = rows[hi].map(c => c.trim().toLowerCase());
  const dateCol = findCol(headers, [/^trans(action)?\.? ?date/, /^date$/, /date/]);
  const descCol = findCol(headers, [/^description$/, /description/, /merchant|payee|name/]);
  const amtCol = findCol(headers, [/^amount$/, /amount/]);
  const debitCol = findCol(headers, [/debit/]);
  const creditCol = findCol(headers, [/credit/]);
  const typeCol = findCol(headers, [/^type$/, /transaction type/]);

  const parsed = [];
  for (const r of rows.slice(hi + 1)) {
    const date = parseDate(r[dateCol]);
    if (!date) continue;
    let amount;
    if (amtCol >= 0) amount = parseMoney(r[amtCol]);
    else {
      const debit = parseMoney(r[debitCol]) || 0;
      const credit = parseMoney(r[creditCol]) || 0;
      // Debit/Credit columns are already sided: a debit is a charge.
      amount = round2(Math.abs(credit) - Math.abs(debit));
    }
    if (amount == null || amount === 0) continue;
    parsed.push({ date, description: (r[descCol] || '').trim(), amount, type: typeCol >= 0 ? (r[typeCol] || '').trim() : '' });
  }

  // A single Amount column comes in either convention. Chase exports charges
  // negative (as the ledger does), Amex positive. Purchases outnumber
  // payments on any card statement, so whichever sign most rows carry is the
  // charge sign — unless a Type column says outright which rows are sales.
  if (amtCol >= 0 && parsed.length) {
    const sales = parsed.filter(p => /sale|purchase|debit/i.test(p.type));
    const sample = sales.length ? sales : parsed;
    const positive = sample.filter(p => p.amount > 0).length;
    if (positive > sample.length / 2) for (const p of parsed) p.amount = -p.amount;
  }
  if (!parsed.length) warnings.push('The file has a header row but no transaction rows could be read.');
  return { lines: parsed.map(({ date, description, amount }) => ({ date, description, amount })), period: null, last4: null, warnings };
}

// ── PDF text ─────────────────────────────────────────────────────────────

const DATE_TOKEN = String.raw`\d{1,2}/\d{1,2}(?:/\d{2,4})?`;
// date [post-date] description amount — the amount last on the line, as every
// issuer prints the activity table. A trailing "-" or "CR" marks a credit.
const ACTIVITY_LINE = new RegExp(String.raw`^(${DATE_TOKEN})\s+(?:(${DATE_TOKEN})\s+)?(.+?)\s+(-?\$?[\d,]*\d\.\d{2}(?:-|\s?CR)?)$`, 'i');
const PERIOD = new RegExp(String.raw`(\d{1,2}/\d{1,2}/\d{2,4})\s*(?:-|–|—|to|through|thru)\s*(\d{1,2}/\d{1,2}/\d{2,4})`, 'i');

/**
 * The text of a PDF statement, one printed line per line. Reads the billing
 * period, the card's last four digits and the activity table.
 * @returns { lines, period: { start, end } | null, last4, summary, warnings }
 *   summary is the issuer's own totals where it printed them
 *   ({ purchases?, credits?, fees?, interest? }, statement sign = positive),
 *   used to check that the parse caught every line.
 */
export function parseStatementText(text) {
  const raw = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const warnings = [];

  let period = null;
  // Prefer a range on a line that says what it is; fall back to the first.
  const periodLine = raw.find(l => PERIOD.test(l) && /opening|closing|billing|statement|period|cycle/i.test(l))
    || raw.find(l => PERIOD.test(l));
  if (periodLine) {
    const m = periodLine.match(PERIOD);
    const start = parseDate(m[1]);
    const end = parseDate(m[2]);
    if (start && end && start <= end) period = { start, end };
  }

  let last4 = null;
  for (const l of raw) {
    const m = l.match(/(?:account|card)\s*(?:number|no\.?|#)?\s*(?:ending\s*(?:in)?)?\s*:?\s*(?:[x*•]{4}[\s-]*){2,3}(\d{4})\b/i)
      || l.match(/ending\s+in\s+(\d{4})\b/i);
    if (m) { last4 = m[1]; break; }
  }

  // A MM/DD with no year belongs to the period's year — or the year before,
  // when a period straddling New Year puts a December date in a January close.
  const yearFor = (month, day) => {
    if (!period) return new Date().getFullYear();
    const y = period.end.getFullYear();
    const d = new Date(y, month - 1, day);
    return d > new Date(period.end.getTime() + 7 * DAY) ? y - 1 : y;
  };

  const lines = [];
  for (const l of raw) {
    const m = l.match(ACTIVITY_LINE);
    if (!m) continue;
    const date = parseDate(m[1], yearFor);
    const statementAmount = parseMoney(m[4]);
    if (!date || statementAmount == null || statementAmount === 0) continue;
    // A second leading date is the posting date; a reference number or the
    // card's last four can sit between description and amount on some
    // issuers — strip a trailing run of digits so the description reads clean.
    const description = m[3].replace(/(\s+\d{4,})+$/, '').trim();
    // Running-balance and totals lines can start with a date too.
    if (/^(new |previous )?balance\b|^total\b/i.test(description)) continue;
    lines.push({ date, description, amount: -statementAmount });
  }

  const summary = {};
  const grab = (key, re) => {
    for (const l of raw) {
      const m = l.match(re);
      if (m) { const v = parseMoney(m[1]); if (v != null) { summary[key] = Math.abs(v); return; } }
    }
  };
  grab('purchases', /^purchases\s+\+?\s*(\$?[\d,]+\.\d{2})$/i);
  grab('credits', /^payments?,?\s*(?:and\s*)?(?:other\s*)?credits\s+[-−]?\s*(\$?[\d,]+\.\d{2})$/i);
  grab('fees', /^fees charged\s+\+?\s*(\$?[\d,]+\.\d{2})$/i);
  grab('interest', /^interest charged\s+\+?\s*(\$?[\d,]+\.\d{2})$/i);

  if (!lines.length) warnings.push('No transaction lines were recognised in this PDF. A scanned (image-only) statement has no text to read — try the CSV download instead.');
  return { lines, period, last4, summary, warnings };
}

/** Charges and credits the parsed lines add up to, in statement sign, beside
 *  the totals the issuer printed. `ok` is null when there's nothing to check. */
export function checkAgainstSummary(lines, summary = {}) {
  const charged = round2(-lines.filter(l => l.amount < 0).reduce((s, l) => s + l.amount, 0));
  const credited = round2(lines.filter(l => l.amount > 0).reduce((s, l) => s + l.amount, 0));
  const printedCharges = summary.purchases != null
    ? round2((summary.purchases || 0) + (summary.fees || 0) + (summary.interest || 0))
    : null;
  const printedCredits = summary.credits != null ? round2(summary.credits) : null;
  const checks = [];
  if (printedCharges != null) checks.push(cents(printedCharges) === cents(charged));
  if (printedCredits != null) checks.push(cents(printedCredits) === cents(credited));
  return { charged, credited, printedCharges, printedCredits, ok: checks.length ? checks.every(Boolean) : null };
}

// ── Matching ─────────────────────────────────────────────────────────────

const STOP = new Set(['the', 'and', 'com', 'www', 'inc', 'llc', 'pos', 'purchase', 'debit', 'card', 'payment', 'online']);
function tokens(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter(w => w.length >= 3 && !STOP.has(w)));
}

/** 0–1: how much of the shorter description's words appear in the other. */
export function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w) || [...B].some(v => v.startsWith(w) || w.startsWith(v))) hit++;
  return hit / Math.min(A.size, B.size);
}

function ledgerDate(t) {
  if (t._date instanceof Date) return t._date;
  const s = String(t.date || '');
  return parseDate(s) || valid(new Date(s));
}

/**
 * @param statementLines  [{ date, description, amount }] (ledger sign)
 * @param transactions    the ledger, already narrowed to the card's account
 * @param period          { start, end } — the statement's cycle
 * @returns {
 *   matched:    [{ statement, ledger, dayGap }],
 *   differs:    [{ statement, ledger, delta }],   same charge, different amount
 *   missing:    [statement line]   on the statement, not in the sheet
 *   unexpected: [ledger txn]       in the sheet for this period, not billed
 *   totals:     { statement, expected, difference, statementCharges, expectedCharges }
 * }
 */
export function auditStatement({ statementLines, transactions, period }) {
  const start = startOfDay(period.start);
  const end = startOfDay(period.end);
  const lo = new Date(start.getTime() - MATCH_DAYS * DAY);
  const hi = new Date(end.getTime() + MATCH_DAYS * DAY);

  const stmt = (statementLines || []).map((s, i) => ({ ...s, _i: i }));
  // Candidates reach a few days past each edge so a charge the sheet dated
  // the day before the period still finds its statement line — but only the
  // ones inside the period are reported when nothing claims them.
  const ledger = (transactions || [])
    .map(t => ({ t, date: ledgerDate(t), amount: Number(t.amount) }))
    .filter(x => x.date && x.amount && x.date >= lo && x.date <= hi);

  const usedS = new Set();
  const usedL = new Set();
  const desc = x => `${x.t.description || ''} ${x.t.fullDescription || ''}`;

  // Pass 1: same cents, within the posting-lag window. Every candidate pair is
  // scored and taken best-first, so two $15.00 charges a week apart each claim
  // the statement line nearest them rather than whichever was read first.
  const pairs = [];
  stmt.forEach((s, si) => ledger.forEach((l, li) => {
    if (cents(s.amount) !== cents(l.amount)) return;
    const gap = daysApart(s.date, l.date);
    if (gap > MATCH_DAYS) return;
    pairs.push({ si, li, gap, sim: similarity(s.description, desc(l)) });
  }));
  pairs.sort((a, b) => a.gap - b.gap || b.sim - a.sim);
  const matched = [];
  for (const p of pairs) {
    if (usedS.has(p.si) || usedL.has(p.li)) continue;
    usedS.add(p.si); usedL.add(p.li);
    matched.push({ statement: stmt[p.si], ledger: ledger[p.li].t, dayGap: p.gap });
  }

  // Pass 2: the same merchant on (nearly) the same day for a different amount.
  const near = [];
  stmt.forEach((s, si) => {
    if (usedS.has(si)) return;
    ledger.forEach((l, li) => {
      if (usedL.has(li)) return;
      if (Math.sign(s.amount) !== Math.sign(l.amount)) return;
      const gap = daysApart(s.date, l.date);
      if (gap > NEAR_DAYS) return;
      const sim = similarity(s.description, desc(l));
      if (sim < 0.5) return;
      near.push({ si, li, gap, sim });
    });
  });
  near.sort((a, b) => b.sim - a.sim || a.gap - b.gap);
  const differs = [];
  for (const p of near) {
    if (usedS.has(p.si) || usedL.has(p.li)) continue;
    usedS.add(p.si); usedL.add(p.li);
    const s = stmt[p.si];
    const l = ledger[p.li];
    differs.push({ statement: s, ledger: l.t, delta: round2(s.amount - l.amount) });
  }

  const inPeriod = d => d >= start && d <= end;
  const missing = stmt.filter((_, i) => !usedS.has(i));
  const unexpected = ledger.filter((l, i) => !usedL.has(i) && inPeriod(l.date)).map(l => l.t);

  // "Expected" is what the sheet holds for the period plus whatever it dated
  // just outside it that the statement claimed — the same charges, counted
  // once, on the statement they actually landed on.
  const claimed = new Set([...matched, ...differs].map(m => m.ledger));
  const expectedTxns = ledger.filter(l => claimed.has(l.t) || inPeriod(l.date));
  const sum = xs => round2(xs.reduce((s, x) => s + x, 0));
  const stmtAmounts = stmt.map(s => s.amount);
  const expAmounts = expectedTxns.map(l => l.amount);
  const totals = {
    statement: sum(stmtAmounts),
    expected: sum(expAmounts),
    statementCharges: sum(stmtAmounts.filter(a => a < 0)),
    expectedCharges: sum(expAmounts.filter(a => a < 0)),
  };
  totals.difference = round2(totals.statement - totals.expected);

  const byDate = (a, b) => (a.date || ledgerDate(a)) - (b.date || ledgerDate(b));
  return {
    matched: matched.sort((a, b) => a.statement.date - b.statement.date),
    differs: differs.sort((a, b) => a.statement.date - b.statement.date),
    missing: missing.sort(byDate),
    unexpected: unexpected.sort((a, b) => ledgerDate(a) - ledgerDate(b)),
    totals,
  };
}

/** The period to audit when the statement didn't print one: the span of its
 *  own lines. */
export function periodOfLines(lines) {
  if (!lines?.length) return null;
  const ts = lines.map(l => startOfDay(l.date).getTime());
  return { start: new Date(Math.min(...ts)), end: new Date(Math.max(...ts)) };
}

/** Which of `accounts` the statement belongs to, by the last four digits on it. */
export function accountForLast4(last4, accounts, accountNumbers = {}) {
  if (!last4) return null;
  return accounts.find(a => String(accountNumbers[a] || '').endsWith(last4) || a.includes(last4)) || null;
}
