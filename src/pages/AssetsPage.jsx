import { useData } from '../contexts/DataContext';
import styles from './AssetsPage.module.css';

function fmt(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function AssetsPage() {
  const { balances, loading } = useData();

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loadingWrapper}>
          <div>
            <span className={`material-symbols-outlined ${styles.loadingIcon}`}>progress_activity</span>
            <div className={styles.loadingText}>Loading balance sheet...</div>
          </div>
        </div>
      </div>
    );
  }

  if (!balances) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyState}>
          <span className={`material-symbols-outlined ${styles.emptyIcon}`}>account_balance</span>
          <p>No balance data available. Connect your sheets to get started.</p>
        </div>
      </div>
    );
  }

  const assets = [...(balances.assets || [])].sort((a, b) => (b.balance || 0) - (a.balance || 0));
  const liabilities = [...(balances.liabilities || [])].sort((a, b) => (b.balance || 0) - (a.balance || 0));
  const netWorth = balances.netWorth ?? 0;
  const totalAssets = balances.totalAssets ?? 0;
  const totalLiabilities = balances.totalLiabilities ?? 0;

  const totalAbs = Math.abs(totalAssets) + Math.abs(totalLiabilities);
  const assetsPct = totalAbs > 0 ? (Math.abs(totalAssets) / totalAbs) * 100 : 50;
  const liabilitiesPct = totalAbs > 0 ? (Math.abs(totalLiabilities) / totalAbs) * 100 : 50;

  const debtToAsset = totalAssets > 0 ? Math.abs(totalLiabilities) / totalAssets : 0;
  const totalAccounts = assets.length + liabilities.length;

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className={styles.page}>
      {/* Page Header */}
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Assets & Liabilities</h1>
          <div className={styles.pageSubtitle}>{today}</div>
        </div>
      </div>

      {/* Net Worth Hero */}
      <div className={styles.heroCard}>
        <div className={styles.heroLabel}>Net Worth</div>
        <div className={styles.heroValue}>{fmt(netWorth)}</div>

        <div className={styles.heroColumns}>
          <div className={styles.heroStat}>
            <div className={styles.heroStatLabel}>Total Assets</div>
            <div className={`${styles.heroStatValue} ${styles.heroStatAssets}`}>{fmt(totalAssets)}</div>
          </div>
          <div className={styles.heroStat}>
            <div className={styles.heroStatLabel}>Total Liabilities</div>
            <div className={`${styles.heroStatValue} ${styles.heroStatLiabilities}`}>{fmt(totalLiabilities)}</div>
          </div>
        </div>

        <div className={styles.barWrapper}>
          <div className={styles.barTrack}>
            <div className={styles.barAssets} style={{ width: `${assetsPct}%` }} />
            <div className={styles.barLiabilities} style={{ width: `${liabilitiesPct}%` }} />
          </div>
          <div className={styles.barLegend}>
            <span>
              <span className={styles.barLegendDot} style={{ background: '#34d399' }} />
              Assets {assetsPct.toFixed(1)}%
            </span>
            <span>
              <span className={styles.barLegendDot} style={{ background: '#f87171' }} />
              Liabilities {liabilitiesPct.toFixed(1)}%
            </span>
          </div>
        </div>
      </div>

      {/* Assets & Liabilities Side by Side */}
      <div className={styles.columnsGrid}>
        {/* Assets Column */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#34d399' }}>trending_up</span>
              Assets
            </div>
            <div className={`${styles.sectionTotal} ${styles.balancePositive}`}>{fmt(totalAssets)}</div>
          </div>

          <div className={styles.tableCard}>
            <div className={styles.tableHeader}>
              <div className={styles.tableHeaderCell}>Account</div>
              <div className={styles.tableHeaderCell}>Updated</div>
              <div className={styles.tableHeaderCell}>Balance</div>
            </div>

            {assets.length === 0 && (
              <div className={styles.emptyState}>
                <p>No asset accounts found.</p>
              </div>
            )}

            {assets.map((item, i) => (
              <div className={styles.tableRow} key={`asset-${i}`}>
                <div>
                  <div className={styles.accountName}>{item.name}</div>
                </div>
                <div className={styles.updated}>{item.updated}</div>
                <div className={`${styles.balance} ${(item.balance || 0) >= 0 ? styles.balancePositive : styles.balanceNegative}`}>
                  {fmt(item.balance)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Liabilities Column */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#f87171' }}>trending_down</span>
              Liabilities
            </div>
            <div className={`${styles.sectionTotal} ${styles.balanceNegative}`}>{fmt(totalLiabilities)}</div>
          </div>

          <div className={styles.tableCard}>
            <div className={styles.tableHeader}>
              <div className={styles.tableHeaderCell}>Account</div>
              <div className={styles.tableHeaderCell}>Updated</div>
              <div className={styles.tableHeaderCell}>Balance</div>
            </div>

            {liabilities.length === 0 && (
              <div className={styles.emptyState}>
                <p>No liability accounts found.</p>
              </div>
            )}

            {liabilities.map((item, i) => (
              <div className={styles.tableRow} key={`liability-${i}`}>
                <div>
                  <div className={styles.accountName}>{item.name}</div>
                </div>
                <div className={styles.updated}>{item.updated}</div>
                <div className={`${styles.balance} ${styles.balanceNegative}`}>
                  {fmt(item.balance)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Summary Footer */}
      <div className={styles.summaryFooter}>
        <div className={styles.summaryItem}>
          <div className={styles.summaryLabel}>Debt-to-Asset Ratio</div>
          <div className={styles.summaryValue}>{(debtToAsset * 100).toFixed(1)}%</div>
        </div>
        <div className={styles.summaryItem}>
          <div className={styles.summaryLabel}>Total Accounts</div>
          <div className={styles.summaryValue}>{totalAccounts}</div>
        </div>
        <div className={styles.summaryItem}>
          <div className={styles.summaryLabel}>Net Worth</div>
          <div className={styles.summaryValue}>{fmt(netWorth)}</div>
        </div>
      </div>
    </div>
  );
}

export default AssetsPage;
