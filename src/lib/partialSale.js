/* Selling part of a position, and what the money would do somewhere else.

   Used by the Keep or Switch tab's Tax section and Scenario Analysis. The tax
   on a partial sale depends on *which* lots go, so the sale is built lot by
   lot: whole lots in the chosen order, with the last one split. */

import { isLongTerm } from './taxes.js';

export const LOT_METHODS = [
  { id: 'fifo', label: 'Oldest first', hint: 'First in, first out: most brokers do this unless you choose lots' },
  { id: 'taxSmart', label: 'Lowest tax first', hint: 'Losses first, then the long-term lots with the smallest gain, then short-term' },
  { id: 'proRata', label: 'A slice of every lot', hint: 'The same share of each lot' },
];

// Order for "lowest tax first": losses before gains (short-term losses offset
// ordinary-rate gains, so they go first), then long-term gains before
// short-term, smallest gain per dollar first within each.
function taxSmartKey(row, asOfT) {
  const gain = row.value - row.costBasis;
  const ratio = row.value > 0 ? gain / row.value : 0;
  const long = isLongTerm(row.buyT, asOfT);
  if (gain < 0) return [0, long ? 1 : 0, ratio];
  return [1, long ? 0 : 1, ratio];
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function scaled(row, f) {
  return {
    ...row,
    quantity: Number.isFinite(row.quantity) ? row.quantity * f : row.quantity,
    value: row.value * f,
    costBasis: row.costBasis * f,
    fraction: f,
  };
}

/**
 * The lots sold to raise `amount` of proceeds from `openRows`.
 *
 * @returns {{ sold: Array, kept: Array, proceeds: number, fraction: number }}
 *   `sold` rows are scaled copies (value, costBasis, quantity) with the share
 *   of the original lot in `fraction`; `kept` is what is left.
 */
export function pickLots(openRows, amount, method = 'fifo', asOfT = Date.now()) {
  const rows = (openRows || []).filter(r => Number.isFinite(r.value) && Number.isFinite(r.costBasis) && r.value > 0);
  const total = rows.reduce((t, r) => t + r.value, 0);
  const target = Math.max(0, Math.min(total, Number(amount) || 0));
  if (!(total > 0) || !(target > 0)) return { sold: [], kept: rows.map(r => scaled(r, 1)), proceeds: 0, fraction: 0 };

  if (method === 'proRata') {
    const f = target / total;
    return {
      sold: rows.map(r => scaled(r, f)),
      kept: f >= 1 ? [] : rows.map(r => scaled(r, 1 - f)),
      proceeds: target,
      fraction: f,
    };
  }

  const ordered = [...rows].sort(method === 'taxSmart'
    ? (a, b) => compareKeys(taxSmartKey(a, asOfT), taxSmartKey(b, asOfT)) || a.buyT - b.buyT
    : (a, b) => a.buyT - b.buyT);

  const sold = [];
  const kept = [];
  let left = target;
  for (const r of ordered) {
    if (left <= 1e-9) { kept.push(scaled(r, 1)); continue; }
    if (r.value <= left + 1e-9) {
      sold.push(scaled(r, 1));
      left -= r.value;
    } else {
      const f = left / r.value;
      sold.push(scaled(r, f));
      kept.push(scaled(r, 1 - f));
      left = 0;
    }
  }
  return { sold, kept, proceeds: target - Math.max(0, left), fraction: target / total };
}

/**
 * Sell `value` (with cost `basis`), pay `tax` now (negative = a loss that cuts
 * the bill) and put what is left in something returning `altReturn`, versus
 * keeping it at `keepReturn`. Both compounding balances, before any tax owed on
 * a later sale.
 *
 * The gap splits exactly into two parts:
 *   taxDrag     = −tax × (1 + alt)^years : the tax and the growth it never gets
 *   performance = value × ((1 + alt)^years − (1 + keep)^years)
 */
export function scenarioBridge({ value, tax, keepReturn, altReturn, years }) {
  if (!(value > 0) || !Number.isFinite(keepReturn) || !Number.isFinite(altReturn) || !(years >= 0)) return null;
  const gAlt = Math.pow(1 + altReturn, years);
  const gKeep = Math.pow(1 + keepReturn, years);
  const reinvested = value - tax;
  const keep = value * gKeep;
  const switched = reinvested * gAlt;
  const taxDrag = -tax * gAlt;
  const taxGrowth = -tax * (gAlt - 1);
  const performance = value * (gAlt - gKeep);
  return {
    years,
    reinvested,
    keep,
    switched,
    difference: switched - keep,
    taxDrag,
    taxGrowth,
    performance,
  };
}
