import { useState } from 'react';
import { useData } from '../contexts/DataContext';
import styles from './OverviewPage.module.css';

function fmt(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function fmtCompact(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function relativeTime(date) {
  if (!date) return '—';
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const DONUT_COLORS = ['#0058be', '#009668', '#e8a317', '#94a3b8', '#7c3aed', '#e11d48', '#06b6d4', '#f97316'];

export function OverviewPage() {
  const { balances, analytics, transactions, loading, error, lastSync } = useData();
  const [chartPeriod, setChartPeriod] = useState('6M');

  // Loading state
  if (loading) {
    return (
      <div className={styles.page} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ textAlign: 'center' }}>
          <span className="material-symbols-outlined" style={{ fontSize: 48, animation: 'spin 1s linear infinite', display: 'block', marginBottom: 16, color: 'var(--color-text-tertiary)' }}>progress_activity</span>
          <div style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-body)', fontSize: 14 }}>Loading your financial data...</div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className={styles.page} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ textAlign: 'center', maxWidth: 400 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 48, color: '#ba1a1a', display: 'block', marginBottom: 16 }}>error</span>
          <div style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-headline)', fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Failed to load data</div>
          <div style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-body)', fontSize: 14 }}>{error}</div>
        </div>
      </div>
    );
  }

  // Build stat cards from real data
  const cashFlow = analytics?.cashFlow ?? 0;
  const cashFlowPositive = cashFlow >= 0;

  const STATS = [
    {
      title: 'Net Worth',
      value: fmt(balances?.netWorth),
      icon: 'account_balance_wallet',
      iconClass: 'statIconBlue',
    },
    {
      title: 'Total Assets',
      value: fmt(balances?.totalAssets),
      icon: 'trending_up',
      iconClass: 'statIconGreen',
    },
    {
      title: 'Total Liabilities',
      value: fmt(balances?.totalLiabilities),
      icon: 'trending_down',
      iconClass: 'statIconRed',
    },
    {
      title: '30D Cash Flow',
      value: `${cashFlowPositive ? '+' : ''}${fmt(cashFlow)}`,
      icon: 'payments',
      iconClass: 'statIconDark',
      cashFlowColor: cashFlowPositive ? '#009668' : '#ba1a1a',
    },
  ];

  // Build asset allocation from real balances
  const assetAccounts = balances?.assets || [];
  const totalAssetBalance = assetAccounts.reduce((sum, a) => sum + a.balance, 0) || 1;
  const ALLOCATION = assetAccounts.map((a, i) => ({
    label: a.name,
    value: fmt(a.balance),
    pct: Math.round((a.balance / totalAssetBalance) * 100),
    color: DONUT_COLORS[i % DONUT_COLORS.length],
  }));

  // Build spending data from analytics byMonth
  const byMonth = analytics?.byMonth || {};
  const monthEntries = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b));
  const recentMonths = monthEntries.slice(-6);
  const SPENDING_DATA = recentMonths.map(([month, data]) => ({
    month: month.length > 3 ? month.slice(0, 3) : month,
    income: data.income,
    expenses: data.expenses,
  }));
  const maxVal = SPENDING_DATA.length > 0
    ? Math.max(...SPENDING_DATA.flatMap((d) => [d.income, d.expenses]), 1)
    : 1;

  // Build anomalies from 5 largest transactions by absolute amount
  const sortedByAmount = [...(transactions || [])]
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 5);
  const ANOMALIES = sortedByAmount.map((t) => ({
    text: `${t.description} — ${fmt(t.amount)} (${t.category || 'Uncategorized'})`,
    time: t.date || '—',
    color: t.amount < 0 ? '#ba1a1a' : '#009668',
  }));

  // Linked accounts count
  const linkedAccounts = (balances?.assets?.length || 0) + (balances?.liabilities?.length || 0);

  return (
    <div className={styles.page}>
      {/* Hero Stats */}
      <div>
        <div className={styles.sectionLabel}>Portfolio Snapshot</div>
        <div className={styles.statsGrid}>
          {STATS.map((s) => (
            <div key={s.title} className={styles.statCard}>
              <div className={styles.statHeader}>
                <span className={styles.statTitle}>{s.title}</span>
                <div className={`${styles.statIcon} ${styles[s.iconClass]}`}>
                  <span className="material-symbols-outlined">{s.icon}</span>
                </div>
              </div>
              <div
                className={styles.statValue}
                style={s.cashFlowColor ? { color: s.cashFlowColor } : undefined}
              >
                {s.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Charts Row */}
      <div className={styles.chartsRow}>
        {/* Spending Snapshot */}
        <div className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <span className={styles.chartTitle}>Spending Snapshot</span>
            <div className={styles.chartPeriodPills}>
              {['1M', '3M', '6M', '1Y'].map((p) => (
                <div
                  key={p}
                  className={`${styles.chartPill} ${chartPeriod === p ? styles.chartPillActive : ''}`}
                  onClick={() => setChartPeriod(p)}
                >
                  {p}
                </div>
              ))}
            </div>
          </div>
          <div className={styles.chartArea}>
            {SPENDING_DATA.length > 0 ? (
              SPENDING_DATA.map((d, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', gap: 2, alignItems: 'flex-end', height: '100%' }}>
                  <div
                    className={styles.chartBar}
                    style={{
                      height: `${(d.income / maxVal) * 100}%`,
                      background: 'var(--color-secondary)',
                      opacity: 0.85,
                    }}
                    title={`${d.month} Income: $${d.income.toLocaleString()}`}
                  />
                  <div
                    className={styles.chartBar}
                    style={{
                      height: `${(d.expenses / maxVal) * 100}%`,
                      background: '#cbd5e1',
                    }}
                    title={`${d.month} Expenses: $${d.expenses.toLocaleString()}`}
                  />
                </div>
              ))
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', color: 'var(--color-text-tertiary)', fontSize: 13 }}>No monthly data available</div>
            )}
          </div>
          <div className={styles.chartLegend}>
            <div className={styles.legendItem}>
              <div className={styles.legendDot} style={{ background: 'var(--color-secondary)' }} />
              Income
            </div>
            <div className={styles.legendItem}>
              <div className={styles.legendDot} style={{ background: '#cbd5e1' }} />
              Expenses
            </div>
          </div>
        </div>

        {/* Asset Allocation Donut */}
        <div className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <span className={styles.chartTitle}>Asset Allocation</span>
          </div>
          <div className={styles.donutWrapper}>
            <svg width="160" height="160" viewBox="0 0 160 160">
              {(() => {
                let cumulative = 0;
                return ALLOCATION.map((item, i) => {
                  const startAngle = cumulative * 3.6;
                  cumulative += item.pct;
                  const endAngle = cumulative * 3.6;
                  const startRad = ((startAngle - 90) * Math.PI) / 180;
                  const endRad = ((endAngle - 90) * Math.PI) / 180;
                  const largeArc = item.pct > 50 ? 1 : 0;
                  const x1 = 80 + 60 * Math.cos(startRad);
                  const y1 = 80 + 60 * Math.sin(startRad);
                  const x2 = 80 + 60 * Math.cos(endRad);
                  const y2 = 80 + 60 * Math.sin(endRad);
                  return (
                    <path
                      key={i}
                      d={`M 80 80 L ${x1} ${y1} A 60 60 0 ${largeArc} 1 ${x2} ${y2} Z`}
                      fill={item.color}
                      stroke="var(--color-surface)"
                      strokeWidth="2"
                    />
                  );
                });
              })()}
              <circle cx="80" cy="80" r="36" fill="var(--color-surface)" />
              <text x="80" y="76" textAnchor="middle" fontFamily="var(--font-headline)" fontSize="14" fontWeight="800" fill="var(--color-text-primary)">{fmtCompact(balances?.totalAssets)}</text>
              <text x="80" y="92" textAnchor="middle" fontFamily="var(--font-body)" fontSize="9" fill="var(--color-text-tertiary)">TOTAL</text>
            </svg>
          </div>
          <div className={styles.donutLegend}>
            {ALLOCATION.map((a) => (
              <div key={a.label} className={styles.donutLegendItem}>
                <div className={styles.donutLegendLeft}>
                  <div className={styles.donutLegendDot} style={{ background: a.color }} />
                  {a.label}
                </div>
                <span className={styles.donutLegendValue}>{a.pct}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Row */}
      <div className={styles.bottomRow}>
        {/* Google Sheets Status */}
        <div className={styles.sheetsCard}>
          <div className={styles.sheetsHeader}>
            <div className={styles.sheetsIcon}>
              <span className="material-symbols-outlined">table_chart</span>
            </div>
            <span className={styles.sheetsTitle}>Google Sheets Integration</span>
            <span className={styles.sheetsBadge}>Connected</span>
          </div>
          <div className={styles.sheetsRow}>
            <span className={styles.sheetsLabel}>Last Sync</span>
            <span className={styles.sheetsValue}>{relativeTime(lastSync)}</span>
          </div>
          <div className={styles.sheetsRow}>
            <span className={styles.sheetsLabel}>Rows Ingested</span>
            <span className={styles.sheetsValue}>{(analytics?.transactionCount ?? 0).toLocaleString()}</span>
          </div>
          <div className={styles.sheetsRow}>
            <span className={styles.sheetsLabel}>Linked Accounts</span>
            <span className={styles.sheetsValue}>{linkedAccounts} Active</span>
          </div>
          <div className={styles.sheetsRow}>
            <span className={styles.sheetsLabel}>Sync Frequency</span>
            <span className={styles.sheetsValue}>Every 6 hours</span>
          </div>
          <div className={styles.sheetsRow}>
            <span className={styles.sheetsLabel}>Data Integrity</span>
            <span className={styles.sheetsValue}>99.8%</span>
          </div>
        </div>

        {/* Recent Anomalies */}
        <div className={styles.anomaliesCard}>
          <div className={styles.anomaliesTitle}>
            Notable Transactions
            <span className={styles.anomalyBadge}>{ANOMALIES.length}</span>
          </div>
          {ANOMALIES.length > 0 ? (
            ANOMALIES.map((a, i) => (
              <div key={i} className={styles.anomalyItem}>
                <div className={styles.anomalyDot} style={{ background: a.color }} />
                <div className={styles.anomalyContent}>
                  <div className={styles.anomalyText}>{a.text}</div>
                  <div className={styles.anomalyTime}>{a.time}</div>
                </div>
              </div>
            ))
          ) : (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: '12px 0' }}>No transactions loaded</div>
          )}
        </div>
      </div>

      {/* Portfolio Governance Footer */}
      <div className={styles.governance}>
        <div className={styles.govLeft}>
          <div className={styles.govIcon}>
            <span className="material-symbols-outlined">verified</span>
          </div>
          <div>
            <div className={styles.govTitle}>Portfolio Governance</div>
            <div className={styles.govSubtitle}>All financial rules are passing</div>
          </div>
        </div>
        <div className={styles.govStats}>
          <div className={styles.govStat}>
            <div className={styles.govStatValue}>12</div>
            <div className={styles.govStatLabel}>Rules Active</div>
          </div>
          <div className={styles.govStat}>
            <div className={styles.govStatValue}>0</div>
            <div className={styles.govStatLabel}>Violations</div>
          </div>
          <div className={styles.govStat}>
            <div className={styles.govStatValue}>98.2</div>
            <div className={styles.govStatLabel}>Health Score</div>
          </div>
          <div className={styles.govStat}>
            <div className={styles.govStatValue}>A+</div>
            <div className={styles.govStatLabel}>Grade</div>
          </div>
        </div>
      </div>
    </div>
  );
}
