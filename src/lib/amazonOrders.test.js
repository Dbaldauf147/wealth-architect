import { describe, it, expect } from 'vitest';
import {
  isAmazonCharge, matchAmazonOrders, buildItemIndex, suggestFromItems, withItemSuggestions, itemSummary,
  describeAmazonMatch, amazonOrderUrl, amazonImportStalled,
} from './amazonOrders.js';

const txn = (id, date, amount, description = 'AMAZON MKTPL*AB12CD', extra = {}) => ({
  transactionId: id, date, amount, description, ...extra,
});
const order = (orderId, orderDate, total, items, extra = {}) => ({
  orderId, orderDate, total, items: items.map(name => ({ name, price: null })), ...extra,
});

describe('isAmazonCharge', () => {
  it('knows Amazon from its siblings', () => {
    expect(isAmazonCharge({ description: 'AMAZON MKTPL*2K4' })).toBe(true);
    expect(isAmazonCharge({ description: 'AMZN Mktp US' })).toBe(true);
    expect(isAmazonCharge({ description: 'Amazon.com*RT5' })).toBe(true);
    expect(isAmazonCharge({ description: 'WHOLEFDS BRK 10234', fullDescription: 'Whole Foods Market (Amazon)' })).toBe(false);
    expect(isAmazonCharge({ description: 'AMAZON WEB SERVICES' })).toBe(false);
    expect(isAmazonCharge({ description: 'DUNKIN #123' })).toBe(false);
    expect(isAmazonCharge({ description: 'Buy 1.254119 shares', fullDescription: 'Buy 1.254119 shares of AMZN (Amazon)' })).toBe(false);
  });
});

describe('matchAmazonOrders', () => {
  it('joins an order to the one charge of its total', () => {
    const o = order('112-1', '2026-09-03', 30.45, ['Dish Soap']);
    const m = matchAmazonOrders([o], [
      txn('a', '2026-09-04', -30.45),
      txn('b', '2026-09-04', -30.45, 'DUNKIN'), // same figure, not Amazon
      txn('c', '2026-09-04', -12.00),
    ]);
    expect([...m.keys()]).toEqual(['a']);
    expect(m.get('a')).toMatchObject({ order: o, via: 'order' });
  });

  it('prefers a quoted shipment total over the order total', () => {
    const o = order('112-1', '2026-09-03', 30.45, ['Cable', 'Soap'], {
      shipments: { m1: { total: 14.21, date: '2026-09-03' }, m2: { total: 16.24, date: '2026-09-05' } },
    });
    const m = matchAmazonOrders([o], [txn('a', '2026-09-03', -14.21), txn('b', '2026-09-06', -16.24)]);
    expect(m.get('a')?.via).toBe('shipment');
    expect(m.get('b')?.via).toBe('shipment');
  });

  it('finds an order shipped in pieces from charges that add up to it', () => {
    const o = order('112-1', '2026-09-03', 30.45, ['Cable', 'Soap']);
    const m = matchAmazonOrders([o], [
      txn('a', '2026-09-03', -14.21),
      txn('b', '2026-09-07', -16.24),
      txn('c', '2026-09-08', -50.00),
    ]);
    expect(m.get('a')?.via).toBe('split');
    expect(m.get('b')?.via).toBe('split');
    expect(m.has('c')).toBe(false);
  });

  it('leaves a split alone when two different sums make the total', () => {
    const o = order('112-1', '2026-09-03', 30.00, ['Cable']);
    const m = matchAmazonOrders([o], [
      txn('a', '2026-09-03', -10.00), txn('b', '2026-09-04', -20.00),
      txn('c', '2026-09-05', -12.00), txn('d', '2026-09-06', -18.00),
    ]);
    expect(m.size).toBe(0);
  });

  it('joins a refund to the positive row, never the purchase', () => {
    const o = order('113-7', '2026-09-14', 23.39, ['Cat Food'], {
      refunds: { r1: { total: 23.39, date: '2026-09-20' } },
    });
    const m = matchAmazonOrders([o], [txn('buy', '2026-09-15', -23.39), txn('back', '2026-09-22', 23.39)]);
    expect(m.get('buy')?.via).toBe('order');
    expect(m.get('back')?.via).toBe('refund');
  });

  it('will not guess between two equally near charges', () => {
    const o = order('112-1', '2026-09-03', 9.99, ['Cable']);
    const m = matchAmazonOrders([o], [txn('a', '2026-09-04', -9.99), txn('b', '2026-09-05', -9.99)]);
    expect(m.size).toBe(0);
  });

  it('gives each of two same-price orders its own month', () => {
    const jan = order('1', '2026-01-02', 23.45, ['Coffee']);
    const feb = order('2', '2026-02-02', 23.45, ['Coffee']);
    const m = matchAmazonOrders([feb, jan], [txn('x', '2026-01-03', -23.45), txn('y', '2026-02-03', -23.45)]);
    expect(m.get('x')?.order).toBe(jan);
    expect(m.get('y')?.order).toBe(feb);
  });

  it('ignores charges outside the window', () => {
    const o = order('112-1', '2026-09-03', 30.45, ['Soap']);
    expect(matchAmazonOrders([o], [txn('a', '2026-10-30', -30.45)]).size).toBe(0);
  });
});

describe('item suggestions', () => {
  const past = [
    order('p1', '2026-06-01', 20, ['Purina Cat Chow Complete Dry Cat Food']),
    order('p2', '2026-07-01', 21, ['Fancy Feast Wet Cat Food Variety Pack']),
    order('p3', '2026-07-10', 12, ['Anker USB C Cable, 6ft']),
    order('p4', '2026-08-01', 15, ['Dawn Dish Soap']),
  ];
  const rows = [
    txn('t1', '2026-06-02', -20, undefined, { category: 'Pets' }),
    txn('t2', '2026-07-02', -21, undefined, { category: 'Pets' }),
    txn('t3', '2026-07-11', -12, undefined, { category: 'Shopping' }),
    txn('t4', '2026-08-02', -15, undefined, { category: 'Household' }),
  ];
  const matches = matchAmazonOrders(past, rows);
  const index = buildItemIndex(rows, matches);

  it('learns item words from categorized, joined rows', () => {
    expect(index.size).toBe(4);
  });

  it('suggests the category past orders of the same thing went to', () => {
    const s = suggestFromItems(order('n', '2026-09-01', 30, ['Purina ONE Cat Food, Salmon']), index);
    expect(s[0]).toMatchObject({ category: 'Pets', source: 'items' });
    expect(s[0].reason).toMatch(/Past Amazon orders with “\w+”/);
  });

  it('says nothing when no item word has been seen before', () => {
    expect(suggestFromItems(order('n', '2026-09-01', 30, ['Garden Hose Nozzle']), index)).toEqual([]);
  });

  it('puts the item evidence ahead of the merchant evidence', () => {
    const merged = withItemSuggestions(
      [{ category: 'Pets', confidence: 0.5, source: 'items' }],
      [{ category: 'Shopping', confidence: 0.9, source: 'merchant' }, { category: 'Pets', confidence: 0.3 }],
    );
    expect(merged.map(s => s.category)).toEqual(['Pets', 'Shopping']);
  });

  it('summarises the items for a card', () => {
    expect(itemSummary(order('n', '', 1, ['A thing', 'B thing', 'C thing']))).toBe('A thing · B thing +1 more');
  });
});

describe('describeAmazonMatch', () => {
  const order = { orderId: '113-1234567-7654321', total: 42.5 };
  it('names the figure the amount matched', () => {
    expect(describeAmazonMatch({ order, via: 'order' })).toBe('Exact amount matched to the order total of Amazon order 113-1234567-7654321 (from Gmail)');
    expect(describeAmazonMatch({ order, via: 'shipment' })).toMatch(/shipment email/);
    expect(describeAmazonMatch({ order, via: 'refund' })).toMatch(/refund email/);
    expect(describeAmazonMatch({ order, via: 'split' })).toMatch(/add up exactly to the \$42\.50 total/);
  });
  it('says nothing without an order', () => {
    expect(describeAmazonMatch(undefined)).toBe('');
  });
});

describe('amazonOrderUrl', () => {
  it('links a well-formed order id and nothing else', () => {
    expect(amazonOrderUrl({ orderId: '113-1234567-7654321' })).toBe('https://www.amazon.com/gp/your-account/order-details?orderID=113-1234567-7654321');
    expect(amazonOrderUrl({ orderId: 'D01-1234567-7654321' })).toMatch(/orderID=D01/);
    expect(amazonOrderUrl({ orderId: '"><script>' })).toBe('');
  });
});

describe('amazonImportStalled', () => {
  const orders = [{ orderId: 'a', updatedAt: '2026-10-14T13:49:04.763Z' }];
  const today = new Date('2026-10-21T12:00:00Z');
  const charge = (date, description, id = date + description) => ({ date, description, amount: -20, transactionId: id });

  it('flags Amazon charges that arrived well after the last import', () => {
    const txns = [charge('10/18/2026', 'Amazon Mktpl*w99'), charge('10/20/2026', 'Amazon.com*i45')];
    expect(amazonImportStalled(orders, txns, new Map(), today)).toEqual({
      lastImport: '2026-10-14T13:49:04.763Z', missed: 2, newestCharge: '10/20/2026',
    });
  });
  it('ignores charges that never have an email, and ones already matched', () => {
    const txns = [
      charge('10/18/2026', 'Amazon Tips*591'),
      charge('10/19/2026', 'Amazon Grocery Subscri'),
      charge('10/20/2026', 'Amazon Prime*ab'),
      charge('10/20/2026', 'Amazon Mktpl*x', 'joined'),
    ];
    expect(amazonImportStalled(orders, txns, new Map([['joined', {}]]), today)).toBeNull();
  });
  it('gives a fresh charge a couple of days to be joined', () => {
    expect(amazonImportStalled(orders, [charge('10/16/2026', 'Amazon Mktpl*q')], new Map(), today)).toBeNull();
  });
  it('stays quiet when the import ran recently or never ran', () => {
    const txns = [charge('10/20/2026', 'Amazon Mktpl*w99')];
    expect(amazonImportStalled([{ updatedAt: '2026-10-20T10:00:00Z' }], txns, new Map(), today)).toBeNull();
    expect(amazonImportStalled([], txns, new Map(), today)).toBeNull();
  });
});

describe('Whole Foods orders', () => {
  const wf = (total, extra = {}) => order('113-4444444-5555555', '2026-10-18', total, ['Groceries'], { grocery: true, ...extra });
  const charge = (id, date, amount) => txn(id, date, amount, 'Amazon.com*i45kj1lw3');
  const tip = (id, date, amount = -5) => txn(id, date, amount, 'Amazon Tips*591uv77q2');

  it('joins the charge at the total less the tip, and the tip charge with it', () => {
    const o = wf(98.65);
    const m = matchAmazonOrders([o], [charge('c', '2026-10-20', -93.65), tip('t', '2026-10-19'), tip('old', '2026-10-01')]);
    expect(m.get('c')).toMatchObject({ order: o, via: 'grocery', tip: 5 });
    expect(m.get('t')).toMatchObject({ order: o, via: 'tip', tip: 5 });
    expect(m.has('old')).toBe(false);
  });
  it('uses the tip the email states', () => {
    const o = wf(100, { tip: 7 });
    const m = matchAmazonOrders([o], [charge('c', '2026-10-19', -93), charge('x', '2026-10-19', -95), tip('t', '2026-10-19', -7)]);
    expect(m.get('c')?.via).toBe('grocery');
    expect(m.has('x')).toBe(false);
    expect(m.get('t')?.via).toBe('tip');
  });
  it('falls back to the whole total when there was no tip', () => {
    const m = matchAmazonOrders([wf(60)], [charge('c', '2026-10-19', -60)]);
    expect(m.get('c')).toMatchObject({ via: 'grocery', tip: 0 });
  });
  it('does not take the tip charge itself as the order', () => {
    const m = matchAmazonOrders([wf(10)], [tip('t1', '2026-10-19'), tip('t2', '2026-10-19')]);
    expect(m.size).toBe(0);
  });
  it('describes both rows', () => {
    const o = wf(98.65);
    expect(describeAmazonMatch({ order: o, via: 'grocery', tip: 5 })).toMatch(/less the \$5\.00 tip/);
    expect(describeAmazonMatch({ order: o, via: 'tip', tip: 5 })).toMatch(/\$5\.00 delivery tip/);
  });
});

describe('a Whole Foods slot booked well ahead', () => {
  it('is matched from the delivery, not from when it was ordered', () => {
    const o = order('111-6962290-1031468', '2026-10-05', 98.65, ['Whole Foods groceries'], { grocery: true, totalDate: '2026-10-19' });
    const m = matchAmazonOrders([o], [
      txn('c', '10/20/2026', -93.65, 'Amazon.com*i45kj1lw3'),
      txn('t', '10/19/2026', -5, 'Amazon Tips*591uv77q2'),
    ]);
    expect(m.get('c')).toMatchObject({ via: 'grocery', tip: 5 });
    expect(m.get('t')?.via).toBe('tip');
  });
});

describe('a Whole Foods charge whose tip has not posted yet', () => {
  it('is matched at the usual $5 off', () => {
    const o = order('111-6962290-1031468', '2026-10-17', 98.65, ['Whole Foods groceries'], { grocery: true, totalDate: '2026-10-19' });
    const m = matchAmazonOrders([o], [txn('c', '10/20/2026', -93.65, 'Amazon.com*i45kj1lw3')]);
    expect(m.get('c')).toMatchObject({ via: 'grocery', tip: 5 });
  });
});
