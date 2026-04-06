import { useData } from '../contexts/DataContext';
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

export function SettingsPage() {
  const { loading, error, lastSync, refresh, analytics, balances } = useData();

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
