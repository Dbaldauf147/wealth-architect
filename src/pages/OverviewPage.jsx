import { useState } from 'react';
import styles from './OverviewPage.module.css';

const STATS = [
  {
    title: 'Net Worth',
    value: '$487,230',
    change: '+3.2%',
    up: true,
    period: 'vs last month',
    icon: 'account_balance_wallet',
    iconClass: 'statIconBlue',
  },
  {
    title: 'Total Assets',
    value: '$612,450',
    change: '+1.8%',
    up: true,
    period: 'vs last month',
    icon: 'trending_up',
    iconClass: 'statIconGreen',
  },
  {
    title: 'Total Liabilities',
    value: '$125,220',
    change: '-2.1%',
    up: false,
    period: 'vs last month',
    icon: 'trending_down',
    iconClass: 'statIconRed',
  },
  {
    title: '30D Cash Flow',
    value: '+$4,830',
    change: '+12.4%',
    up: true,
    period: 'vs prior 30d',
    icon: 'payments',
    iconClass: 'statIconDark',
  },
];

const SPENDING_DATA = [
  { month: 'Oct', income: 8200, expenses: 5400 },
  { month: 'Nov', income: 8200, expenses: 6100 },
  { month: 'Dec', income: 9800, expenses: 7200 },
  { month: 'Jan', income: 8200, expenses: 5800 },
  { month: 'Feb', income: 8200, expenses: 4900 },
  { month: 'Mar', income: 8700, expenses: 5200 },
];

const ALLOCATION = [
  { label: 'Equities', value: '$245,800', pct: 40, color: '#0058be' },
  { label: 'Real Estate', value: '$184,200', pct: 30, color: '#009668' },
  { label: 'Fixed Income', value: '$98,320', pct: 16, color: '#e8a317' },
  { label: 'Cash & Equiv.', value: '$61,240', pct: 10, color: '#94a3b8' },
  { label: 'Crypto', value: '$22,890', pct: 4, color: '#7c3aed' },
];

const ANOMALIES = [
  { text: 'Unusual charge of $342.00 at Electronics Store — 2.4x avg spend', time: '2 hours ago', color: '#ba1a1a' },
  { text: 'Subscription price increase: Spotify $10.99 → $12.99', time: '5 hours ago', color: '#e8a317' },
  { text: 'Duplicate charge detected: $28.50 at Whole Foods Market', time: '1 day ago', color: '#ba1a1a' },
  { text: 'Credit utilization approaching 30% on Amex Gold', time: '2 days ago', color: '#e8a317' },
];

export function OverviewPage() {
  const [chartPeriod, setChartPeriod] = useState('6M');
  const maxVal = Math.max(...SPENDING_DATA.flatMap((d) => [d.income, d.expenses]));

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
              <div className={styles.statValue}>{s.value}</div>
              <span className={`${styles.statChange} ${s.up ? styles.statChangeUp : styles.statChangeDown}`}>
                <span className="material-symbols-outlined">{s.up ? 'arrow_upward' : 'arrow_downward'}</span>
                {s.change}
              </span>
              <span className={styles.statPeriod}>{s.period}</span>
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
            {SPENDING_DATA.map((d, i) => (
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
            ))}
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
              <text x="80" y="76" textAnchor="middle" fontFamily="var(--font-headline)" fontSize="14" fontWeight="800" fill="var(--color-text-primary)">$612K</text>
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
            <span className={styles.sheetsValue}>Today, 9:42 AM</span>
          </div>
          <div className={styles.sheetsRow}>
            <span className={styles.sheetsLabel}>Rows Synced</span>
            <span className={styles.sheetsValue}>2,847</span>
          </div>
          <div className={styles.sheetsRow}>
            <span className={styles.sheetsLabel}>Linked Accounts</span>
            <span className={styles.sheetsValue}>4 Active</span>
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
            Recent Anomalies
            <span className={styles.anomalyBadge}>{ANOMALIES.length}</span>
          </div>
          {ANOMALIES.map((a, i) => (
            <div key={i} className={styles.anomalyItem}>
              <div className={styles.anomalyDot} style={{ background: a.color }} />
              <div className={styles.anomalyContent}>
                <div className={styles.anomalyText}>{a.text}</div>
                <div className={styles.anomalyTime}>{a.time}</div>
              </div>
            </div>
          ))}
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
