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
export function newWatchRule({ id, description, sign, minAmount, maxAmount, note, email, createdAt } = {}) {
  return {
    id: id || `watch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    description: String(description || '').trim(),
    sign: sign === 'positive' || sign === 'negative' ? sign : null,
    minAmount: toNumberOrNull(minAmount),
    maxAmount: toNumberOrNull(maxAmount),
    note: String(note || '').trim(),
    // Email on new matching transactions (api/watched-vendors). On by default.
    email: email !== false,
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

/* ── New-transaction emails (api/watched-vendors) ────────────────────────────
 *
 * The cron keeps, per rule, the keys of every transaction it has already seen
 * match. A transaction is "new" when it matches and isn't in that set. Two
 * cases are baselined silently instead of emailed, or the first run would mail
 * the vendor's whole history:
 *   - a rule the cron has never seen (just flagged), and
 *   - a rule whose filters changed (a wider pattern would otherwise make every
 *     older row it now catches look new).
 * A rule with email turned off still advances its seen set, so turning email
 * back on doesn't flood either.
 */

/** A stable key for one transaction. */
export function watchTxnKey(t) {
  return t.transactionId || `${t.date}|${t.description}|${t.amount}`;
}

/** The filters that decide what a rule matches, as one comparable string. */
export function watchRuleSignature(r) {
  return JSON.stringify([
    String(r.description || '').trim().toLowerCase(),
    r.sign || null,
    toNumberOrNull(r.minAmount),
    toNumberOrNull(r.maxAmount),
  ]);
}

/** A Firestore-safe document id for a rule's seen-state. */
export function watchStateDocId(rule) {
  return String(rule.id || 'rule').replace(/[/\s]+/g, '_').slice(0, 1400);
}

/**
 * Work out what to email and the seen-state to store afterwards.
 *
 * @param {object[]} rules         watch rules from config
 * @param {object[]} transactions  the ledger, as the website shows it
 * @param {Map<string, {signature:string, seen:string[]}>} state  stored state by rule id
 * @returns {{ notify: {rule, transactions}[], nextState: Map, baselined: string[] }}
 */
export function newFlaggedTransactions(rules, transactions, state) {
  const notify = [];
  const nextState = new Map();
  const baselined = [];
  for (const rule of rules || []) {
    if (!rule || !rule.id || !watchRuleHasFilter(rule)) continue;
    const signature = watchRuleSignature(rule);
    const matches = (transactions || []).filter(t => ruleMatches(rule, t));
    const keys = matches.map(watchTxnKey);
    const prev = state && state.get(rule.id);
    if (!prev || prev.signature !== signature) {
      baselined.push(rule.id);
      nextState.set(rule.id, { signature, seen: [...new Set(keys)] });
      continue;
    }
    const seen = new Set(prev.seen || []);
    const fresh = matches.filter(t => !seen.has(watchTxnKey(t)));
    // Keep keys of rows that dropped out of the sheet too: a row that
    // reappears (re-import, unhide) has already been mailed.
    for (const k of keys) seen.add(k);
    nextState.set(rule.id, { signature, seen: [...seen] });
    if (fresh.length && rule.email !== false) {
      fresh.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      notify.push({ rule, transactions: fresh });
    }
  }
  return { notify, nextState, baselined };
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const ruleName = r => r.description || describeWatchRule(r);

/** Subject and HTML body for one email covering every rule with new rows. */
export function renderWatchedVendorEmail(notify, { siteUrl = '' } = {}) {
  const total = notify.reduce((n, x) => n + x.transactions.length, 0);
  const blocks = notify.map(({ rule, transactions }) => {
    const rows = transactions.slice(0, 20).map(t => {
      const amt = Number(t.amount);
      return `
        <tr>
          <td style="padding:2px 12px 2px 0;color:#64748b;white-space:nowrap">${esc(t.date)}</td>
          <td style="padding:2px 12px 2px 0;color:#334155">${esc(t.description)}${t.account ? ` <span style="color:#94a3b8">· ${esc(t.account)}</span>` : ''}</td>
          <td style="padding:2px 0;text-align:right;white-space:nowrap;color:${amt < 0 ? '#0f172a' : '#009668'}">${amt < 0 ? money(-amt) : `+${money(amt)}`}</td>
        </tr>`;
    }).join('');
    const more = transactions.length > 20 ? `<div style="font-size:12px;color:#64748b;margin-top:6px">and ${transactions.length - 20} more</div>` : '';
    return `
      <div style="margin:0 0 20px;padding:14px 16px;border:1px solid #fed7aa;border-radius:8px;background:#fff7ed">
        <div style="font-size:15px;font-weight:700;color:#0f172a">⚑ ${esc(ruleName(rule))}
          <span style="font-weight:400;color:#64748b;font-size:13px">· ${transactions.length} new</span></div>
        ${rule.note ? `<div style="font-size:12.5px;color:#9a3412;margin-top:2px">${esc(rule.note)}</div>` : ''}
        <div style="font-size:12px;color:#94a3b8;margin:2px 0 10px">${esc(describeWatchRule(rule))}</div>
        <table style="border-collapse:collapse;font-size:13px">${rows}</table>${more}
      </div>`;
  }).join('');
  const names = notify.map(x => ruleName(x.rule));
  const subject = notify.length === 1
    ? `Flagged vendor: ${total === 1 ? 'new transaction' : `${total} new transactions`} at ${names[0]}`
    : `Flagged vendors: ${total} new transactions at ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:Inter,Arial,sans-serif;background:#f9f9f8">
    <div style="max-width:560px;margin:0 auto">
      <div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#94a3b8;margin-bottom:12px">Wealth Architect · Flagged vendors</div>
      ${blocks}
      <div style="font-size:12px;color:#94a3b8">Each transaction is emailed once.${siteUrl ? ` Change or unflag vendors under <a href="${esc(siteUrl)}/#transactions" style="color:#0058be">Transactions → Flagged</a>.` : ''}</div>
    </div></body></html>`;
  return { subject, html };
}
