import { useMemo, useState } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { buildWeeklySummary, lastCompletedWeek } from '../lib/weeklySummary';
import { renderWeeklyEmailHtml, WEEKLY_EMAIL_SECTIONS } from '../lib/renderWeeklyEmail';
import { previewPaymentReminder, renderPaymentReminderHtml } from '../lib/paymentReminder';
import styles from './SettingsPage.module.css';

function relTime(date) {
  if (!date) return 'Never';
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function loadEmailPrefs() {
  try {
    return {
      recipient: 'baldaufdan@gmail.com',
      sendDay: 'Sun',
      ...JSON.parse(localStorage.getItem('weeklyEmailPrefs') || '{}'),
    };
  } catch {
    return { recipient: 'baldaufdan@gmail.com', sendDay: 'Sun' };
  }
}

function saveEmailPrefs(prefs) {
  localStorage.setItem('weeklyEmailPrefs', JSON.stringify(prefs));
}

export function SettingsPage() {
  const { loading, error, lastSync, analytics, balances, transactions, accountNicknames, accountGroups, hiddenCards, paymentReminderPrefs, weeklyEmailSections } = useData();
  const { refresh, updatePaymentReminderPrefs, updateWeeklyEmailSections } = useDataActions();
  const SECTION_LABELS = Object.fromEntries(WEEKLY_EMAIL_SECTIONS.map(s => [s.id, s.label]));
  const [emailPrefs, setEmailPrefs] = useState(loadEmailPrefs);
  const [sendStatus, setSendStatus] = useState(null); // null | 'sending' | 'ok' | 'err'
  const [reminderTestStatus, setReminderTestStatus] = useState(null); // null | 'sending' | 'ok' | 'err' | 'none'

  const previewHtml = useMemo(() => {
    const { start, end } = lastCompletedWeek();
    const summary = buildWeeklySummary({
      transactions: transactions || [],
      start,
      end,
      accountNicknames: accountNicknames || {},
      accountGroups: accountGroups || {},
    });
    return renderWeeklyEmailHtml(summary, { sections: weeklyEmailSections });
  }, [transactions, accountNicknames, accountGroups, weeklyEmailSections]);

  // Reorder / toggle weekly-email sections. Each handler rebuilds the full
  // ordered list and persists it (which also syncs to Firestore for the cron).
  function moveSection(idx, dir) {
    const arr = (weeklyEmailSections || []).map(s => ({ ...s }));
    const j = idx + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    updateWeeklyEmailSections(arr);
  }
  function toggleSection(idx) {
    const arr = (weeklyEmailSections || []).map(s => ({ ...s }));
    arr[idx] = { ...arr[idx], enabled: !arr[idx].enabled };
    updateWeeklyEmailSections(arr);
  }

  function updatePrefs(patch) {
    setEmailPrefs(prev => {
      const next = { ...prev, ...patch };
      saveEmailPrefs(next);
      return next;
    });
  }

  async function sendTest() {
    setSendStatus('sending');
    try {
      const res = await fetch('/api/weekly-summary?test=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: emailPrefs.recipient }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSendStatus('ok');
    } catch {
      setSendStatus('err');
    }
    setTimeout(() => setSendStatus(null), 4000);
  }

  // Build the "what would this email look like" preview from current
  // transactions/balances, dated to (next projected payment - 1 day).
  const reminderPreview = useMemo(() => {
    if (!balances || !transactions) return null;
    return previewPaymentReminder({
      transactions,
      balances,
      hiddenCards: hiddenCards || [],
      nicknames: accountNicknames || {},
      payingAccountLast4: (paymentReminderPrefs && paymentReminderPrefs.payingAccountLast4) || '1118',
    });
  }, [transactions, balances, hiddenCards, accountNicknames, paymentReminderPrefs]);

  const reminderPreviewHtml = useMemo(
    () => (reminderPreview && reminderPreview.payload) ? renderPaymentReminderHtml(reminderPreview.payload) : null,
    [reminderPreview],
  );

  async function sendReminderTest() {
    setReminderTestStatus('sending');
    try {
      const res = await fetch('/api/payment-reminder?test=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: emailPrefs.recipient }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      // The endpoint returns { skipped: true, reason: ... } when nothing is
      // due tomorrow even in test mode (well — test bypasses the disable
      // flag but still respects "no cards due"). Surface that distinctly so
      // the user knows it ran but had nothing to send.
      setReminderTestStatus(data && data.skipped ? 'none' : 'ok');
    } catch {
      setReminderTestStatus('err');
    }
    setTimeout(() => setReminderTestStatus(null), 5000);
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h2 className={styles.pageTitle}>Settings</h2>
        <p className={styles.pageSubtitle}>Manage your data connections and preferences</p>
      </div>

      {/* Google Sheets Connection */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Google Sheets Integration</h3>
        <div className={styles.card}>
          <div className={styles.cardRow}>
            <div className={styles.cardRowIcon}>
              <span className="material-symbols-outlined">table_chart</span>
            </div>
            <div className={styles.cardRowContent}>
              <div className={styles.cardRowLabel}>Connected Sheet</div>
              <div className={styles.cardRowValue}>Tiller Financial Spreadsheet</div>
            </div>
            <div className={styles.statusBadgeGreen}>Active</div>
          </div>

          <div className={styles.divider} />

          <div className={styles.statsGrid}>
            <div className={styles.statItem}>
              <div className={styles.statLabel}>Last Sync</div>
              <div className={styles.statValue}>{relTime(lastSync)}</div>
            </div>
            <div className={styles.statItem}>
              <div className={styles.statLabel}>Transactions Loaded</div>
              <div className={styles.statValue}>{analytics?.transactionCount?.toLocaleString() || '—'}</div>
            </div>
            <div className={styles.statItem}>
              <div className={styles.statLabel}>Asset Accounts</div>
              <div className={styles.statValue}>{balances?.assets?.length || '—'}</div>
            </div>
            <div className={styles.statItem}>
              <div className={styles.statLabel}>Liability Accounts</div>
              <div className={styles.statValue}>{balances?.liabilities?.length || '—'}</div>
            </div>
          </div>

          <div className={styles.divider} />

          <div className={styles.cardActions}>
            <button className={styles.primaryBtn} onClick={refresh} disabled={loading}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{loading ? 'hourglass_empty' : 'sync'}</span>
              {loading ? 'Syncing...' : 'Force Sync Now'}
            </button>
            <a
              className={styles.secondaryBtn}
              href="https://docs.google.com/spreadsheets/d/1G9dU4_Lt0vVHeH3UzwDUUc-fFs6rAy7d9THKYtOebCY/edit"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>open_in_new</span>
              Open in Google Sheets
            </a>
          </div>

          {error && (
            <div className={styles.errorBox}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>error</span>
              {error}
            </div>
          )}
        </div>
      </section>

      {/* Data Sources */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Data Sources</h3>
        <div className={styles.card}>
          <div className={styles.cardRow}>
            <div className={styles.cardRowIcon}>
              <span className="material-symbols-outlined">receipt_long</span>
            </div>
            <div className={styles.cardRowContent}>
              <div className={styles.cardRowLabel}>Transactions Tab</div>
              <div className={styles.cardRowValue}>Columns B-O: Date, Description, Category, Amount, Account, Institution...</div>
            </div>
            <div className={styles.statusBadgeGreen}>Connected</div>
          </div>
          <div className={styles.divider} />
          <div className={styles.cardRow}>
            <div className={styles.cardRowIcon}>
              <span className="material-symbols-outlined">account_balance</span>
            </div>
            <div className={styles.cardRowContent}>
              <div className={styles.cardRowLabel}>Balances Tab</div>
              <div className={styles.cardRowValue}>Tiller format: Net worth, assets, liabilities with account details</div>
            </div>
            <div className={styles.statusBadgeGreen}>Connected</div>
          </div>
        </div>
      </section>

      {/* Weekly Email Summary */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Weekly Email Summary</h3>
        <div className={styles.card}>
          <div className={styles.cardRow}>
            <div className={styles.cardRowIcon}>
              <span className="material-symbols-outlined">mail</span>
            </div>
            <div className={styles.cardRowContent}>
              <div className={styles.cardRowLabel}>Recipient</div>
              <input
                type="email"
                value={emailPrefs.recipient}
                onChange={e => updatePrefs({ recipient: e.target.value })}
                style={{
                  width: '100%', maxWidth: 320, padding: '6px 10px',
                  border: '1px solid var(--border-ghost)', borderRadius: 8,
                  fontSize: 13, outline: 'none', background: 'var(--color-surface-alt)',
                }}
              />
            </div>
          </div>

          <div className={styles.divider} />

          <div className={styles.cardRow}>
            <div className={styles.cardRowIcon}>
              <span className="material-symbols-outlined">schedule</span>
            </div>
            <div className={styles.cardRowContent}>
              <div className={styles.cardRowLabel}>Send day (covers prior Mon–Sun)</div>
              <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                {DAYS.map(d => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => updatePrefs({ sendDay: d })}
                    style={{
                      padding: '4px 10px', fontSize: 12, fontWeight: 600,
                      border: `1px solid ${emailPrefs.sendDay === d ? 'var(--color-secondary, #0058be)' : 'var(--border-ghost)'}`,
                      background: emailPrefs.sendDay === d ? 'var(--color-secondary, #0058be)' : 'transparent',
                      color: emailPrefs.sendDay === d ? '#fff' : 'var(--color-text-secondary)',
                      borderRadius: 6, cursor: 'pointer',
                    }}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
                Fires at 8:00 AM ET. Your preference is saved locally — once the backend is deployed I'll wire it in so the server reads it.
              </div>
            </div>
          </div>

          <div className={styles.divider} />

          <div className={styles.cardActions}>
            <button
              className={styles.primaryBtn}
              onClick={sendTest}
              disabled={sendStatus === 'sending'}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                {sendStatus === 'sending' ? 'hourglass_empty' : 'send'}
              </span>
              {sendStatus === 'sending' ? 'Sending...' : 'Send test summary now'}
            </button>
            {sendStatus === 'ok' && <span style={{ color: '#16a34a', fontSize: 12, fontWeight: 600 }}>✓ Sent — check your inbox.</span>}
            {sendStatus === 'err' && <span style={{ color: '#b91c1c', fontSize: 12, fontWeight: 600 }}>Send failed. Backend not deployed yet?</span>}
          </div>

          <div className={styles.divider} />

          <div className={styles.cardRow}>
            <div className={styles.cardRowIcon}>
              <span className="material-symbols-outlined">reorder</span>
            </div>
            <div className={styles.cardRowContent}>
              <div className={styles.cardRowLabel}>Sections (order &amp; visibility)</div>
              <div className={styles.cardRowValue} style={{ marginBottom: 8 }}>
                Reorder with the arrows and toggle the checkbox to show or hide a section. The header and footer always appear.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 460 }}>
                {(weeklyEmailSections || []).map((s, idx) => (
                  <div
                    key={s.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 10px', borderRadius: 8,
                      border: '1px solid var(--border-ghost)',
                      background: s.enabled ? 'var(--color-surface)' : 'var(--color-surface-alt)',
                      opacity: s.enabled ? 1 : 0.6,
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <button
                        type="button"
                        onClick={() => moveSection(idx, -1)}
                        disabled={idx === 0}
                        title="Move up"
                        style={{ border: 'none', background: 'transparent', cursor: idx === 0 ? 'default' : 'pointer', color: 'var(--color-text-tertiary)', lineHeight: 0, padding: 0, opacity: idx === 0 ? 0.3 : 1 }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>keyboard_arrow_up</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => moveSection(idx, 1)}
                        disabled={idx === (weeklyEmailSections.length - 1)}
                        title="Move down"
                        style={{ border: 'none', background: 'transparent', cursor: idx === (weeklyEmailSections.length - 1) ? 'default' : 'pointer', color: 'var(--color-text-tertiary)', lineHeight: 0, padding: 0, opacity: idx === (weeklyEmailSections.length - 1) ? 0.3 : 1 }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>keyboard_arrow_down</span>
                      </button>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-tertiary)', width: 18, textAlign: 'center' }}>{idx + 1}</span>
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                      {SECTION_LABELS[s.id] || s.id}
                    </span>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={s.enabled} onChange={() => toggleSection(idx)} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: s.enabled ? 'var(--color-success)' : 'var(--color-text-tertiary)' }}>
                        {s.enabled ? 'Shown' : 'Hidden'}
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className={styles.divider} />

          <div style={{ padding: '4px 2px 12px' }}>
            <div className={styles.cardRowLabel} style={{ marginBottom: 8 }}>Preview (last completed week)</div>
            <iframe
              title="Weekly email preview"
              srcDoc={previewHtml}
              style={{
                width: '100%', height: 640, border: '1px solid var(--border-ghost)',
                borderRadius: 10, background: '#f8fafc',
              }}
            />
          </div>
        </div>
      </section>

      {/* Card Payment Reminder */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Card Payment Reminder</h3>
        <div className={styles.card}>
          <div className={styles.cardRow}>
            <div className={styles.cardRowIcon}>
              <span className="material-symbols-outlined">credit_score</span>
            </div>
            <div className={styles.cardRowContent}>
              <div className={styles.cardRowLabel}>Enabled</div>
              <div className={styles.cardRowValue}>
                Send an email the day before any non-hidden card has a projected payment.
              </div>
              <div style={{ marginTop: 8 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={paymentReminderPrefs?.enabled !== false}
                    onChange={e => updatePaymentReminderPrefs({ enabled: e.target.checked })}
                  />
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                    {paymentReminderPrefs?.enabled !== false ? 'On' : 'Off'}
                  </span>
                </label>
              </div>
            </div>
            <div className={paymentReminderPrefs?.enabled !== false ? styles.statusBadgeGreen : ''} style={paymentReminderPrefs?.enabled === false ? { fontSize: 11, fontWeight: 700, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5 } : undefined}>
              {paymentReminderPrefs?.enabled !== false ? 'Active' : 'Off'}
            </div>
          </div>

          <div className={styles.divider} />

          <div className={styles.cardRow}>
            <div className={styles.cardRowIcon}>
              <span className="material-symbols-outlined">account_balance</span>
            </div>
            <div className={styles.cardRowContent}>
              <div className={styles.cardRowLabel}>Paying account (last 4 digits)</div>
              <div className={styles.cardRowValue}>
                Matched against your asset names — the email shows this account's balance and after-payment runway.
              </div>
              <input
                type="text"
                inputMode="numeric"
                maxLength={4}
                value={paymentReminderPrefs?.payingAccountLast4 || ''}
                onChange={e => updatePaymentReminderPrefs({ payingAccountLast4: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                placeholder="1118"
                style={{
                  marginTop: 6, width: 100, padding: '6px 10px',
                  border: '1px solid var(--border-ghost)', borderRadius: 8,
                  fontSize: 13, outline: 'none', background: 'var(--color-surface-alt)',
                  fontFamily: 'monospace', letterSpacing: 1,
                }}
              />
            </div>
          </div>

          <div className={styles.divider} />

          <div className={styles.cardRow}>
            <div className={styles.cardRowIcon}>
              <span className="material-symbols-outlined">schedule</span>
            </div>
            <div className={styles.cardRowContent}>
              <div className={styles.cardRowLabel}>Schedule</div>
              <div className={styles.cardRowValue}>
                Daily check at 10:00 AM ET. Triggers only when a card's projected next payment date is tomorrow. Hidden cards from the Cards page are ignored.
              </div>
              {reminderPreview?.projectedDate && (
                <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
                  Next projected payment: <strong style={{ color: 'var(--color-text-secondary)' }}>{reminderPreview.projectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</strong>
                </div>
              )}
            </div>
          </div>

          <div className={styles.divider} />

          <div className={styles.cardActions}>
            <button
              className={styles.primaryBtn}
              onClick={sendReminderTest}
              disabled={reminderTestStatus === 'sending'}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                {reminderTestStatus === 'sending' ? 'hourglass_empty' : 'send'}
              </span>
              {reminderTestStatus === 'sending' ? 'Sending...' : 'Send test reminder now'}
            </button>
            {reminderTestStatus === 'ok' && <span style={{ color: '#16a34a', fontSize: 12, fontWeight: 600 }}>✓ Sent — check your inbox.</span>}
            {reminderTestStatus === 'none' && <span style={{ color: 'var(--color-text-tertiary)', fontSize: 12, fontWeight: 600 }}>Ran successfully, but nothing's due tomorrow — no email sent.</span>}
            {reminderTestStatus === 'err' && <span style={{ color: '#b91c1c', fontSize: 12, fontWeight: 600 }}>Send failed.</span>}
          </div>

          <div className={styles.divider} />

          <div style={{ padding: '4px 2px 12px' }}>
            <div className={styles.cardRowLabel} style={{ marginBottom: 8 }}>
              Preview {reminderPreview?.projectedDate ? `(as it would arrive the day before ${reminderPreview.projectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})` : ''}
            </div>
            {reminderPreviewHtml ? (
              <iframe
                title="Payment reminder preview"
                srcDoc={reminderPreviewHtml}
                style={{
                  width: '100%', height: 540, border: '1px solid var(--border-ghost)',
                  borderRadius: 10, background: '#f8fafc',
                }}
              />
            ) : (
              <div style={{
                padding: 24, fontSize: 13, color: 'var(--color-text-tertiary)',
                border: '1px dashed var(--border-ghost)', borderRadius: 10, textAlign: 'center',
              }}>
                {reminderPreview === null
                  ? 'No projected card payments yet — once you have payment history on a card, the preview will show here.'
                  : 'Building preview…'}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* About */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>About</h3>
        <div className={styles.card}>
          <div className={styles.aboutGrid}>
            <div>
              <div className={styles.statLabel}>Application</div>
              <div className={styles.statValue}>Wealth Architect v1.0</div>
            </div>
            <div>
              <div className={styles.statLabel}>Data Provider</div>
              <div className={styles.statValue}>Tiller Money via Google Sheets</div>
            </div>
            <div>
              <div className={styles.statLabel}>Stack</div>
              <div className={styles.statValue}>Vite + React + Firebase</div>
            </div>
            <div>
              <div className={styles.statLabel}>Hosting</div>
              <div className={styles.statValue}>Vercel</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
