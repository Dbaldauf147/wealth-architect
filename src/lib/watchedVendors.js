/* Watched vendors — "flag every transaction from this merchant".
 *
 * A watch rule carries exactly the filters an auto-categorization rule does
 * (description contains, sign, min/max |amount|), and is matched by the same
 * ruleMatches, so a pattern that catches the right rows in the rule editor
 * catches the same rows here. Unlike a category rule, every matching watch
 * applies — there is no "first match wins" — since a flag assigns nothing.
 *
 * Pure: no React, no DOM, no storage.
 */

import { ruleMatches } from './categorize.js';

function toNumberOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normalize form input into a stored watch rule. */
export function newWatchRule({ id, description, sign, minAmount, maxAmount, note, createdAt } = {}) {
  return {
    id: id || `watch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    description: String(description || '').trim(),
    sign: sign === 'positive' || sign === 'negative' ? sign : null,
    minAmount: toNumberOrNull(minAmount),
    maxAmount: toNumberOrNull(maxAmount),
    note: String(note || '').trim(),
    createdAt: createdAt || new Date().toISOString(),
  };
}

/** A rule with no filters would flag everything; ruleMatches refuses it too. */
export function watchRuleHasFilter(r) {
  if (!r) return false;
  return !!String(r.description || '').trim()
    || r.sign === 'positive' || r.sign === 'negative'
    || toNumberOrNull(r.minAmount) != null
    || toNumberOrNull(r.maxAmount) != null;
}

/** Every watch rule this transaction trips. */
export function matchingWatchRules(t, rules) {
  if (!t || !rules || !rules.length) return [];
  return rules.filter(r => watchRuleHasFilter(r) && ruleMatches(r, t));
}

/** Transactions tripped by at least one watch rule. */
export function flaggedTransactions(transactions, rules) {
  if (!rules || !rules.length) return [];
  return (transactions || []).filter(t => matchingWatchRules(t, rules).length > 0);
}

/** How many transactions each rule catches, by rule id. */
export function watchRuleCounts(transactions, rules) {
  const counts = {};
  for (const r of rules || []) counts[r.id] = 0;
  for (const t of transactions || []) {
    for (const r of matchingWatchRules(t, rules)) counts[r.id] += 1;
  }
  return counts;
}

/** A short human description of a rule's filters. */
export function describeWatchRule(r) {
  const parts = [];
  if (r.description) parts.push(`contains "${r.description}"`);
  if (r.sign === 'negative') parts.push('charges only');
  if (r.sign === 'positive') parts.push('credits only');
  if (r.minAmount != null && r.maxAmount != null) parts.push(`$${r.minAmount}–$${r.maxAmount}`);
  else if (r.minAmount != null) parts.push(`≥ $${r.minAmount}`);
  else if (r.maxAmount != null) parts.push(`≤ $${r.maxAmount}`);
  return parts.join(' · ') || 'no filters';
}
