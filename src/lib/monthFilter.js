// The category filter on the Spending → This month tab, in two layers:
//   - a default: the categories you always want switched off (standing);
//   - this month's filter: changes made during a month, tagged with that
//     month's key. Once the calendar moves on, the tag no longer matches and
//     the page falls back to the default on its own — nothing has to run at
//     midnight on the 1st.

const pad = n => String(n).padStart(2, '0');
export const monthKeyOf = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

const asList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);

/** The stored default, or [] when it's missing or unreadable. */
export function parseDefault(raw) {
  try { return asList(JSON.parse(raw || '[]')); } catch { return []; }
}

/** This month's stored filter, or null when it's missing, unreadable or from another month. */
export function parseMonth(raw, monthKey) {
  try {
    const v = JSON.parse(raw || 'null');
    return v && v.month === monthKey && Array.isArray(v.hidden) ? asList(v.hidden) : null;
  } catch { return null; }
}

export const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

// ── The synced form ──────────────────────────────────────────────────────
//
// The filter and your own expected month totals are one synced setting,
// `spendMonthPrefs`, so Overshot and the weekly email (which runs on the
// server and never sees this browser) project the same month the Spending
// tab does:
//   { hidden: [category],                      the standing default
//     month: 'YYYY-MM' | null, monthHidden: [category],   this month's filter
//     expected: { [category]: amount },        your own month totals
//     updatedAt: ms }                          for newest-wins between devices

const asAmounts = v => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === 'number' && n >= 0))
  : {});

/** Any stored value as a well-formed prefs object. */
export function normalizeSpendPrefs(v) {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const month = typeof o.month === 'string' ? o.month : null;
  return {
    hidden: asList(o.hidden),
    month,
    monthHidden: month ? asList(o.monthHidden) : [],
    expected: asAmounts(o.expected),
    updatedAt: Number(o.updatedAt) || 0,
  };
}

/** The categories switched off in `monthKey`: that month's filter if it has one, else the default. */
export function activeHidden(prefs, monthKey = monthKeyOf()) {
  const p = normalizeSpendPrefs(prefs);
  return p.month === monthKey ? p.monthHidden : p.hidden;
}

/** Between two devices' copies, the one changed most recently (local on a tie). */
export function mergeSpendPrefs(local, remote) {
  const l = local ? normalizeSpendPrefs(local) : null;
  const r = remote ? normalizeSpendPrefs(remote) : null;
  if (!l) return r || normalizeSpendPrefs(null);
  if (!r) return l;
  return r.updatedAt > l.updatedAt ? r : l;
}

/** Prefs from the three keys the Spending tab used to keep in the browser. */
export function spendPrefsFromLegacy({ hidden, monthHidden, expected }) {
  let month = null;
  let list = [];
  try {
    const v = JSON.parse(monthHidden || 'null');
    if (v && typeof v.month === 'string' && Array.isArray(v.hidden)) { month = v.month; list = v.hidden; }
  } catch { /* unreadable: no month filter */ }
  let amounts = {};
  try { amounts = JSON.parse(expected || '{}'); } catch { /* unreadable: none */ }
  const p = normalizeSpendPrefs({ hidden: parseDefault(hidden), month, monthHidden: list, expected: amounts });
  // Older than anything saved since, newer than nothing at all.
  const any = p.hidden.length || p.month || Object.keys(p.expected).length;
  return { ...p, updatedAt: any ? 1 : 0 };
}
