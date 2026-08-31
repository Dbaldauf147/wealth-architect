/* Search the whole ledger and roll the matches up into a chart.

   Pure and React-free, like weeklySummary and cardPromos: the mobile Search
   tab is a thin shell over this, and the interesting part — what counts as
   spending, what a "merchant" is, which groups earn a bar — is testable
   without a DOM. */

import { NON_SPEND_CATEGORIES } from './categories.js';
import { looseMerchantKey } from './suggest.js';

const DAY_MS = 86_400_000;

/** Sheet dates arrive as ISO or M/D/YYYY. An ISO date-only string parses as
 *  UTC and can land on the previous day west of Greenwich, so pin it to local
 *  noon — the same rule the mobile formatters use. */
export function parseDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d, 12);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Every transaction matching `query` within the last `days` (null = all time).
 *  The query is a plain case-insensitive substring over everything the row
 *  says about itself, so "whole foods", "groceries" and the account name all
 *  find the same charge. */
export function searchTransactions({ transactions, query = '', days = null, now = Date.now() }) {
  const cutoff = days == null ? null : now - days * DAY_MS;
  const q = (query || '').trim().toLowerCase();
  const out = [];
  for (const t of transactions || []) {
    if (cutoff != null) {
      const d = parseDate(t.date);
      if (!d || d.getTime() < cutoff) continue;
    }
    if (q) {
      const hay = `${t.description || ''} ${t.fullDescription || ''} ${t.category || ''} ${t.subcategory || ''} ${t.account || ''}`;
      if (!hay.toLowerCase().includes(q)) continue;
    }
    out.push(t);
  }
  return out;
}

/** The label to show for a merchant group. Descriptions of one merchant vary
 *  by store number and city, so show the one that turns up most often, and
 *  break a tie towards the shortest — the version without the tail. */
function labelFor(counts, fallback) {
  let best = '';
  let bestN = -1;
  for (const [text, n] of counts) {
    if (n > bestN || (n === bestN && text.length < best.length)) { best = text; bestN = n; }
  }
  return best || fallback;
}

/**
 * Group matching transactions by category or by merchant name.
 *
 * Group totals are signed (`-amount` summed), so a refund shrinks its group
 * rather than growing it, and a group that nets positive is income or a
 * reversal and gets no bar. `spend` is the sum of the bars, so the headline
 * number and the chart can never disagree.
 *
 * Transfers, income and investments are held out by default — left in they
 * own the chart, for the same reason they are kept out of the month view —
 * and what was withheld comes back as `hiddenSpend` so the UI can say so.
 */
export function summarizeSearch({
  transactions,
  query = '',
  days = null,
  groupBy = 'category',
  includeNonSpend = false,
  now = Date.now(),
}) {
  const matches = searchTransactions({ transactions, query, days, now });
  const groups = new Map();
  let income = 0;
  let hiddenSpend = 0;

  for (const t of matches) {
    const amount = Number(t.amount) || 0;
    if (amount > 0) income += amount;

    const category = t.category && t.category !== 'Uncategorized' ? t.category : 'Uncategorized';
    if (!includeNonSpend && NON_SPEND_CATEGORIES.has(category)) {
      if (amount < 0) hiddenSpend += -amount;
      continue;
    }

    const key = groupBy === 'merchant'
      ? (looseMerchantKey(t.description) || (t.description || '').toLowerCase() || '—')
      : category;
    let g = groups.get(key);
    if (!g) {
      g = { key, category, net: 0, count: 0, items: [], labels: new Map() };
      groups.set(key, g);
    }
    g.net += -amount;
    g.count += 1;
    g.items.push(t);
    if (groupBy === 'merchant') {
      const label = (t.description || '').trim();
      if (label) g.labels.set(label, (g.labels.get(label) || 0) + 1);
    }
  }

  const bars = [];
  let spend = 0;
  for (const g of groups.values()) {
    if (g.net <= 0) continue;
    bars.push({
      key: g.key,
      label: groupBy === 'merchant' ? labelFor(g.labels, g.key) : g.category,
      category: g.category,
      amount: g.net,
      count: g.count,
      items: g.items,
    });
    spend += g.net;
  }
  bars.sort((a, b) => (b.amount - a.amount) || a.label.localeCompare(b.label));

  return {
    matches,
    bars,
    max: bars.length ? bars[0].amount : 0,
    spend,
    income,
    hiddenSpend,
  };
}
