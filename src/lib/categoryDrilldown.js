/* Spending Trends: one category, month by month — what it cost, what share of
   all spending that was, and which places drove it.

   "Spending" is what the Trends page counts: every charge (a negative amount)
   except money moving between your own accounts — transfers and card
   payments. Refunds aren't netted in, so the share here matches the table.

   Places are grouped by merchantKey (processor prefixes, store numbers and
   city tails stripped), so "TST* FEED AND GRAIN #12" and "TST*FEED AND GRAIN"
   are one place.

   Pure: no React, no DOM. */

import { merchantKey } from './placeMatch.js';

const MOVING = new Set(['transfer', 'credit card payments', 'credit card payment']);
const round2 = n => Math.round(n * 100) / 100;

/** A charge the Trends page counts as spending. */
export function isTrendSpend(t) {
  if (!t || !t.date) return false;
  if (!((Number(t.amount) || 0) < 0)) return false;
  return !MOVING.has(String(t.category || '').toLowerCase());
}

/** "YYYY-MM" of a transaction's date, or null. */
export function trendMonthKey(t) {
  const d = new Date(t.date);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** "whole foods market" → "Whole Foods Market"; "h&m" → "H&M". */
function titleCase(s) {
  return s.replace(/\b([a-z])([a-z']*)/g, (_, a, b) => a.toUpperCase() + b)
    .replace(/\b([A-Z])&([a-z])\b/g, (_, a, b) => `${a}&${b.toUpperCase()}`);
}

/** Who a charge went to, for grouping: merchantKey, less what changes every
 *  charge — order codes after a "*" ("Amazon.com*5E9HQ2GD0"), ACH coded
 *  fields ("… Des:iclub Fees") and reference numbers ("Cvs/pharmacy #x1234"). */
export function placeOf(t) {
  const desc = String(t.description || '')
    .replace(/\.com\b/gi, '')
    .replace(/\s+des\s*:.*$/i, '')
    .replace(/\*\s*(?=[a-z0-9/-]*\d)[a-z0-9/-]+.*$/i, '');
  let key = merchantKey(desc)
    .replace(/\b(?=[a-z]*\d)[a-z0-9]{3,}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Amazon files the same shop under several names.
  if (/^amazon (mktpl|marketplace|com)\b/.test(`${key} `)) key = 'amazon';
  key ||= desc.toLowerCase().replace(/[^a-z&' ]+/g, ' ').replace(/\s+/g, ' ').trim() || 'unknown';
  return { key, name: titleCase(key) };
}

/**
 * @param transactions  the ledger, categorised
 * @param category      the category as the Trends table names it ('Uncategorized' for blank)
 * @param months        YYYY-MM keys, oldest first
 * @param topPlaces     places listed per month
 * @returns {
 *   months: [{ key, amount, total, share, count, places: [{ key, name, amount, count, share, prev }], more }],
 *   avg, avgShare, places: [{ key, name, amount, count, share }]   // over the whole window
 * }
 */
export function categoryDrilldown({ transactions, category, months, topPlaces = 5 }) {
  const inWindow = new Set(months);
  const totals = {};
  const byMonth = {};
  const overall = new Map();
  for (const t of transactions || []) {
    if (!isTrendSpend(t)) continue;
    const key = trendMonthKey(t);
    if (!key || !inWindow.has(key)) continue;
    const amount = Math.abs(Number(t.amount));
    totals[key] = (totals[key] || 0) + amount;
    if ((t.category || 'Uncategorized') !== category) continue;
    const place = placeOf(t);
    const m = (byMonth[key] ||= new Map());
    const p = m.get(place.key) || { ...place, amount: 0, count: 0 };
    p.amount += amount;
    p.count += 1;
    m.set(place.key, p);
    const o = overall.get(place.key) || { ...place, amount: 0, count: 0 };
    o.amount += amount;
    o.count += 1;
    overall.set(place.key, o);
  }

  let prevPlaces = new Map();
  const out = months.map(key => {
    const places = [...(byMonth[key] || new Map()).values()].sort((a, b) => b.amount - a.amount);
    const amount = round2(places.reduce((s, p) => s + p.amount, 0));
    const total = round2(totals[key] || 0);
    const row = {
      key,
      amount,
      total,
      share: total ? amount / total : 0,
      count: places.reduce((s, p) => s + p.count, 0),
      places: places.slice(0, topPlaces).map(p => ({
        key: p.key,
        name: p.name,
        amount: round2(p.amount),
        count: p.count,
        share: amount ? p.amount / amount : 0,
        prev: round2(prevPlaces.get(p.key)?.amount || 0),
      })),
      more: Math.max(0, places.length - topPlaces),
    };
    prevPlaces = new Map(places.map(p => [p.key, p]));
    return row;
  });

  const sum = out.reduce((s, m) => s + m.amount, 0);
  const allSpend = out.reduce((s, m) => s + m.total, 0);
  return {
    months: out,
    avg: out.length ? round2(sum / out.length) : 0,
    avgShare: allSpend ? sum / allSpend : 0,
    places: [...overall.values()].sort((a, b) => b.amount - a.amount).slice(0, 10).map(p => ({
      key: p.key, name: p.name, amount: round2(p.amount), count: p.count, share: sum ? p.amount / sum : 0,
    })),
  };
}
