/* The browser side of the weekly email: where it goes, and asking the server
   to send it now. Shared by Settings and the header's "Send Weekly Email"
   button so both send to the same recipient. */

const DEFAULT_RECIPIENT = 'baldaufdan@gmail.com';

export function loadEmailPrefs() {
  try {
    return {
      recipient: DEFAULT_RECIPIENT,
      sendDay: 'Sun',
      ...JSON.parse(localStorage.getItem('weeklyEmailPrefs') || '{}'),
    };
  } catch {
    return { recipient: DEFAULT_RECIPIENT, sendDay: 'Sun' };
  }
}

export function saveEmailPrefs(prefs) {
  localStorage.setItem('weeklyEmailPrefs', JSON.stringify(prefs));
}

/**
 * Send last completed week's summary right away, skipping the send-day gate.
 * `test` marks the subject "[Test]"; otherwise it's the same email the cron
 * sends. Resolves to { ok, to, error } — never throws.
 */
export async function sendWeeklyEmail({ recipient, test = false } = {}) {
  try {
    const res = await fetch(`/api/weekly-summary?${test ? 'test=1' : 'manual=1'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.sent) return { ok: false, error: body.error || `HTTP ${res.status}` };
    return { ok: true, to: body.to };
  } catch (err) {
    return { ok: false, error: err.message || 'Network error' };
  }
}
