/* Splitwise's monthly "Your balance for <Month>" email → a month's summary.

   The email is a teaser, not a statement: it lists the four biggest balances
   ("Plus 5 more friends »") and the four largest expenses, so what's parsed
   here is exactly that and no more — `moreFriends` records how much was left
   out rather than pretending the list is complete.

   Shared by api/amazon-email.js (the Gmail script posts these alongside the
   Amazon mail) and the Splitwise page's paste box, so both read an email the
   same way. Works on plain text: Gmail's getPlainBody(), or what a person
   copies out of the rendered email. */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = MONTHS.map(m => m.slice(0, 3));

const MONEY = /\$\s?([\d,]+(?:\.\d{1,2})?)/;
const toNumber = s => Math.round(Number(String(s).replace(/,/g, '')) * 100) / 100;
const pad = n => String(n).padStart(2, '0');

/** True for the monthly summary — not for Splitwise's per-expense mail. */
export function isSplitwiseSummaryEmail({ subject = '', from = '', body = '' } = {}) {
  const fromSplitwise = /splitwise/i.test(from) || /splitwise/i.test(body.slice(0, 400));
  const text = `${subject}\n${body.slice(0, 600)}`;
  return fromSplitwise && /your balance for\s+[a-z]+/i.test(text);
}

function lines(body) {
  return String(body || '')
    .replace(/<https?:[^>]*>|\(https?:[^)]*\)|https?:\/\/\S+/gi, ' ')
    .split(/\r?\n/)
    .map(l => l.replace(/\s+/g, ' ').replace(/\s*»\s*$/, '').trim())
    .filter(Boolean);
}

/** Which month the summary is for. The email names the month but not the year,
 *  so the year comes from when it was sent: the October summary arriving in
 *  November is that year's, the December one arriving in January is last
 *  year's. */
function summaryMonth(text, sentAt) {
  const m = /your balance for\s+([a-z]+)(?:\s+(\d{4}))?/i.exec(text);
  if (!m) return null;
  const idx = MONTHS.indexOf(m[1].toLowerCase());
  if (idx < 0) return null;
  if (m[2]) return `${m[2]}-${pad(idx + 1)}`;
  const sent = sentAt ? new Date(sentAt) : new Date();
  const ref = Number.isNaN(sent.getTime()) ? new Date() : sent;
  const year = idx > ref.getMonth() ? ref.getFullYear() - 1 : ref.getFullYear();
  return `${year}-${pad(idx + 1)}`;
}

/** "you owe $32.80" → -32.8, "owes you $26.02" / "you are owed $54" → +. */
function signedAmount(line) {
  const money = MONEY.exec(line);
  if (!money) return null;
  const n = toNumber(money[1]);
  if (/\byou owe\b/i.test(line)) return -n;
  if (/owes you|you are owed/i.test(line)) return n;
  return null;
}

const BALANCE_LINE = /^(?:(.*?)\s+)?(you owe|owes you|you are owed)\s+\$\s?[\d,]+(?:\.\d{1,2})?$/i;

export function parseSplitwiseEmail({ subject = '', date = '', body = '' } = {}) {
  const all = lines(body);
  const month = summaryMonth(`${subject}\n${all.slice(0, 12).join('\n')}`, date);
  if (!month) return { ok: false, reason: 'no "Your balance for <month>" heading' };

  const totalAt = all.findIndex(l => /^total balance\b/i.test(l));
  const expensesAt = all.findIndex(l => /^largest expenses\b/i.test(l));
  if (totalAt < 0 && expensesAt < 0) return { ok: false, reason: 'no balances or expenses section' };

  // ── Balances: "Total balance" up to "Largest expenses". A friend is a name
  // line followed by an amount line, or both on one line.
  let totalBalance = null;
  const friends = [];
  let moreFriends = 0;
  if (totalAt >= 0) {
    const end = expensesAt > totalAt ? expensesAt : all.length;
    let pendingName = null;
    for (let i = totalAt; i < end; i++) {
      let l = all[i];
      const more = /^plus\s+(\d+)\s+more\s+friends?/i.exec(l);
      if (more) { moreFriends = Number(more[1]); continue; }
      if (/settled up/i.test(l) && totalBalance == null) { totalBalance = 0; continue; }
      if (i === totalAt) {
        l = l.replace(/^total balance\s*/i, '');
        if (!l) continue;
      }
      const m = BALANCE_LINE.exec(l);
      if (!m) { pendingName = l; continue; }
      const amount = signedAmount(l);
      if (totalBalance == null && !m[1] && pendingName == null) {
        // The first nameless amount after "Total balance" is the total.
        totalBalance = amount;
        continue;
      }
      const name = (m[1] || pendingName || '').trim();
      if (name) friends.push({ name, amount });
      pendingName = null;
    }
  }

  // ── Largest expenses: "Oct." "27" "Settle all balances" "you lent $2,686.92",
  // each piece on its own line or run together.
  const expenses = [];
  if (expensesAt >= 0) {
    const [yearStr, monthStr] = month.split('-');
    let cur = null;
    for (let i = expensesAt + 1; i < all.length; i++) {
      let l = all[i];
      if (/^see all transactions|^visit splitwise|^p\.s\./i.test(l)) break;
      const head = /^([A-Za-z]{3})\.?\s*(?:(\d{1,2})(?!\d))?\s*(.*)$/.exec(l);
      const abbr = head ? MONTH_ABBR.indexOf(head[1].toLowerCase()) : -1;
      if (abbr >= 0 && (head[2] || l.length <= 5)) {
        // An expense from late last month can appear in this month's list.
        const year = abbr + 1 > Number(monthStr) + 1 ? Number(yearStr) - 1 : Number(yearStr);
        cur = { month: abbr + 1, year, day: head[2] ? Number(head[2]) : null, description: [] };
        // "Oct. 23 Winter Storage you borrowed $448.00" — the rest of the line
        // is read like any other line of the expense.
        l = head[3];
        if (!l) continue;
      }
      if (!cur) continue;
      if (cur.day == null && /^\d{1,2}$/.test(l)) { cur.day = Number(l); continue; }
      const amt = /\byou\s+(lent|borrowed|paid|received)\s+\$\s?([\d,]+(?:\.\d{1,2})?)/i.exec(l);
      if (amt) {
        const before = l.slice(0, amt.index).trim();
        if (before) cur.description.push(before);
        const description = cur.description.join(' ').trim() || 'Expense';
        expenses.push({
          date: `${cur.year}-${pad(cur.month)}-${pad(cur.day || 1)}`,
          description,
          direction: amt[1].toLowerCase(),
          amount: toNumber(amt[2]),
          settlement: /settle|payment/i.test(description),
        });
        cur = null;
        continue;
      }
      cur.description.push(l);
    }
  }

  return { ok: true, summary: { month, totalBalance, friends, moreFriends, expenses } };
}

/** "2026-10" → "October 2026". */
export function monthLabel(month) {
  const [y, m] = String(month || '').split('-').map(Number);
  if (!y || !m) return String(month || '');
  return `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${y}`;
}
