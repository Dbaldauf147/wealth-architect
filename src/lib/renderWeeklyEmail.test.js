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
