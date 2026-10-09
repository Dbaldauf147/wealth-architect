/* What's coming in and going out of your cash over the next few weeks, and
   which money pays for what.

   Three kinds of event, each projected from your own history:
     • paychecks — regular deposits in your income categories. A twice-a-month
       payer is two separate deposits (the 15th and the month end, say), each
       with its own usual day and amount, because they often differ;
     • card payments — each card's next payment, from the same schedule the
       reminder email uses (passed in);
     • bills paid straight from cash — monthly outflows from a cash account
       with a steady amount (rent by Zelle, say), which card payments don't
       cover.

   Then a plan: starting from cash on hand, events in date order, each
   outflow paid from the oldest money available — cash on hand first, then
   each paycheck as it lands — so every payment says what it's paid from, and
   a shortfall says how much and before which paycheck.

   Pure: no React, no DOM. */

import { payerKey, payerName, cadenceOf } from './income.js';

const DAY = 86400000;
const DEFAULT_INCOME = ['paycheck', 'income', 'tax refund/payment'];
const MOVING = new Set(['transfer', 'credit card payment', 'credit card payments', 'investments', 'retirement']);
// How many recent deposits decide the usual amount.
const RECENT = 3;
// A deposit smaller than this isn't a paycheck (dividends, interest, cashback).
const MIN_PAYCHECK = 100;
const round2 = n => Math.round(n * 100) / 100;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mode(xs) {
  const n = new Map();
  for (const x of xs) n.set(x, (n.get(x) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
}

function modeLatest(xs) {
  const n = new Map();
  for (const x of xs) n.set(x, (n.get(x) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
}

/** Payroll that falls on a weekend lands the Friday before. */
export function businessDayOnOrBefore(d) {
  const out = startOfDay(d);
  while (out.getDay() === 0 || out.getDay() === 6) out.setDate(out.getDate() - 1);
  return out;
}

/** A slot's date in a given month: a fixed day, or the month's last day. */
function slotDate(slot, y, m) {
  const day = slot.lastDay ? daysIn(y, m) : Math.min(slot.day, daysIn(y, m));
  return businessDayOnOrBefore(new Date(y, m, day));
}

/** How alike a set of amounts is, for "same every time" vs "varies". */
function steadiness(amounts) {
  const lo = Math.min(...amounts);
  const hi = Math.max(...amounts);
  const mid = median(amounts);
  return { lo: round2(lo), hi: round2(hi), same: hi - lo < 1, close: mid > 0 && (hi - lo) / mid <= 0.03 };
}

/** One deposit's amount history read for what's usual now: the last three
 *  (so a raise or a new deduction is picked up within a couple of months),
 *  whether the amount used to be fixed at a different level, and any one-off
 *  (a bonus) that the median leaves out. */
function readAmounts(rows) {
  // A bonus or back-pay is spotted against the plain median, then left out
  // of both the usual amount and the range quoted beside it.
  const base = median(rows.slice(-RECENT).map(r => r.amount));
  const outliers = rows.slice(-6).filter(r => r.amount > base * 1.5).map(r => ({ date: r.date, amount: round2(r.amount) }));
  const odd = new Set(outliers.map(o => o.date.getTime()));
  const clean = rows.filter(r => !odd.has(r.date.getTime()));
  const recent = (clean.length >= 2 ? clean : rows).slice(-RECENT);
  const amount = round2(median(recent.map(r => r.amount)));
  const steady = steadiness(recent.map(r => r.amount));
  // A run of identical deposits before the recent ones, at another level.
  let changedFrom = null;
  const earlier = clean.slice(0, -RECENT);
  if (earlier.length >= 2) {
    const tail = [];
    for (let i = earlier.length - 1; i >= 0 && Math.abs(earlier[i].amount - earlier[earlier.length - 1].amount) < 1; i--) tail.unshift(earlier[i]);
    if (tail.length >= 2 && Math.abs(tail[0].amount - amount) / amount > 0.03) {
      changedFrom = { amount: round2(tail[tail.length - 1].amount), count: tail.length, until: tail[tail.length - 1].date };
    }
  }
  return { amount, steady, count: recent.length, changedFrom, outliers };
}

/**
 * Regular paychecks and when the next ones land.
 * @returns [{ payer, slots: [{ label, day|lastDay, amount, steady, count, last }], cadence }]
 */
export function detectPaychecks({ transactions, incomeCategories, today = new Date() }) {
  const chosen = [...(incomeCategories || [])].map(c => String(c).toLowerCase()).filter(c => !MOVING.has(c));
  const incomeSet = new Set(chosen.length ? chosen : DEFAULT_INCOME);
  const since = new Date(today.getTime() - 200 * DAY);
  const groups = new Map();
  for (const t of transactions || []) {
    const amount = Number(t.amount);
    if (!(amount >= MIN_PAYCHECK) || !t.date) continue;
    if (!incomeSet.has(String(t.category || '').toLowerCase())) continue;
    const date = new Date(t.date);
    if (isNaN(date) || date < since || date > today) continue;
    const k = payerKey(t.description);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ date: startOfDay(date), amount, description: t.description, account: t.account });
  }

  const out = [];
  for (const rows of groups.values()) {
    if (rows.length < 3) continue;
    rows.sort((a, b) => a.date - b.date);
    const cadence = cadenceOf(rows.map(r => r.date));
    if (!cadence || cadence.label === 'irregular') continue;
    // Stopped? Two missed cycles means it's not coming.
    if ((today - rows[rows.length - 1].date) / DAY > cadence.days * 2 + 3) continue;
    const name = payerName(mode(rows.map(r => r.description)));
    const account = mode(rows.map(r => r.account));

    if (cadence.label === 'twice a month' || cadence.label === 'monthly') {
      // Split by half of the month: each half is its own deposit.
      const halves = cadence.label === 'monthly' ? [rows] : [rows.filter(r => r.date.getDate() <= 20), rows.filter(r => r.date.getDate() > 20)];
      const slots = [];
      for (const h of halves) {
        if (h.length < 2) continue;
        // Month-end payroll: most deposits within the last few days of their month.
        const nearEnd = h.filter(r => daysIn(r.date.getFullYear(), r.date.getMonth()) - r.date.getDate() <= 3).length;
        const lastDay = nearEnd / h.length >= 0.6;
        // The usual day; on a tie, the later one — weekend shifts only ever move pay earlier.
        const day = lastDay ? null : modeLatest(h.map(r => r.date.getDate()));
        slots.push({
          label: lastDay ? 'end of month' : day <= 20 ? 'mid-month' : `the ${day}th`,
          day, lastDay,
          ...readAmounts(h),
          last: h[h.length - 1],
        });
      }
      if (slots.length) out.push({ payer: name, account, cadence: cadence.label, slots, rows });
    } else {
      // Fixed-interval pay (weekly / every two weeks / quarterly): one slot.
      out.push({
        payer: name, account, cadence: cadence.label, everyDays: cadence.days, rows,
        slots: [{ label: cadence.label, ...readAmounts(rows), last: rows[rows.length - 1] }],
      });
    }
  }
  return out.sort((a, b) => b.slots.reduce((s, x) => s + x.amount, 0) - a.slots.reduce((s, x) => s + x.amount, 0));
}

/** The paychecks above projected through `until`. */
export function projectPaychecks(paychecks, today, until) {
  const out = [];
  const t0 = startOfDay(today);
  for (const p of paychecks) {
    for (const slot of p.slots) {
      if (p.everyDays) {
        const step = x => new Date(x.getFullYear(), x.getMonth(), x.getDate() + p.everyDays);
        let d = step(slot.last.date);
        while (d < t0) d = step(d);
        for (; d <= until; d = step(d)) out.push({ date: businessDayOnOrBefore(d), payer: p.payer, account: p.account, slot, amount: slot.amount });
        continue;
      }
      for (let y = t0.getFullYear(), m = t0.getMonth(), i = 0; i < 4; i++) {
        const d = slotDate(slot, y, m);
        // This month's deposit already landed, or the date's gone by.
        const already = slot.last.date.getFullYear() === y && slot.last.date.getMonth() === m;
        if (!already && d >= t0 && d <= until) out.push({ date: d, payer: p.payer, account: p.account, slot, amount: slot.amount });
        if (++m > 11) { m = 0; y++; }
      }
    }
  }
  return out.sort((a, b) => a.date - b.date);
}

/**
 * Monthly bills paid straight out of a cash account, with a steady amount.
 * @param isCashAccount  t => boolean, true for a transaction on a counted cash account
 */
export function detectCashBills({ transactions, isCashAccount, today = new Date() }) {
  const since = new Date(today.getTime() - 130 * DAY);
  const groups = new Map();
  for (const t of transactions || []) {
    const amount = Number(t.amount);
    if (!(amount < 0) || !t.date) continue;
    if (MOVING.has(String(t.category || '').toLowerCase())) continue;
    if (!isCashAccount(t)) continue;
    const date = new Date(t.date);
    if (isNaN(date) || date < since || date > today) continue;
    const k = payerKey(t.description);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ date: startOfDay(date), amount: -amount, description: t.description, category: t.category });
  }
  const out = [];
  for (const rows of groups.values()) {
    if (rows.length < 3) continue;
    rows.sort((a, b) => a.date - b.date);
    const cadence = cadenceOf(rows.map(r => r.date));
    if (cadence?.label !== 'monthly') continue;
    const recent = rows.slice(-3);
    const amount = median(recent.map(r => r.amount));
    // A bill, not a habit: the amount holds within 10%.
    if (recent.some(r => Math.abs(r.amount - amount) > amount * 0.1)) continue;
    if (amount < 25) continue;
    const last = rows[rows.length - 1];
    if ((today - last.date) / DAY > 45) continue;
    out.push({
      name: payerName(mode(rows.map(r => r.description))),
      category: mode(rows.map(r => r.category || 'Uncategorized')),
      day: mode(rows.map(r => r.date.getDate())),
      amount: round2(amount),
      last,
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

function projectBills(bills, today, until) {
  const out = [];
  const t0 = startOfDay(today);
  for (const b of bills) {
    for (let y = t0.getFullYear(), m = t0.getMonth(), i = 0; i < 3; i++) {
      const d = new Date(y, m, Math.min(b.day, daysIn(y, m)));
      const paidThisMonth = b.last.date.getFullYear() === y && b.last.date.getMonth() === m;
      if (!paidThisMonth && d >= t0 && d <= until) out.push({ date: d, bill: b, amount: b.amount });
      if (++m > 11) { m = 0; y++; }
    }
  }
  return out;
}

/**
 * The plan.
 * @param cashOnHand    what the counted cash accounts hold now
 * @param cardPayments  upcomingCardPayments() from paymentReminder.js
 * @param paychecks     detectPaychecks()
 * @param bills         detectCashBills()
 * @param horizonDays   how far to look; stretched to cover every card's next payment
 * @returns { start, until, events: [{ date, kind, label, detail, amount, paidFrom, shortBy, balance }],
 *            nextPaycheck, nextCardPayment, totals: { in, out, end }, firstShort }
 */
export function planUpcomingCash({ cashOnHand, cardPayments = [], paychecks = [], bills = [], today = new Date(), horizonDays = 35 }) {
  const t0 = startOfDay(today);
  // Calendar days, not 24h steps: a DST change would land 35×24h at 11pm the day before.
  let until = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + horizonDays);
  for (const c of cardPayments) if (c.date > until && c.date - t0 < 62 * DAY) until = startOfDay(c.date);

  const events = [];
  for (const p of projectPaychecks(paychecks, today, until)) {
    events.push({
      date: p.date, kind: 'paycheck', amount: p.amount,
      label: `${p.payer} paycheck`,
      detail: paycheckDetail(p.slot),
      steady: p.slot.steady.same,
    });
  }
  for (const c of cardPayments) {
    if (c.date < t0 || c.date > until || c.amount <= 0) continue;
    events.push({
      date: startOfDay(c.date), kind: 'card', amount: -c.amount, card: c.card,
      label: `${c.displayName} payment`,
      detail: c.statementClosed
        ? `statement ${short(c.statementFrom)} – ${short(c.statementClose)} has closed: this is the amount due`
        : `statement still open until ${short(c.statementClose)}: ${c.chargeCount} charge${c.chargeCount === 1 ? '' : 's'} so far, so it will grow`,
      final: c.statementClosed,
    });
  }
  for (const b of projectBills(bills, today, until)) {
    events.push({ date: b.date, kind: 'bill', amount: -b.amount, label: b.bill.name, detail: `${b.bill.category} · paid from cash around the ${ordinal(b.bill.day)} each month` });
  }
  // Same day: money in before money out (payroll lands overnight).
  events.sort((a, b) => a.date - b.date || b.amount - a.amount);

  // Pay each outflow from the oldest money available.
  const pools = [{ source: 'cash on hand', left: Math.max(0, cashOnHand) }];
  let balance = cashOnHand;
  let firstShort = null;
  for (const e of events) {
    if (e.amount > 0) {
      pools.push({ source: `${short(e.date)} paycheck`, left: e.amount });
    } else {
      let need = -e.amount;
      e.paidFrom = [];
      for (const p of pools) {
        if (need <= 0.005) break;
        if (p.left <= 0.005) continue;
        const take = Math.min(p.left, need);
        p.left -= take;
        need -= take;
        e.paidFrom.push({ source: p.source, amount: round2(take) });
      }
      if (need > 0.005) {
        e.shortBy = round2(need);
        if (!firstShort) firstShort = e;
      }
    }
    balance = round2(balance + e.amount);
    e.balance = balance;
  }

  const inflow = round2(events.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0));
  const outflow = round2(-events.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0));
  return {
    start: round2(cashOnHand),
    today: t0,
    until,
    events,
    nextPaycheck: events.find(e => e.kind === 'paycheck') || null,
    nextCardPayment: events.find(e => e.kind === 'card') || null,
    totals: { in: inflow, out: outflow, end: balance },
    firstShort,
  };
}

/** How sure the amount is, in words: same / about the same / varies, plus a
 *  level change or a one-off when there was one. */
export function paycheckDetail(slot) {
  const s = slot.steady;
  let text = s.same
    ? `${slot.label} · the same amount the last ${slot.count} times`
    : s.close
      ? `${slot.label} · within ${fmtCents(s.hi - s.lo)} the last ${slot.count} times (${fmtCents(s.lo)}–${fmtCents(s.hi)})`
      : `${slot.label} · has ranged ${fmt(s.lo)}–${fmt(s.hi)} lately; this is the middle`;
  if (slot.changedFrom) {
    text += `. It was ${fmtCents(slot.changedFrom.amount)} every time until ${short(slot.changedFrom.until)}`;
  }
  if (slot.outliers?.length) {
    text += `. Left out as a one-off: ${slot.outliers.map(o => `${fmt(o.amount)} on ${short(o.date)}`).join(', ')}`;
  }
  return text;
}

function fmtCents(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
function short(d) {
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?';
}
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
