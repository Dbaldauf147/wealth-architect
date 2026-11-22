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
