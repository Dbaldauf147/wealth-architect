import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory Firestore: config/default plus the watchedVendorSeen collection.
const store = new Map();
const docRef = (col, id) => ({
  get: async () => {
    const v = store.get(`${col}/${id}`);
    return { exists: v !== undefined, data: () => v };
  },
  _key: `${col}/${id}`,
});
const db = {
  collection: col => ({ doc: id => docRef(col, id) }),
  batch: () => {
    const ops = [];
    return { set: (ref, v) => ops.push([ref._key, v]), commit: async () => { for (const [k, v] of ops) store.set(k, v); } };
  },
};
vi.mock('firebase-admin/app', () => ({ initializeApp: () => {}, cert: () => ({}), getApps: () => [{}] }));
vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => db }));
const sendMail = vi.fn(async () => ({}));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));

const { default: handler } = await import('./watched-vendors.js');

let sheetRows;
function run(query = {}) {
  return new Promise(resolve => {
    const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); } };
    handler({ headers: {}, query }, res);
  });
}

beforeEach(() => {
  store.clear();
  sendMail.mockClear();
  Object.assign(process.env, { SHEETS_API_KEY: 'k', SHEETS_SHEET_ID: 's', GMAIL_USER: 'me@example.com', GMAIL_APP_PASSWORD: 'p' });
  delete process.env.CRON_SECRET;
  delete process.env.EMAIL_TO;
  sheetRows = [
    ['Date', 'Description', 'Category', 'Amount', 'Account', 'Institution', 'Transaction ID', 'Full Description'],
    ['2026-11-01', 'DOORDASH*CHIPOTLE', 'Eating Out', '-$24.50', 'Sapphire', 'Chase', 'a', ''],
    ['2026-11-02', 'SHELL', 'Gas', '-60', 'Gold', 'Amex', 'c', ''],
  ];
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ values: sheetRows }) }));
  store.set('config/default', { watchedVendors: [{ id: 'dd', description: 'doordash', sign: 'negative', minAmount: null, maxAmount: null, email: true }] });
});

describe('api/watched-vendors', () => {
  it('baselines on the first run, then emails only the new transaction, once', async () => {
    let r = await run();
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ sent: false, baselined: ['dd'] });
    expect(sendMail).not.toHaveBeenCalled();
    expect(store.get('watchedVendorSeen/dd').seen).toEqual(['a']);

    sheetRows.push(['2026-11-05', 'DOORDASH*SWEETGREEN', 'Eating Out', '-80', 'Sapphire', 'Chase', 'e', '']);
    r = await run({ dry: '1' });
    expect(r.body).toMatchObject({ dry: true, newTransactions: [{ vendor: 'doordash', count: 1 }] });
    expect(sendMail).not.toHaveBeenCalled();

    r = await run();
    expect(r.body).toMatchObject({ sent: true, to: 'me@example.com' });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].subject).toBe('Flagged vendor: new transaction at doordash');
    expect(sendMail.mock.calls[0][0].html).toContain('DOORDASH*SWEETGREEN');

    r = await run();
    expect(r.body.sent).toBe(false);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('does not mark rows seen when the send fails', async () => {
    await run();
    sheetRows.push(['2026-11-05', 'DOORDASH*X', '', '-8', '', '', 'e', '']);
    sendMail.mockRejectedValueOnce(new Error('smtp down'));
    const r = await run();
    expect(r.code).toBe(500);
    expect(store.get('watchedVendorSeen/dd').seen).toEqual(['a']);
  });

  it('skips when nothing is flagged, and honours CRON_SECRET', async () => {
    store.set('config/default', {});
    expect((await run()).body).toMatchObject({ skipped: true });
    process.env.CRON_SECRET = 'sekret';
    expect((await run()).code).toBe(401);
  });
});
