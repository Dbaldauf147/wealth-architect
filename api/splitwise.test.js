import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from './splitwise.js';

/** Minimal stand-in for the Vercel response object. */
function mockRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const OK = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });

let originalKey;

beforeEach(() => {
  originalKey = process.env.SPLITWISE_API_KEY;
  process.env.SPLITWISE_API_KEY = 'test-key';
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.SPLITWISE_API_KEY;
  else process.env.SPLITWISE_API_KEY = originalKey;
  vi.unstubAllGlobals();
});

describe('GET /api/splitwise', () => {
  it('says what is missing when no key is configured', async () => {
    delete process.env.SPLITWISE_API_KEY;
    const res = mockRes();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.error).toMatch(/SPLITWISE_API_KEY/);
  });

  it('rejects anything but GET', async () => {
    const res = mockRes();
    await handler({ method: 'POST', query: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it('sends the key as a bearer token and never in the query string', async () => {
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.Authorization });
      return OK({ user: { id: 1 }, friends: [], groups: [], expenses: [] });
    }));
    await handler({ method: 'GET', query: {} }, mockRes());
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.auth).toBe('Bearer test-key');
      expect(call.url).not.toContain('test-key');
      expect(call.url.startsWith('https://secure.splitwise.com/api/v3.0/')).toBe(true);
    }
  });

  it('pages through get_expenses until a short page comes back', async () => {
    const page = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));
    let expenseCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('get_current_user')) return OK({ user: { id: 1 } });
      if (u.includes('get_friends')) return OK({ friends: [] });
      if (u.includes('get_groups')) return OK({ groups: [] });
      expenseCalls += 1;
      // Two full pages, then a partial one that ends the walk.
      return OK({ expenses: expenseCalls <= 2 ? page(100) : page(7) });
    }));
    const res = mockRes();
    await handler({ method: 'GET', query: {} }, res);
    expect(expenseCalls).toBe(3);
    expect(res.body.expenses).toHaveLength(207);
  });

  it('passes the window through as dated_after', async () => {
    let datedAfter = null;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('get_expenses')) datedAfter = u.searchParams.get('dated_after');
      return OK({ user: { id: 1 }, friends: [], groups: [], expenses: [] });
    }));
    await handler({ method: 'GET', query: { days: '30' } }, mockRes());
    const ageDays = (Date.now() - new Date(datedAfter).getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(29.9);
    expect(ageDays).toBeLessThan(30.1);
  });

  it('clamps an absurd window rather than asking Splitwise for everything', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => OK({ user: { id: 1 }, friends: [], groups: [], expenses: [] })));
    const res = mockRes();
    await handler({ method: 'GET', query: { days: '99999' } }, res);
    expect(res.body.days).toBe(730);
  });

  it('calls a bad key a configuration fault, not a bad gateway', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401, text: async () => JSON.stringify({ error: 'Invalid API request' }),
    })));
    const res = mockRes();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBeTruthy();
  });

  it('reports an upstream failure as a bad gateway', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 503, text: async () => 'upstream down',
    })));
    const res = mockRes();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(502);
  });

  it('reports a timeout as a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    }));
    const res = mockRes();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(504);
    expect(res.body.error).toMatch(/too long/i);
  });
});
