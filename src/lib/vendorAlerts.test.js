import { describe, it, expect } from 'vitest';
import {
  matchesVendor, periodRange, evaluateVendorAlert, evaluateVendorAlerts, todayIn, newVendorAlert,
  pendingSends, renderVendorAlertEmail,
} from './vendorAlerts.js';

const t = (date, description, amount, extra = {}) => ({ date, description, amount, ...extra });

describe('matchesVendor', () => {
  it('matches across the ways a merchant is spelled, ignoring case and punctuation', () => {
    expect(matchesVendor('amazon', t('2026-10-01', 'AMAZON.COM*RT5K2', -1))).toBe(true);
    expect(matchesVendor('Amazon', t('2026-10-01', 'Amazon Mktpl*2K4', -1))).toBe(true);
    expect(matchesVendor('uber eats', t('2026-10-01', 'UBER   *EATS PENDING', -1))).toBe(true);
  });

  it('searches the full description too', () => {
    expect(matchesVendor('lyft', t('2026-10-01', 'PURCHASE', -1, { fullDescription: 'LYFT RIDE 0824' }))).toBe(true);
  });

  it('matches from the start of a word, not inside one', () => {
    // "uber" must not catch "Tuberville's Diner".
    expect(matchesVendor('uber', t('2026-10-01', "TUBERVILLE'S DINER", -1))).toBe(false);
    expect(matchesVendor('', t('2026-10-01', 'ANYTHING', -1))).toBe(false);
  });
});

describe('periodRange', () => {
  it('runs a month from the 1st and keys it by month', () => {
    const r = periodRange('month', '2026-10-12');
    expect(r.key).toBe('2026-10');
    expect(r.end - r.start).toBe(11);
  });

  it('runs a week from Monday', () => {
    // 2026-10-12 is a Monday; 2026-10-18 the Sunday after.
    expect(periodRange('week', '2026-10-12').key).toBe('2026-10-12');
    expect(periodRange('week', '2026-10-18').key).toBe('2026-10-12');
    expect(periodRange('week', '2026-10-11').key).toBe('2026-10-05');
  });
});

describe('evaluateVendorAlert', () => {
  const ledger = [
    t('2026-09-28', 'AMAZON MKTPL', -500),      // last month
    t('2026-10-02', 'AMAZON MKTPL', -120),
    t('2026-10-05', 'WHOLE FOODS', -80),
    t('2026-10-07', 'AMAZON.COM', -100),
    t('2026-10-09', 'AMAZON.COM REFUND', 40),
    t('10/11/2026', 'AMAZON MKTPL', -60),        // sheet date format
  ];

  it('totals the month, net of refunds, and says which charge crossed', () => {
    const r = evaluateVendorAlert({ vendor: 'amazon', threshold: 200, period: 'month' }, ledger, '2026-10-12');
    expect(r.spent).toBe(240);
    expect(r.crossed).toBe(true);
    expect(r.crossedOn).toBe('2026-10-07');
    expect(r.periodKey).toBe('2026-10');
    expect(r.matches).toHaveLength(4);
  });

  it('stays under when the total does', () => {
    const r = evaluateVendorAlert({ vendor: 'amazon', threshold: 300, period: 'month' }, ledger, '2026-10-12');
    expect(r.crossed).toBe(false);
    expect(r.pct).toBeCloseTo(0.8);
    expect(r.crossedOn).toBeNull();
  });

  it('counts only this week for a weekly rule', () => {
    const r = evaluateVendorAlert({ vendor: 'amazon', threshold: 50, period: 'week' }, ledger, '2026-10-12');
    // Week of Oct 12: nothing yet. Week of Oct 5 would hold 100 - 40 + 60.
    expect(r.spent).toBe(0);
    const prev = evaluateVendorAlert({ vendor: 'amazon', threshold: 50, period: 'week' }, ledger, '2026-10-11');
    expect(prev.spent).toBe(120);
    expect(prev.crossed).toBe(true);
  });

  it('flags single purchases over the line for a per-purchase rule', () => {
    const r = evaluateVendorAlert({ vendor: 'amazon', threshold: 100, period: 'purchase' }, ledger, '2026-10-12');
    expect(r.crossed).toBe(true);
    expect(r.over.map(x => x.amount)).toEqual([-120, -100]);
    expect(r.spent).toBe(120); // the biggest one
    const none = evaluateVendorAlert({ vendor: 'amazon', threshold: 150, period: 'purchase' }, ledger, '2026-10-12');
    expect(none.crossed).toBe(false);
  });

  it('skips rules that are missing a vendor or a positive threshold', () => {
    expect(evaluateVendorAlert({ vendor: '', threshold: 10, period: 'month' }, ledger, '2026-10-12')).toBeNull();
    expect(evaluateVendorAlert({ vendor: 'amazon', threshold: 0, period: 'month' }, ledger, '2026-10-12')).toBeNull();
    expect(evaluateVendorAlerts([{ vendor: '' }, { vendor: 'amazon', threshold: 1, period: 'month' }], ledger, '2026-10-12')).toHaveLength(1);
  });
});

describe('todayIn / newVendorAlert', () => {
  it('reads the calendar day in the given zone', () => {
    // 02:00 UTC on the 13th is still the evening of the 12th in New York.
    expect(todayIn('America/New_York', new Date('2026-10-13T02:00:00Z'))).toBe('2026-10-12');
  });

  it('builds a clean rule', () => {
    const r = newVendorAlert({ vendor: '  Amazon ', threshold: '199.999', period: 'bogus' });
    expect(r).toMatchObject({ vendor: 'Amazon', threshold: 200, period: 'month', email: true });
    expect(r.id).toMatch(/^va_/);
  });
});

describe('pendingSends', () => {
  const ledger = [
    t('2026-10-02', 'AMAZON', -150, { transactionId: 'a1' }),
    t('2026-10-06', 'AMAZON', -130, { transactionId: 'a2' }),
  ];
  const monthly = { id: 'm', vendor: 'amazon', threshold: 200, period: 'month' };
  const perBuy = { id: 'p', vendor: 'amazon', threshold: 100, period: 'purchase' };
  const quiet = { id: 'q', vendor: 'amazon', threshold: 200, period: 'month', email: false };

  it('sends a total once per period, and a purchase once per purchase', () => {
    const results = evaluateVendorAlerts([monthly, perBuy, quiet], ledger, '2026-10-12');
    const first = pendingSends(results, new Set());
    expect(first.map(p => p.sendKeys)).toEqual([['m__2026-10'], ['p__a1', 'p__a2']]);

    const later = pendingSends(results, new Set(['m__2026-10', 'p__a1']));
    expect(later).toHaveLength(1);
    expect(later[0].newOver.map(x => x.transactionId)).toEqual(['a2']);
  });

  it('renders one email naming every alert', () => {
    const results = evaluateVendorAlerts([monthly, perBuy], ledger, '2026-10-12');
    const { subject, html } = renderVendorAlertEmail(pendingSends(results, new Set()), { siteUrl: 'https://x.test' });
    expect(subject).toBe('Spending alerts: amazon, amazon');
    expect(html).toContain('$280.00 spent this month');
    expect(html).toContain('2 purchases of $100.00 or more');
    expect(html).toContain('https://x.test/#trends');
  });
});
