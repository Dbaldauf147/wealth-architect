/* Deciding what to put in front of the user next.

   A backlog of uncategorized transactions is not a flat list — a $2,400 charge
   from last week matters more than a $3 one from eighteen months ago, and forty
   charges from the same coffee shop are really one decision. This module turns
   the raw transaction list into an ordered queue that reflects both.

   Pure: no React, no DOM, no storage. */

import { merchantKey, looseMerchantKey, findSameMerchant } from './suggest.js';

export const SORTS = {
  impact: { id: 'impact', label: 'Biggest first' },
  newest: { id: 'newest', label: 'Newest first' },
  oldest: { id: 'oldest', label: 'Oldest first' },
};

export function needsReview(t) {
  if (!t) return false;
  const cat = (t.category || '').trim();
  return !cat || cat === 'Uncategorized';
}

function timeOf(t) {
  const ms = new Date(t?.date).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/* One card per decision.

   `groupByMerchant` collapses charges that share a merchant into a single card
   carrying its siblings, so one tap can clear all of them. The card kept is the
   largest of the group — it is the one whose description is most likely to be
   recognisable, and its amount is what the group is worth. */
export function buildReviewQueue(transactions, options) {
  const sort = options?.sort || 'impact';
  const groupByMerchant = options?.groupByMerchant !== false;
  const skipped = options?.skipped instanceof Set ? options.skipped : new Set();

  let pending = (transactions || []).filter(needsReview);
  if (skipped.size) {
    pending = pending.filter(t => !skipped.has(t.transactionId));
  }

  let items;
  if (groupByMerchant) {
    const groups = new Map();
    for (const t of pending) {
      const desc = t.description || t.fullDescription || '';
      // Group on the looser key so a store number or city doesn't split a
      // merchant into two cards — the whole point of grouping is to make one
      // decision serve every charge a person would call "the same place".
      const key = looseMerchantKey(desc) || merchantKey(desc) || (t.transactionId || Math.random().toString(36));
      const g = groups.get(key);
      if (g) g.push(t);
      else groups.set(key, [t]);
    }
    items = [...groups.values()].map(members => {
      const lead = members.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
      const total = members.reduce((sum, t) => sum + t.amount, 0);
      return {
        key: lead.transactionId || `${lead.date}|${lead.description}|${lead.amount}`,
        txn: lead,
        members,
        groupSize: members.length,
        groupTotal: total,
        weight: Math.abs(total),
        time: Math.max(...members.map(timeOf)),
      };
    });
  } else {
    items = pending.map(t => ({
      key: t.transactionId || `${t.date}|${t.description}|${t.amount}`,
      txn: t,
      members: [t],
      groupSize: 1,
      groupTotal: t.amount,
      weight: Math.abs(t.amount),
      time: timeOf(t),
    }));
  }

  const cmp = {
    impact: (a, b) => b.weight - a.weight || b.time - a.time,
    newest: (a, b) => b.time - a.time || b.weight - a.weight,
    oldest: (a, b) => a.time - b.time || b.weight - a.weight,
  }[sort] || ((a, b) => b.weight - a.weight);

  return items.sort(cmp);
}

/* Headline numbers for the progress strip: how much is left, and how much of
   the user's money is currently unaccounted for. */
export function reviewStats(transactions) {
  let count = 0;
  let amount = 0;
  let categorized = 0;
  let oldest = null;
  for (const t of transactions || []) {
    if (needsReview(t)) {
      count += 1;
      amount += Math.abs(t.amount) || 0;
      const ms = timeOf(t);
      if (ms && (oldest == null || ms < oldest)) oldest = ms;
    } else {
      categorized += 1;
    }
  }
  const total = count + categorized;
  return {
    count,
    amount,
    categorized,
    total,
    oldest,
    percentDone: total ? categorized / total : 1,
  };
}

/* Transactions the user has categorized most recently, newest first — the
   "did I get that one right?" list. `overrides` is the map of manual
   decisions, so their own calls sort ahead of whatever the sheet said. */
export function recentlyCategorized(transactions, overrides, limit = 60) {
  const ov = overrides || {};
  const touched = [];
  const rest = [];
  for (const t of transactions || []) {
    if (needsReview(t)) continue;
    (t.transactionId && ov[t.transactionId] ? touched : rest).push(t);
  }
  const byDate = (a, b) => timeOf(b) - timeOf(a);
  touched.sort(byDate);
  rest.sort(byDate);
  return [...touched, ...rest].slice(0, limit);
}

export { findSameMerchant };
