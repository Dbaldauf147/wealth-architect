import { describe, it, expect } from 'vitest';
import { parseAmazonEmail, mergeAmazonOrder, mergeItems } from './parseAmazonEmail.js';

// The newer "Ordered:" confirmation, as Gmail's getPlainBody() flattens it.
const ORDERED = {
  from: 'Amazon.com <auto-confirm@amazon.com>',
  subject: 'Ordered: "Anker USB C Cable, 6ft..." and 1 more item',
  date: '2026-09-03T14:10:00.000Z',
  body: `Amazon.com <https://www.amazon.com/ref=TE_tex_h>
Hi Dan, thanks for your order!
Arriving Friday
Ship to
Dan Baldauf
123 MAIN ST, BROOKLYN, NY

Order #
112-1234567-7654321 <https://www.amazon.com/gp/your-account/order-details?orderID=112-1234567-7654321>

* Anker USB C Cable, 6ft, 2-Pack, Nylon Braided Fast Charging Cord <https://www.amazon.com/dp/B0>
Quantity: 1
12.99 USD

* Dawn Platinum Dish Soap Liquid, Dishwashing Detergent, 3 Count
Quantity: 2
14.98 USD

Item(s) Subtotal: 27.97 USD
Shipping & Handling: 0.00 USD
Estimated tax to be collected: 2.48 USD
Grand Total:
30.45 USD
View or manage order`,
};

// The older "Your Amazon.com order #..." confirmation, dollar-sign style.
const CLASSIC = {
  from: '"Amazon.com" <auto-confirm@amazon.com>',
  subject: 'Your Amazon.com order #113-7777777-1111111 of "Purina Cat Chow Complete..."',
  date: 'Mon, 14 Sep 2026 09:02:11 -0400',
  body: `Hello Dan,
Thank you for shopping with us. Your order details are below.

Order Details
Order #113-7777777-1111111
Placed on Monday, September 14, 2026

Purina Cat Chow Complete Dry Cat Food, 15 lb Bag
Sold by: Amazon.com Services, Inc
$21.48

Item Subtotal: $21.48
Total Before Tax: $21.48
Estimated Tax: $1.91
Order Total: $23.39`,
};

const SHIPPED = {
  from: 'Amazon.com <shipment-tracking@amazon.com>',
  subject: 'Shipped: "Dawn Platinum Dish Soap Liquid..."',
  date: '2026-09-05T10:00:00.000Z',
  body: `Your package is on the way
Order # 112-1234567-7654321
Dawn Platinum Dish Soap Liquid, Dishwashing Detergent, 3 Count
Quantity: 2
Shipment Total: $16.24`,
};

const REFUND = {
  from: 'Amazon.com <return@amazon.com>',
  subject: 'Your refund for Purina Cat Chow Complete....',
  date: '2026-09-20T10:00:00.000Z',
  body: `Hello Dan,
We've issued your refund for the item below.
Order # 113-7777777-1111111
Refund subtotal: $21.48
Total refund: $23.39`,
};

describe('parseAmazonEmail', () => {
  it('reads the newer Ordered: confirmation', () => {
    const r = parseAmazonEmail(ORDERED);
    expect(r).toMatchObject({ ok: true, kind: 'order', orderId: '112-1234567-7654321', total: 30.45, date: '2026-09-03' });
    expect(r.items).toEqual([
      { name: 'Anker USB C Cable, 6ft, 2-Pack, Nylon Braided Fast Charging Cord', price: 12.99 },
      { name: 'Dawn Platinum Dish Soap Liquid, Dishwashing Detergent, 3 Count', price: 14.98 },
    ]);
  });

  it('reads the classic confirmation, and not the pre-tax total', () => {
    const r = parseAmazonEmail(CLASSIC);
    expect(r).toMatchObject({ ok: true, kind: 'order', orderId: '113-7777777-1111111', total: 23.39, date: '2026-09-14' });
    expect(r.items).toEqual([{ name: 'Purina Cat Chow Complete Dry Cat Food, 15 lb Bag', price: 21.48 }]);
  });

  it('keeps a shipment total as its own charge', () => {
    const r = parseAmazonEmail(SHIPPED);
    expect(r).toMatchObject({ ok: true, kind: 'shipment', orderId: '112-1234567-7654321', total: 16.24 });
    expect(r.items).toHaveLength(1);
  });

  it('a shipment email without a shipment total quotes no charge', () => {
    const r = parseAmazonEmail({ ...SHIPPED, body: 'Order # 112-1234567-7654321\nOrder Total: $30.45' });
    expect(r.ok).toBe(true);
    expect(r.total).toBeNull();
  });

  it('reads the refund total, not the subtotal', () => {
    const r = parseAmazonEmail(REFUND);
    expect(r).toMatchObject({ ok: true, kind: 'refund', orderId: '113-7777777-1111111', total: 23.39 });
  });

  it('falls back to the subject item when the body lists none', () => {
    const r = parseAmazonEmail({ ...ORDERED, body: 'Order # 112-1234567-7654321\nOrder Total: $30.45' });
    expect(r.items).toEqual([{ name: 'Anker USB C Cable, 6ft', price: null }]);
    expect(r.total).toBe(30.45);
  });

  it('ignores cancellations, marketing and other senders', () => {
    expect(parseAmazonEmail({ ...ORDERED, subject: 'Your order has been cancelled' }).ok).toBe(false);
    expect(parseAmazonEmail({ from: 'Amazon <store-news@amazon.com>', subject: 'Deals for you', body: '' }).ok).toBe(false);
    expect(parseAmazonEmail({ ...ORDERED, from: 'someone@example.com' }).ok).toBe(false);
    expect(parseAmazonEmail({ ...ORDERED, body: 'no order here', subject: 'Ordered: "Thing"' })).toEqual({ ok: false, reason: 'no order number' });
  });

  it('never keeps the shipping address', () => {
    const r = parseAmazonEmail(ORDERED);
    expect(JSON.stringify(r)).not.toMatch(/MAIN ST|Baldauf/);
  });
});

describe('mergeItems', () => {
  it('treats a truncated name as the same item and keeps the longer one', () => {
    expect(mergeItems([{ name: 'Anker USB C Cable', price: null }], [{ name: 'Anker USB C Cable, 6ft, 2-Pack', price: 12.99 }]))
      .toEqual([{ name: 'Anker USB C Cable, 6ft, 2-Pack', price: 12.99 }]);
  });
});

describe('mergeAmazonOrder', () => {
  it('folds every email about an order into one record, idempotently', () => {
    const order = parseAmazonEmail(ORDERED);
    const ship = parseAmazonEmail(SHIPPED);
    let doc = mergeAmazonOrder(null, ship, 'm2');
    doc = mergeAmazonOrder(doc, order, 'm1');
    doc = mergeAmazonOrder(doc, ship, 'm2');
    expect(doc.orderDate).toBe('2026-09-03');
    expect(doc.total).toBe(30.45);
    expect(doc.items).toHaveLength(2);
    expect(doc.shipments).toEqual({ m2: { total: 16.24, date: '2026-09-05' } });
  });
});
