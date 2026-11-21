/* HSA activity pasted from the HSA provider's website.

   Providers lay their activity out differently (HealthEquity, Fidelity,
   Optum, HSA Bank…): a signed Amount column, or separate Withdrawal/Deposit
   columns, sometimes a Type column, sometimes no header row at all when only
   a few rows are copied. So the parser looks for a header it recognises and
   falls back to reading each line for a date and a dollar figure.

   Every row becomes { id, date: 'YYYY-MM-DD', description, amount, kind }
   where amount is signed (money in is positive) and kind is one of
   contribution / spending / other. "Other" holds what is neither: interest,
   dividends, moves between the cash and invested sides, fees. */

export const HSA_KINDS = ['contribution', 'spending', 'other'];

/* IRS annual contribution limits (employee + employer combined). The 55+
   catch-up adds $1,000 on top. */
export const HSA_LIMITS = {
  2024: { self: 4150, family: 8300 },
  2025: { self: 4300, family: 8550 },
  2026: { self: 4400, family: 8750 },
};
export const HSA_CATCH_UP = 1000;

export function hsaLimit(year, coverage = 'self', catchUp = false) {
  const known = Object.keys(HSA_LIMITS).map(Number).sort((a, b) => a - b);
  const y = HSA_LIMITS[year] ? year : known.filter(k => k <= year).pop() ?? known[0];
  const base = HSA_LIMITS[y][coverage === 'family' ? 'family' : 'self'];
  return base + (catchUp ? HSA_CATCH_UP : 0);
}

/* Split one line into cells: tabs when there are any (a copied web table),
   otherwise CSV with quoted fields. */
function splitLine(line) {
  if (line.includes('\t')) return line.split('\t').map(s => s.trim());
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

/* 'YYYY-MM-DD' from the common ways a date is written, or null. */
export function parseHsaDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${pad(m[1])}-${pad(m[2])}`;
  }
  m = t.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`;
  return null;
}

/* A signed number from '$1,234.56', '-$20.00', '($20.00)', '20.00 CR', or null. */
export function parseHsaMoney(s) {
  if (s == null) return null;
  let t = String(s).trim();
  if (!t || !/\d/.test(t)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/^[-−–]/.test(t) || /[-−–]\s*\$/.test(t)) neg = true;
  const m = t.replace(/,/g, '').match(/(\d+(?:\.\d+)?|\.\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return neg ? -n : n;
}

const HEADER = {
  date: /^(transaction |posted |post |effective )?date$|^date\b/i,
  description: /desc|memo|payee|merchant|details|name|transaction$/i,
  type: /^(transaction )?type$|^category$|^activity$/i,
  amount: /^(transaction )?amount$|^amount\b/i,
  debit: /withdraw|debit|distribution|payment|money out|^out$/i,
  credit: /deposit|credit|contribution|money in|^in$/i,
};

function findColumns(cells) {
  const cols = {};
  cells.forEach((c, i) => {
    const h = c.toLowerCase();
    if (!h) return;
    if (cols.date == null && HEADER.date.test(h)) { cols.date = i; return; }
    if (cols.amount == null && HEADER.amount.test(h)) { cols.amount = i; return; }
    if (cols.debit == null && HEADER.debit.test(h)) { cols.debit = i; return; }
    if (cols.credit == null && HEADER.credit.test(h)) { cols.credit = i; return; }
    if (cols.type == null && HEADER.type.test(h)) { cols.type = i; return; }
    if (cols.description == null && HEADER.description.test(h)) { cols.description = i; return; }
  });
  const hasMoney = cols.amount != null || cols.debit != null || cols.credit != null;
  return cols.date != null && hasMoney ? cols : null;
}

/* Which bucket a row belongs in, from its words first and its sign second. */
export function classifyHsa(description, amount) {
  const d = (description || '').toLowerCase();
  if (/interest|dividend|earning|capital gain/.test(d)) return 'other';
  if (/invest|sweep|transfer (to|from)|buy|sell|purchase of|redemption|rebalanc|mutual fund/.test(d)) return 'other';
  if (/\bfee\b|fees|maintenance/.test(d)) return 'other';
  if (/contribution|payroll|employer|employee|deposit|rollover|hsa funding/.test(d)) return amount < 0 ? 'other' : 'contribution';
  if (/distribution|withdraw|payment|claim|reimburs|card purchase|debit card|pharmacy|medical|dental|vision/.test(d)) return amount > 0 ? 'other' : 'spending';
  return amount >= 0 ? 'contribution' : 'spending';
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/* Ids that survive pasting the same rows again: date, cents and description,
   plus a counter so two genuinely identical rows on one day stay two rows. */
function assignIds(rows) {
  const seen = new Map();
  return rows.map(r => {
    const base = `${r.date}|${Math.round(r.amount * 100)}|${norm(r.description)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { ...r, id: n === 1 ? base : `${base}#${n}` };
  });
}

/* Rows copied without a header: a date, words, then money figures. The first
   figure is the transaction; a later one is usually a running balance. */
const DATE_AT_START = /^\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3}[a-z]*\.?\s+\d{1,2},?\s+\d{4})/;
const MONEY = /\(?[-−–]?\s*\$\s*[\d,]*\d(?:\.\d{1,2})?\)?|\(?[-−–]?[\d,]*\d\.\d{2}\)?/g;
function parseLoose(lines) {
  const rows = [];
  for (const line of lines) {
    const dm = line.match(DATE_AT_START);
    if (!dm) continue;
    const date = parseHsaDate(dm[1]);
    if (!date) continue;
    const rest = line.slice(dm[0].length).replace(/\t/g, ' ');
    const money = [...rest.matchAll(MONEY)];
    if (!money.length) continue;
    const amount = parseHsaMoney(money[0][0]);
    if (amount == null || amount === 0) continue;
    const description = rest.slice(0, money[0].index).replace(/[,\s]+$/, '').replace(/\s+/g, ' ').trim();
    rows.push({ date, description, amount });
  }
  return rows;
}

/* Text pasted from the provider → { rows, skipped }. Each row is classified;
   `skipped` counts non-blank lines that weren't a transaction. */
export function parseHsaPaste(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  let headerAt = -1;
  let cols = null;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const c = findColumns(splitLine(lines[i]));
    if (c) { headerAt = i; cols = c; break; }
  }

  let raw;
  if (cols) {
    raw = [];
    for (const line of lines.slice(headerAt + 1)) {
      const cells = splitLine(line);
      const date = parseHsaDate(cells[cols.date]);
      if (!date) continue;
      let amount = null;
      if (cols.amount != null) amount = parseHsaMoney(cells[cols.amount]);
      if (amount == null || amount === 0) {
        const out = cols.debit != null ? parseHsaMoney(cells[cols.debit]) : null;
        const inn = cols.credit != null ? parseHsaMoney(cells[cols.credit]) : null;
        if (out) amount = -Math.abs(out);
        else if (inn) amount = Math.abs(inn);
      }
      if (amount == null || amount === 0) continue;
      const parts = [cols.type, cols.description].filter(i => i != null).map(i => cells[i]).filter(Boolean);
      raw.push({ date, description: [...new Set(parts)].join(' — '), amount });
    }
  } else {
    raw = parseLoose(lines);
  }

  const rows = assignIds(raw.map(r => ({
    ...r,
    amount: Math.round(r.amount * 100) / 100,
    kind: classifyHsa(r.description, r.amount),
  })));
  return { rows, skipped: lines.length - rows.length - (cols ? 1 : 0) };
}

/* Fold freshly pasted rows into what's stored. Existing rows keep their kind
   (the user may have re-labelled them); new ones are added. Newest first. */
export function mergeHsaRows(existing, incoming) {
  const byId = new Map((existing || []).map(r => [r.id, r]));
  let added = 0;
  for (const r of incoming) {
    if (byId.has(r.id)) continue;
    byId.set(r.id, r);
    added++;
  }
  const rows = [...byId.values()].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return { rows, added, duplicates: incoming.length - added };
}

/* Totals for a calendar year plus a month-by-month breakdown. Contributions
   and spending are both positive figures here. */
export function summarizeHsa(rows, year) {
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, contributions: 0, spending: 0, other: 0 }));
  let contributions = 0;
  let spending = 0;
  let other = 0;
  for (const r of rows || []) {
    if (Number(r.date.slice(0, 4)) !== year) continue;
    const m = months[Number(r.date.slice(5, 7)) - 1];
    if (r.kind === 'contribution') { contributions += r.amount; m.contributions += r.amount; }
    else if (r.kind === 'spending') { spending += -r.amount; m.spending += -r.amount; }
    else { other += r.amount; m.other += r.amount; }
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    year,
    contributions: r2(contributions),
    spending: r2(spending),
    other: r2(other),
    net: r2(contributions - spending + other),
    months: months.map(m => ({ ...m, contributions: r2(m.contributions), spending: r2(m.spending), other: r2(m.other) })),
  };
}

export function hsaYears(rows) {
  return [...new Set((rows || []).map(r => Number(r.date.slice(0, 4))))].sort((a, b) => b - a);
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* The last `count` full calendar months before `today`, oldest first, as
   { key: 'YYYY-MM', label: 'October 2026' }. The current month isn't
   included — it's still in progress, so it isn't "missing" yet. */
export function pastFullMonths(today = new Date(), count = 2) {
  const out = [];
  for (let i = count; i >= 1; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    out.push({ key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}` });
  }
  return out;
}

/* Alerts for the Cards page's Alerts tab. One alert when any of the past two
   full months has no HSA rows at all — the usual sign that the latest
   activity hasn't been pasted in. Returns [] when everything is current. */
export function hsaAlerts(rows, today = new Date()) {
  const have = new Set((rows || []).map(r => r.date.slice(0, 7)));
  const missing = pastFullMonths(today, 2).filter(m => !have.has(m.key));
  if (!missing.length) return [];
  const latest = (rows || []).reduce((max, r) => (r.date > max ? r.date : max), '');
  return [{
    id: 'hsa-missing-months',
    source: 'hsa',
    title: `HSA data missing for ${missing.map(m => m.label).join(' and ')}`,
    detail: latest
      ? `The newest HSA transaction is from ${latest}. Paste the latest activity from your HSA provider on the HSA tab.`
      : 'No HSA activity has been pasted in yet. Paste it from your HSA provider on the HSA tab.',
    missing: missing.map(m => m.key),
  }];
}
