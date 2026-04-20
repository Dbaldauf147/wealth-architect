import { useMemo, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { buildWeeklySummary, lastCompletedWeek } from '../lib/weeklySummary';
import { renderWeeklyEmailHtml } from '../lib/renderWeeklyEmail';
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
  const { loading, error, lastSync, refresh, analytics, balances, transactions } = useData();
  const [emailPrefs, setEmailPrefs] = useState(loadEmailPrefs);
  const [sendStatus, setSendStatus] = useState(null); // null | 'sending' | 'ok' | 'err'

  const previewHtml = useMemo(() => {
    const { start, end } = lastCompletedWeek();
    const summary = buildWeeklySummary({ transactions: transactions || [], start, end });
    return renderWeeklyEmailHtml(summary);
  }, [transactions]);

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
