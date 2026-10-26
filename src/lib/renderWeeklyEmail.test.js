import { describe, it, expect } from 'vitest';
import { renderWeeklyEmailHtml } from './renderWeeklyEmail.js';

/** The minimum summary shape the renderer needs, with one section switched on. */
function render(sectionId, patch) {
  const summary = {
    range: { start: '2026-08-24', end: '2026-08-30' },
    expenseTotal: 0, priorTotal: 0, wowDelta: 0, wowPct: 0,
    topCategories: [], topMerchants: [], uncategorized: [],
    transactionCount: 0, uncategorizedCount: 0, nextCardPayment: null,
    monthlyTrends: null, monthCompare: null, weekCompare: null,
    aboveRange: [], suboptimalCards: null, cardPromos: null,
    fmt: n => `$${n}`,
    ...patch,
  };
  return renderWeeklyEmailHtml(summary, { sections: [{ id: sectionId, enabled: true }] });
}

const charge = (over = {}) => ({
  date: '2026-08-24',
  description: 'Dwa* Champlins Marina',
  spend: 506.78,
  categoryLabel: 'Travel (booked direct)',
  usedLabel: 'Prime Visa',
  bestLabel: 'Sapphire Reserve',
  usedRate: 1,
  bestRate: 6,
  missed: 25.34,
  ...over,
});

const suboptimal = (items) => ({
  suboptimalCards: { totalMissed: 99.47, evaluatedCount: 76, unknownCount: 0, moreCount: 0, items },
});

/** Pull one section's table out as rows of plain-text cells. */
function tableCells(html) {
  const i = html.indexOf('Suboptimal Card Usage');
  const seg = html.slice(i, html.indexOf('</table>', i));
  return seg.split('<tr>').slice(1).map(row =>
    [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
      .map(m => m[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim()),
  ).filter(cells => cells.length);
}

describe('Suboptimal Card Usage table', () => {
  it('gives every fact its own column, category included', () => {
    const rows = tableCells(render('suboptimalCards', suboptimal([charge()])));
    expect(rows[0]).toEqual(['Date', 'Merchant', 'Category', 'Spend', 'Charged to', 'Better card', 'Missed']);
  });

  it('puts the category in the category column rather than a run-on sub-line', () => {
    const rows = tableCells(render('suboptimalCards', suboptimal([charge()])));
    const [, body] = rows;
    expect(body[2]).toBe('Travel (booked direct)');
    expect(body[1]).toBe('Dwa* Champlins Marina');
    // The merchant cell must no longer carry the category, amount and card.
    expect(body[1]).not.toContain('Travel');
    expect(body[1]).not.toContain('Prime Visa');
  });

  it('keeps the rate alongside each card, and the loss in its own cell', () => {
    const [, body] = tableCells(render('suboptimalCards', suboptimal([charge()])));
    expect(body[3]).toBe('$506.78');
    expect(body[4]).toBe('Prime Visa (1%)');
    expect(body[5]).toBe('Sapphire Reserve (6%)');
    expect(body[6]).toBe('-$25.34');
  });

  it('holds one row per charge', () => {
    const rows = tableCells(render('suboptimalCards', suboptimal([
      charge({ description: 'One' }),
      charge({ description: 'Two' }),
      charge({ description: 'Three' }),
    ])));
    expect(rows).toHaveLength(4); // header + three charges
    expect(rows.slice(1).map(r => r[1])).toEqual(['One', 'Two', 'Three']);
  });

  it('escapes a merchant name that contains markup', () => {
    const html = render('suboptimalCards', suboptimal([charge({ description: '<b>Ampersand & Co</b>' })]));
    expect(html).not.toContain('<b>Ampersand');
    expect(html).toContain('&lt;b&gt;Ampersand');
  });

  it('renders nothing when there is nothing to flag', () => {
    expect(render('suboptimalCards', suboptimal([]))).not.toContain('Suboptimal Card Usage');
  });
});

describe('dates in the email', () => {
  // A date-only string parses as UTC midnight, so any timezone west of
  // Greenwich used to render it as the previous day — a charge on the 24th
  // arriving in the inbox as "Aug 23".
  it('prints a date-only charge on its own calendar day', () => {
    const [, body] = tableCells(render('suboptimalCards', suboptimal([charge({ date: '2026-08-24' })])));
    expect(body[0]).toBe('Aug 24');
  });

  it('does not drift across a month boundary', () => {
    const [, body] = tableCells(render('suboptimalCards', suboptimal([charge({ date: '2026-09-01' })])));
    expect(body[0]).toBe('Sep 1');
  });

  it('leaves a real timestamp alone', () => {
    const [, body] = tableCells(render('suboptimalCards', suboptimal([
      charge({ date: new Date(2026, 7, 24, 15, 30).toISOString() }),
    ])));
    expect(body[0]).toBe('Aug 24');
  });

  it('passes an unparseable date through rather than printing "Invalid Date"', () => {
    const [, body] = tableCells(render('suboptimalCards', suboptimal([charge({ date: 'not a date' })])));
    expect(body[0]).toBe('not a date');
  });
});

describe('Card Promotions section', () => {
  const promo = (over = {}) => ({
    id: 'p', card: 'Chase Sapphire Reserve', name: 'Priority Pass Select', period: 'annual',
    color: null, value: 469, used: 0, remaining: 469, completed: false, completedAt: null,
    tracked: false, matchCount: 0, taggedCount: 0, lastTransaction: null, ...over,
  });
  const promos = (items) => ({
    cardPromos: {
      totalValue: 0, totalUsed: 0, remaining: 0, pct: 0, count: items.length,
      completedCount: items.filter(i => i.completed).length, items, moreCount: 0,
    },
  });
  const rowText = (html, name) => {
    const i = html.indexOf(name);
    return html.slice(html.lastIndexOf('<tr>', i), html.indexOf('</tr>', i)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  };

  it('marks a promo ticked off on the page as done, with the day', () => {
    const html = render('cardPromos', promos([promo({ completed: true, completedAt: '2026-09-20', used: 469, remaining: 0 })]));
    const row = rowText(html, 'Priority Pass Select');
    expect(row).toContain('Marked done Sep 20, 2026');
    expect(row).toContain('Done');
    expect(row).not.toContain('Tracked by hand');
    expect(html).toContain('1 marked done');
  });

  it('does not call a promo with no value set "Fully used"', () => {
    const html = render('cardPromos', promos([promo({ name: '$150 in Dining', value: 0, remaining: 0 })]));
    const row = rowText(html, '$150 in Dining');
    expect(row).toContain('No value set');
    expect(row).not.toContain('Fully used');
    expect(row).not.toContain('Done');
  });

  it('still reports a credit used up by charges as fully used', () => {
    const html = render('cardPromos', promos([promo({ used: 469, remaining: 0, tracked: true })]));
    expect(rowText(html, 'Priority Pass Select')).toContain('Fully used');
  });
});

describe('month-to-date movers', () => {
  const trends = {
    monthLabel: 'October 2026',
    mtdRange: { start: new Date(2026, 9, 1).toISOString(), end: new Date(2026, 9, 26, 23, 59, 59).toISOString() },
    priorMtdRange: { start: new Date(2026, 8, 1).toISOString(), end: new Date(2026, 8, 26, 23, 59, 59).toISOString() },
    mtdTotal: 4294.28, priorMtdTotal: 2989.74, mtdDelta: 1304.54, mtdPct: 43.6,
    topMovers: [
      { name: 'Travel', current: 1288.15, prior: 102, delta: 1186.15, pct: 1163 },
      { name: 'Restaurants', current: 517.85, prior: 1145.51, delta: -627.66, pct: -55 },
      { name: 'Gifts & Donations', current: 407, prior: 0, delta: 407, pct: null },
    ],
  };
  const html = render('monthlyTrends', { monthlyTrends: trends });
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('says in words which windows are compared and which way the total moved', () => {
    expect(plain).toContain('$1,304.54 more (+43.6%) than by this point in September');
    expect(plain).toContain('Oct 1–26 $4,294.28');
    expect(plain).toContain('Sep 1–26 $2,989.74');
  });

  it('shows each mover as a signed change with last month → this month', () => {
    expect(plain).toContain('Travel +$1,186.15 $102.00 → $1,288.15');
    expect(plain).toContain('Restaurants −$627.66 $1,145.51 → $517.85');
    expect(plain).toContain('Gifts &amp; Donations +$407.00 new this month');
  });

  it('scales bars to the largest change and puts decreases on the left', () => {
    expect(html).toMatch(/background:#b91c1c;height:12px;width:100%/);
    expect(html).toMatch(/background:#16a34a;height:12px;width:53%;border-radius:3px;margin-left:auto;/);
  });
});
