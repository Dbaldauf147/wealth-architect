import { describe, it, expect } from 'vitest';
import { computeIncome, payerKey, payerName, cadenceOf, monthKeysEnding } from './income.js';

const tx = (date, amount, category, description, extra = {}) => ({ date, amount, category, description, account: 'Checking', ...extra });
const d = (y, m, day) => new Date(y, m - 1, day);

// Paid every other Friday from Jan 2 2026 up to today (Jun 10); rent from a tenant on the 1st;
// a tax refund once; refunds in spending categories; money moving around.
function ledger() {
  const out = [];
  for (let t = d(2026, 1, 2); t <= d(2026, 6, 9); t = new Date(t.getTime() + 14 * 86400000)) {
    out.push(tx(`${t.getMonth() + 1}/${t.getDate()}/${t.getFullYear()}`, 2000, 'Paycheck', `ACME CORP PAYROLL PPD ID: ${t.getDate()}9921`));
  }
  for (let m = 1; m <= 6; m++) out.push(tx(`${m}/01/2026`, 1500, 'Income', 'Zelle from Tenant', { subcategory: 'Rent' }));
  out.push(tx('04/15/2026', 800, 'Tax Refund/Payment', 'IRS TREAS 310 TAX REF'));
  out.push(tx('03/20/2026', 120, 'Shopping', 'AMAZON REFUND'));            // credit, not income
  out.push(tx('03/05/2026', 5000, 'Transfer', 'From savings'));            // moving money
  out.push(tx('02/05/2026', 3000, 'Investments', 'Brokerage sale'));       // moving money, even in the bucket
  out.push(tx('12/19/2025', 2000, 'Paycheck', 'ACME CORP PAYROLL PPD ID: 19'));   // prior period
  out.push(tx('06/20/2025', 1900, 'Paycheck', 'ACME CORP PAYROLL PPD ID: 20'));   // a year earlier
  return out;
}

describe('computeIncome', () => {
  const keys = monthKeysEnding('2026-06', 6);
  const today = d(2026, 6, 10);
  const r = computeIncome({ transactions: ledger(), incomeCategories: ['Paycheck', 'Income', 'Tax Refund/Payment', 'Investments'], monthKeys: keys, today });
  const m = Object.fromEntries(r.months.map(x => [x.key, x]));

  it('counts only positive amounts in the income bucket, never money moving', () => {
    expect(m['2026-02'].bySource).toEqual({ Paycheck: 4000, 'Income › Rent': 1500 });
    expect(m['2026-03'].total).toBe(2000 * 2 + 1500);
    expect(r.sources.map(s => s.source)).not.toContain('Investments');
  });

  it('reports refunds and credits apart, reconciling to Cash Flow income', () => {
    expect(m['2026-03'].credits).toBe(120);
    expect(m['2026-03'].cashFlowIncome).toBe(m['2026-03'].total + 120);
    expect(r.credits.top[0]).toMatchObject({ description: 'AMAZON REFUND', category: 'Shopping' });
  });

  it('ranks sources and their payers', () => {
    expect(r.sources[0].source).toBe('Paycheck');
    expect(r.sources[0].payers).toHaveLength(1);
    const pay = r.sources[0].payers[0];
    expect(pay.cadence.label).toBe('every two weeks');
    expect(pay.typical).toBe(2000);
    expect(r.sources.find(s => s.source === 'Income › Rent').payers[0].cadence.label).toBe('monthly');
  });

  it('knows what is still to come this month', () => {
    // June so far: paychecks on Jun 5, rent on Jun 1. Next paycheck Jun 19.
    expect(r.current.received).toBe(2000 + 1500);
    expect(r.current.due.map(x => x.date)).toEqual([d(2026, 6, 19)]);
    expect(r.current.projected).toBe(2000 + 1500 + 2000);
  });

  it('compares like for like with the period before', () => {
    // Five complete months (Jan–May) vs Aug–Dec 2025, which only has Dec's paycheck.
    expect(r.summary.completeCount).toBe(5);
    expect(r.summary.prior).toBe(2000);
    expect(r.summary.latest.key).toBe('2026-05');
    expect(m['2026-06'].lastYear).toBe(1900);
  });

  it('falls back to Cash Flow\'s income categories when the bucket is empty', () => {
    const fb = computeIncome({ transactions: ledger(), incomeCategories: [], monthKeys: keys, today });
    expect(fb.summary.usingDefaults).toBe(true);
    expect(fb.summary.total).toBe(r.summary.total);
  });
});

describe('helpers', () => {
  it('names a payer without its reference numbers', () => {
    expect(payerKey('ACME CORP PAYROLL PPD ID: 12345')).toBe('acme corp payroll');
    expect(payerKey('ACME CORP PAYROLL PPD ID: 99881')).toBe('acme corp payroll');
    const ach = 'Summit Energy Se Des:payroll, ID:CERx5369, Indn:daniel Baldauf, CO ID:x1144 Ppd';
    expect(payerName(ach)).toBe('Summit Energy Se');
    expect(payerKey(ach)).toBe(payerKey('Summit Energy Se Des:payroll, ID:CERx6073, Indn:daniel Baldauf, CO ID:x1144 Ppd'));
    expect(payerName('Bank Int x-XX1526 Td Bank Usa Na')).toBe('Bank Int Td Bank Usa Na');
  });
  it('tells dividends from different holdings apart', () => {
    expect(payerKey('Cash dividend of $34.48 from Costco')).toBe('costco');
    expect(payerKey('Cash dividend of $1.02 from Costco')).toBe('costco');
    expect(payerKey('Cash dividend of $5.00 from Apple')).toBe('apple');
    expect(payerName('Cash dividend of $94.26 from Vug')).toBe('Vug');
  });
  it('trims memos and stray punctuation from a payer name', () => {
    expect(payerName('NY State, Des:nysttaxrfd ID:x6-25, Indn:baldauf,daniel B, CO ID:x3200 Ppd')).toBe('NY State');
    expect(payerName('Zelle payment from, Pat Lee, for, "dinner"; Conf# 123')).toBe('Zelle payment from, Pat Lee');
  });
  it('reads cadence from the gaps', () => {
    const every = n => Array.from({ length: 6 }, (_, i) => d(2026, 1, 1 + i * n));
    expect(cadenceOf(every(7)).label).toBe('weekly');
    expect(cadenceOf(every(14)).label).toBe('every two weeks');
    expect(cadenceOf([d(2026, 1, 15), d(2026, 1, 31), d(2026, 2, 15), d(2026, 2, 28), d(2026, 3, 15)]).label).toBe('twice a month');
    expect(cadenceOf([d(2026, 1, 1), d(2026, 2, 1), d(2026, 3, 1), d(2026, 4, 1)]).label).toBe('monthly');
    expect(cadenceOf([d(2026, 1, 1), d(2026, 1, 3), d(2026, 3, 1), d(2026, 7, 9)]).label).toBe('irregular');
    expect(cadenceOf([d(2026, 1, 1), d(2026, 2, 1)])).toBeNull();
  });
  it('lists month keys back from an end', () => {
    expect(monthKeysEnding('2026-02', 3)).toEqual(['2025-12', '2026-01', '2026-02']);
  });
});
