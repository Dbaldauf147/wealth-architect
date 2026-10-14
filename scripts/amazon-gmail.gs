/**
 * Amazon order emails → Wealth Architect.
 *
 * Paste this whole file into a new project at https://script.google.com while
 * signed in to the Gmail account that receives your Amazon email. It runs as
 * you, reads only Amazon's order, shipment and refund emails, and posts them
 * to /api/amazon-email, which keeps the order number, totals and item names
 * and nothing else.
 *
 * One-time setup (see "Amazon order emails" in README.md):
 *   1. Project Settings → Script properties → add INGEST_SECRET with the same
 *      value as AMAZON_EMAIL_SECRET (or SPEND_ALERT_SECRET) in Vercel.
 *   2. Run dryRun() and read the log — it shows what the server read out of
 *      your five newest Amazon emails, without saving anything.
 *   3. Run backfill() once to load the last ~18 months.
 *   4. Run installTrigger() once; sync() then runs every hour on its own.
 */

const ENDPOINT = 'https://wealth-architect-delta.vercel.app/api/amazon-email';

// Amazon's transactional senders. Marketing comes from other addresses and is
// left alone; the server ignores anything that isn't an order regardless.
const QUERY = 'from:(auto-confirm@amazon.com OR shipment-tracking@amazon.com OR order-update@amazon.com '
  + 'OR return@amazon.com OR digital-no-reply@amazon.com OR payments-messages@amazon.com)';

const BATCH = 25;

function secret_() {
  const s = PropertiesService.getScriptProperties().getProperty('INGEST_SECRET');
  if (!s) throw new Error('Set INGEST_SECRET under Project Settings → Script properties first.');
  return s;
}

function toPayload_(msg) {
  return {
    id: msg.getId(),
    subject: msg.getSubject(),
    from: msg.getFrom(),
    date: msg.getDate().toISOString(),
    body: msg.getPlainBody().slice(0, 40000),
  };
}

function post_(emails, dry) {
  if (!emails.length) return { ok: true, saved: 0, ignored: [] };
  const res = UrlFetchApp.fetch(ENDPOINT + (dry ? '?dry=1' : ''), {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ingest-secret': secret_() },
    payload: JSON.stringify({ emails }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('amazon-email returned ' + code + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText());
}

/** Every Amazon message in threads matching `query`, received at or after `sinceMs`. */
function collect_(query, sinceMs, maxThreads) {
  const out = [];
  for (let start = 0; start < maxThreads; start += 100) {
    const threads = GmailApp.search(query, start, Math.min(100, maxThreads - start));
    if (!threads.length) break;
    for (const thread of threads) {
      for (const msg of thread.getMessages()) {
        if (msg.getDate().getTime() >= sinceMs) out.push(msg);
      }
    }
  }
  return out;
}

function send_(messages) {
  let saved = 0;
  let ignored = 0;
  for (let i = 0; i < messages.length; i += BATCH) {
    const r = post_(messages.slice(i, i + BATCH).map(toPayload_), false);
    saved += r.saved || 0;
    ignored += (r.ignored || []).length;
  }
  return { saved, ignored };
}

/** Hourly: anything new since the last successful run, with an hour of overlap. */
function sync() {
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty('LAST_SYNC_MS')) || (Date.now() - 3 * 86400000);
  const since = last - 3600000;
  const startedAt = Date.now();
  const messages = collect_(QUERY + ' after:' + Math.floor(since / 1000), since, 300);
  const r = send_(messages);
  // Only moved forward once everything posted, so a failed run is retried.
  props.setProperty('LAST_SYNC_MS', String(startedAt));
  console.log('Amazon sync: ' + r.saved + ' saved, ' + r.ignored + ' ignored');
}

/**
 * Once: the last ~18 months, which is what teaches the suggestions. Works a
 * month at a time and remembers where it got to, because a script run is cut
 * off at six minutes — if the log says to, just run it again.
 */
function backfill() {
  const props = PropertiesService.getScriptProperties();
  const DAY = 86400000;
  const startedAt = Date.now();
  let cursor = Number(props.getProperty('BACKFILL_CURSOR_MS')) || (startedAt - 548 * DAY);
  let total = 0;
  while (cursor < startedAt) {
    if (Date.now() - startedAt > 4.5 * 60000) {
      console.log('Backfill paused at ' + new Date(cursor).toDateString() + ' after ' + total + ' emails — run backfill() again to continue.');
      return;
    }
    const end = Math.min(cursor + 30 * DAY, startedAt);
    const q = QUERY + ' after:' + Math.floor(cursor / 1000) + ' before:' + Math.floor(end / 1000);
    const messages = collect_(q, cursor, 500).filter(m => m.getDate().getTime() < end);
    send_(messages);
    total += messages.length;
    cursor = end;
    props.setProperty('BACKFILL_CURSOR_MS', String(cursor));
  }
  if (!props.getProperty('LAST_SYNC_MS')) props.setProperty('LAST_SYNC_MS', String(startedAt));
  console.log('Backfill complete: ' + total + ' emails this run.');
}

/** Check the parsing against your real mail. Saves nothing. */
function dryRun() {
  const threads = GmailApp.search(QUERY, 0, 5);
  const emails = threads.map(t => toPayload_(t.getMessages()[t.getMessages().length - 1]));
  console.log(JSON.stringify(post_(emails, true), null, 2));
}

/**
 * Show the emails behind a few orders that were saved with no amount, so the
 * layout hiding the total can be fixed on the server. Saves nothing. Searches
 * all Amazon mail for each order number, not just the senders above, in case
 * the confirmation came from somewhere else.
 */
function dryRunMissing() {
  const res = UrlFetchApp.fetch(ENDPOINT + '?missing=1', {
    method: 'get',
    headers: { 'x-ingest-secret': secret_() },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('amazon-email returned ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  const missing = JSON.parse(res.getContentText());
  console.log(missing.count + ' orders have no amount. Looking at: ' + missing.orderIds.join(', '));
  for (const orderId of missing.orderIds.slice(0, 3)) {
    const emails = [];
    for (const thread of GmailApp.search('from:amazon.com "' + orderId + '"', 0, 5)) {
      for (const msg of thread.getMessages()) emails.push(toPayload_(msg));
    }
    if (!emails.length) { console.log(orderId + ': no emails found'); continue; }
    const r = UrlFetchApp.fetch(ENDPOINT + '?dry=1&sample=1', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-ingest-secret': secret_() },
      payload: JSON.stringify({ emails: emails.slice(0, 6) }),
      muteHttpExceptions: true,
    });
    console.log(orderId + ' (' + emails.length + ' emails):\n' + r.getContentText());
  }
}

function installTrigger() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'sync') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('sync').timeBased().everyHours(1).create();
  console.log('sync() will now run every hour.');
}
