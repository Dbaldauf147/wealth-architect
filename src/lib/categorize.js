/* Pure categorization logic — usable from both the browser (DataContext)
   and the Vercel Function (api/weekly-summary). No React, no DOM, no
   localStorage access. The same logic must run in both places so the
   weekly summary email reflects the same categorized view as the website. */

export function normalizeDesc(s) {
  return (s || '').toLowerCase().trim().replace(/[\s\-–—]+/g, ' ');
}

/* Build a composite key for transactions without a stable transactionId */
export function txnFallbackKey(t) {
  return `${t.date || ''}|${(t.description || '').trim()}|${t.amount}`;
}

export function ruleMatches(rule, t) {
  const ruleDesc = normalizeDesc(rule.description);
  const hasDesc = !!ruleDesc;
  const hasSign = rule.sign === 'positive' || rule.sign === 'negative';
  const hasMin = rule.minAmount != null && !Number.isNaN(Number(rule.minAmount));
  const hasMax = rule.maxAmount != null && !Number.isNaN(Number(rule.maxAmount));
  // A rule with zero filters would match every transaction — reject to be safe.
  if (!hasDesc && !hasSign && !hasMin && !hasMax) return false;

  if (hasDesc) {
    const txnDesc = normalizeDesc(t.description);
    const txnFull = normalizeDesc(t.fullDescription);
    let descMatch = false;
    if (txnDesc && (txnDesc.includes(ruleDesc) || ruleDesc.includes(txnDesc))) descMatch = true;
    if (!descMatch && txnFull && txnFull.includes(ruleDesc)) descMatch = true;
    if (!descMatch) return false;
  }

  const amt = typeof t.amount === 'number' ? t.amount : parseFloat(t.amount);
  if (hasSign) {
    if (rule.sign === 'positive' && !(amt > 0)) return false;
    if (rule.sign === 'negative' && !(amt < 0)) return false;
  }
  const absAmt = Math.abs(amt);
  if (hasMin && absAmt < Number(rule.minAmount)) return false;
  if (hasMax && absAmt > Number(rule.maxAmount)) return false;

  return true;
}

export function sameFilters(a, b) {
  return (
    normalizeDesc(a.description) === normalizeDesc(b.description) &&
    (a.sign || null) === (b.sign || null) &&
    (a.minAmount != null ? Number(a.minAmount) : null) === (b.minAmount != null ? Number(b.minAmount) : null) &&
    (a.maxAmount != null ? Number(a.maxAmount) : null) === (b.maxAmount != null ? Number(b.maxAmount) : null)
  );
}

export function applyRulesToTransactions(txns, rules) {
  if (!rules || !rules.length) return txns;
  return txns.map(t => {
    for (const rule of rules) {
      if (ruleMatches(rule, t)) return { ...t, category: rule.category };
    }
    return t;
  });
}

export function applySubcategoryRulesToTransactions(txns, rules) {
  if (!rules || !rules.length) return txns;
  return txns.map(t => {
    for (const rule of rules) {
      if (ruleMatches(rule, t)) return { ...t, subcategory: rule.subcategory };
    }
    return t;
  });
}

export function applyOverrides(txns, overrides, subOverrides, dateOverrides) {
  const ov = overrides || {};
  const sub = subOverrides || {};
  const dt = dateOverrides || {};
  const hasCat = Object.keys(ov).length > 0;
  const hasSub = Object.keys(sub).length > 0;
  const hasDate = Object.keys(dt).length > 0;
  if (!hasCat && !hasSub && !hasDate) return txns;
  // Fallback keys (date|desc|amount) always contain '|'; transactionIds don't.
  // Only pay the cost of building a fallback key per transaction when some
  // override is actually stored under one — otherwise the id lookups suffice
  // and we skip an O(n) string build on every recategorization.
  const needsFb =
    (hasCat && Object.keys(ov).some(k => k.includes('|'))) ||
    (hasSub && Object.keys(sub).some(k => k.includes('|'))) ||
    (hasDate && Object.keys(dt).some(k => k.includes('|')));
  return txns.map(t => {
    let updated = t;
    const id = t.transactionId;
    const fb = needsFb ? txnFallbackKey(t) : null;
    if (id && ov[id]) updated = { ...updated, category: ov[id] };
    else if (fb && ov[fb]) updated = { ...updated, category: ov[fb] };
    if (id && sub[id]) updated = { ...updated, subcategory: sub[id] };
    else if (fb && sub[fb]) updated = { ...updated, subcategory: sub[fb] };
    if (hasDate) {
      if (id && dt[id]) updated = { ...updated, originalDate: t.date, date: dt[id] };
      else if (fb && dt[fb]) updated = { ...updated, originalDate: t.date, date: dt[fb] };
    }
    return updated;
  });
}
